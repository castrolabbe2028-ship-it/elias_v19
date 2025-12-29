  
"use client";

import React, { useEffect, useMemo, useState, useRef, useCallback, Suspense, lazy } from 'react';
import { useGradesSQL } from '@/hooks/useGradesSQL';
import { useAttendanceSQL } from '@/hooks/useAttendanceSQL';
import { useStatsAPI, useStatsLegacyFormat } from '@/hooks/useStatsAPI';
import { readKPIsSnapshot, writeKPIsSnapshot } from '@/lib/kpis-snapshot';
import { readStatsSnapshot, writeStatsSnapshot } from '@/lib/stats-snapshot';
import { useLanguage } from '@/contexts/language-context';
import { useAuth } from '@/contexts/auth-context';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { isFirebaseEnabled, getCurrentProvider } from '@/lib/sql-config';
import { getAllAvailableSubjects } from '@/lib/subjects-colors';
import { Progress } from '@/components/ui/progress';
import { BarChart3, ClipboardList, FileCheck2, Users, Activity, TrendingUp, Clock, Download, ChevronDown, GraduationCap, UserCheck, CheckCircle2, ZoomIn, ZoomOut, Layers, RefreshCw } from 'lucide-react';
// Nota: html2canvas y jspdf se importan dinámicamente dentro de exportPDF para evitar errores en SSR
import TrendChart from '@/components/charts/TrendChart';
import { toPercentFromConfigured, isApprovedByPercent, getGradingConfig } from '@/lib/grading';
import { LocalStorageManager } from '@/lib/education-utils';

// Componentes modulares para mejorar el tiempo de carga inicial
import { 
  KPICardsGrid, 
  AttendancePercentCard,
  KPICardsSkeleton,
  InsightsSkeleton,
  CourseComparisonSkeleton,
  PeriodChartSkeleton,
  AttendanceChartSkeleton,
  AttendancePercentSkeleton
} from '@/components/statistics';

// Importación diferida (lazy) de componentes pesados para reducir bundle inicial
const LazyInsightsCard = lazy(() => import('@/components/statistics/InsightsCard'));
const LazyAttendanceTrendCard = lazy(() => import('@/components/statistics/AttendanceTrendCard'));

// OPTIMIZACIÓN: Timeout máximo para el loader (reducido para mejor UX)
const MAX_LOADER_TIMEOUT = 800; // 800ms máximo para mostrar el loader
const LOADER_INTERVAL_SPEED = 30; // Velocidad de incremento del progreso

// Cache global para datos de localStorage
const dataCache = new Map<string, { data: any; timestamp: number; ttl: number }>();
const CACHE_TTL = 60000; // 60 segundos - aumentado para mejor rendimiento

// Cache para JSON.parse de localStorage (evita parsear repetidamente)
const localStorageJsonCache = new Map<string, { data: any; timestamp: number }>();
const LS_CACHE_TTL = 30000; // 30 segundos

// Función optimizada para leer y parsear localStorage con cache
const getCachedLocalStorageJson = (key: string, defaultValue: any = []): any => {
  const now = Date.now();
  const cached = localStorageJsonCache.get(key);
  if (cached && (now - cached.timestamp) < LS_CACHE_TTL) {
    return cached.data;
  }
  try {
    const raw = localStorage.getItem(key);
    const data = raw ? JSON.parse(raw) : defaultValue;
    localStorageJsonCache.set(key, { data, timestamp: now });
    return data;
  } catch {
    return defaultValue;
  }
};

// Cache para funciones de parsing de fechas
const dateParseCache = new Map<string, number>();

// Función de cache optimizada
const getCachedData = (key: string, fetcher: () => any, ttl: number = CACHE_TTL) => {
  const now = Date.now();
  const cached = dataCache.get(key);
  
  if (cached && (now - cached.timestamp) < cached.ttl) {
    return cached.data;
  }
  
  const data = fetcher();
  dataCache.set(key, { data, timestamp: now, ttl });
  return data;
};

// Función optimizada de parsing de fechas con cache
const parseTimestampOptimized = (value: any): number => {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const strValue = String(value);
  if (dateParseCache.has(strValue)) {
    return dateParseCache.get(strValue)!;
  }
  let result = 0;
  // dd-mm-yyyy
  if (/^\d{2}-\d{2}-\d{4}$/.test(strValue)) {
    const [dd, mm, yyyy] = strValue.split('-').map(Number);
    result = new Date(yyyy, (mm || 1) - 1, dd || 1, 0, 0, 0, 0).getTime();
  }
  // dd/mm/yyyy
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(strValue)) {
    const [dd, mm, yyyy] = strValue.split('/').map(Number);
    result = new Date(yyyy, (mm || 1) - 1, dd || 1, 0, 0, 0, 0).getTime();
  }
  // yyyy-mm-dd
  else if (/^\d{4}-\d{2}-\d{2}$/.test(strValue)) {
    result = new Date(strValue + 'T00:00:00').getTime();
  }
  // Otros formatos
  else {
    const parsed = Date.parse(strValue);
    result = Number.isNaN(parsed) ? 0 : parsed;
  }
  if (result && !isNaN(result)) {
    dateParseCache.set(strValue, result);
  }
  return result;
};

// ===================== OPTIMIZACIONES E ÍNDICES EN MEMORIA =====================
// Cache por año para asistencia indexada por día (reduce recorridos al cambiar filtros)
type NormalizedAttendance = {
  ts: number;
  dayKey: string; // YYYY-MM-DD en zona local
  courseId: string;
  sectionId: string;
  presentIds: string[]; // ids en minúsculas
  presentCount: number;
  totalCount?: number;
  status?: 'present' | 'absent';
  raw: any;
};

const attendanceYearCache = new Map<number, { dayIndex: Map<string, NormalizedAttendance[]>; sourceCount: number; builtAt: number }>();
const courseLevelMapCache = new Map<number, Record<string, string>>();
const studentLevelMapCache = new Map<number, Record<string, Level>>();
const allStudentsCache = new Map<number, any[]>();

// Cache por año para calificaciones indexadas por mes
type NormalizedGrade = {
  ts: number;
  monthKey: string; // YYYY-MM
  courseId: string;
  sectionId: string;
  score: number; // 0-100
  raw: any;
};
const gradesYearCache = new Map<number, { monthIndex: Map<string, NormalizedGrade[]>; sourceCount: number; builtAt: number }>();

const keyOfDayLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDayKeyLocal = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime();
};

function buildCourseLevelMap(year: number): Record<string, string> {
  const cacheKey = `courseLevelMap:${year}`;
  const cached = getCachedData(cacheKey, () => null, CACHE_TTL);
  if (cached && typeof cached === 'object') return cached as Record<string, string>;
  const map: Record<string, string> = {};

  const inferLevel = (c: any) => {
    if (c?.level) return String(c.level);
    const s = (c?.name || c?.id || '').toLowerCase();
    if (s.includes('media') || s.includes('medio') || s.includes('secundaria') || s.includes('high')) return 'media';
    if (s.includes('basica') || s.includes('basico') || s.includes('primaria') || s.includes('basic')) return 'basica';
    return '';
  };

  try {
    const yearCourses = LocalStorageManager.getCoursesForYear?.(year) || [];
    if (Array.isArray(yearCourses)) {
      yearCourses.forEach((c: any) => { if (c?.id) { const l = inferLevel(c); if (l) map[String(c.id)] = l; } });
    }
    if (Object.keys(map).length === 0) {
      const arrYear = JSON.parse(localStorage.getItem(`smart-student-courses-${year}`) || '[]');
      if (Array.isArray(arrYear)) arrYear.forEach((c: any) => { if (c?.id) { const l = inferLevel(c); if (l) map[String(c.id)] = l; } });
    }
    if (Object.keys(map).length === 0) {
      const legacy = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      if (Array.isArray(legacy)) legacy.forEach((c: any) => { if (c?.id) { const l = inferLevel(c); if (l) map[String(c.id)] = l; } });
    }
  } catch { /* ignore */ }
  dataCache.set(cacheKey, { data: map, timestamp: Date.now(), ttl: CACHE_TTL });
  return map;
}

function buildAllStudents(year: number): any[] {
  const cacheKey = `allStudents:${year}`;
  const cached = getCachedData(cacheKey, () => null, CACHE_TTL);
  if (Array.isArray(cached)) return cached as any[];
  let allStudents: any[] = [];
  try {
    allStudents = LocalStorageManager.getStudentsForYear?.(year) || [];
    if (!Array.isArray(allStudents) || allStudents.length === 0) {
      const legacy = JSON.parse(localStorage.getItem(`smart-student-students-${year}`) || '[]');
      if (Array.isArray(legacy)) allStudents = legacy;
    }
    if (!Array.isArray(allStudents) || allStudents.length === 0) {
      const usersGlobal = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      if (Array.isArray(usersGlobal)) allStudents = usersGlobal.filter((u: any) => u?.role === 'student');
    }
  } catch { /* ignore */ }
  dataCache.set(cacheKey, { data: allStudents, timestamp: Date.now(), ttl: CACHE_TTL });
  return allStudents;
}

function buildStudentLevelMap(year: number, courseLevelMap: Record<string, string>): Record<string, Level> {
  const cacheKey = `studentLevelMap:${year}`;
  const cached = getCachedData(cacheKey, () => null, CACHE_TTL);
  if (cached && typeof cached === 'object') return cached as Record<string, Level>;
  const map: Record<string, Level> = {};
  const allStudents = buildAllStudents(year);
  try {
    allStudents.forEach(st => {
      const cid = String((st as any).courseId || '');
      const lvl: any = (st as any).level || courseLevelMap[cid];
      if (lvl === 'basica' || lvl === 'media') {
        const ids: string[] = [];
        if ((st as any).id) ids.push(String((st as any).id));
        if ((st as any).studentId) ids.push(String((st as any).studentId));
        if ((st as any).username) ids.push(String((st as any).username));
        if ((st as any).rut) ids.push(String((st as any).rut));
        ids.forEach(k => { if (k) map[k.toLowerCase()] = lvl; });
      }
    });
  } catch { /* ignore */ }
  dataCache.set(cacheKey, { data: map, timestamp: Date.now(), ttl: CACHE_TTL });
  return map;
}
function normalizeAttendanceRecord(r: any): NormalizedAttendance | null {
  const ts = parseTimestampOptimized(r?.timestamp || r?.date || r?.when || r?.createdAt || r?.updatedAt);
  if (!ts) return null;
  const d = new Date(ts);
  const dayKey = keyOfDayLocal(d);
  const cs = r.course || r.courseSectionId;
  const courseId = String(r.courseId || (typeof cs === 'string' ? cs.split('-').slice(0, -1).join('-') : ''));
  const sectionId = String(r.sectionId || (typeof cs === 'string' ? cs.split('-').slice(-1)[0] : ''));
  let presentIds: string[] = [];
  let presentCount = 0;
  let totalCount: number | undefined = undefined;
  if (Array.isArray(r.presentStudents) && r.presentStudents.length) {
    const set = new Set<string>();
    r.presentStudents.forEach((ps: any) => {
      const pid = String(ps?.studentId || ps?.id || ps?.username || ps).toLowerCase();
      if (pid) set.add(pid);
    });
    presentIds = Array.from(set);
    presentCount = r.presentCount && typeof r.presentCount === 'number' ? Math.max(r.presentCount, presentIds.length) : presentIds.length;
  } else if (r.status === 'present' || r.present === true) {
    const pid = String(r.studentId || r.studentUsername || r.username || r.user || '').toLowerCase();
    if (pid) presentIds = [pid];
    presentCount = 1;
  }
  if (typeof (r as any).totalCount === 'number') totalCount = Number((r as any).totalCount);
  const status = (r as any).status === 'absent' ? 'absent' : (presentCount > 0 ? 'present' : undefined);
  return { ts, dayKey, courseId, sectionId, presentIds, presentCount, totalCount, status, raw: r };
}

function buildAttendanceYearIndex(year: number, source: any[]): { dayIndex: Map<string, NormalizedAttendance[]>; sourceCount: number } {
  const cached = attendanceYearCache.get(year);
  const sourceCount = Array.isArray(source) ? source.length : 0;
  if (cached && cached.sourceCount === sourceCount) {
    return { dayIndex: cached.dayIndex, sourceCount: cached.sourceCount };
  }
  const map = new Map<string, NormalizedAttendance[]>();
  try {
    (source || []).forEach((r: any) => {
      const n = normalizeAttendanceRecord(r);
      if (!n) return;
      if (!map.has(n.dayKey)) map.set(n.dayKey, []);
      map.get(n.dayKey)!.push(n);
    });
  } catch { /* ignore */ }
  attendanceYearCache.set(year, { dayIndex: map, sourceCount, builtAt: Date.now() });
  return { dayIndex: map, sourceCount };
}

function normalizeGradeRecord(g: any): NormalizedGrade | null {
  // timestamp
  const v = g?.gradedAt ?? g?.createdAt ?? g?.timestamp ?? g?.when ?? g?.date;
  let ts = 0;
  if (typeof v === 'number') ts = v; else if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t)) ts = t; }
  if (!ts) return null;
  const d = new Date(ts);
  const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0');
  const monthKey = `${y}-${m}`;
  // ids
  const courseId = String(g?.courseId || g?.course || '');
  const sectionId = String(g?.sectionId || g?.section || '');
  // score → 0-100
  const rawScore = typeof g?.score === 'number' ? g.score : (typeof g?.grade === 'number' ? toPercentFromConfigured(g.grade) : undefined);
  if (typeof rawScore !== 'number' || !isFinite(rawScore)) return null;
  const score = Math.max(0, Math.min(100, rawScore));
  return { ts, monthKey, courseId, sectionId, score, raw: g };
}

function buildGradesYearIndex(year: number, source: any[]): { monthIndex: Map<string, NormalizedGrade[]>; sourceCount: number } {
  const cached = gradesYearCache.get(year);
  const sourceCount = Array.isArray(source) ? source.length : 0;
  if (cached && cached.sourceCount === sourceCount) {
    return { monthIndex: cached.monthIndex, sourceCount: cached.sourceCount };
  }
  const map = new Map<string, NormalizedGrade[]>();
  try {
    (source || []).forEach((r: any) => {
      const n = normalizeGradeRecord(r);
      if (!n) return;
      const d = new Date(n.ts);
      if (d.getFullYear() !== year) return;
      if (!map.has(n.monthKey)) map.set(n.monthKey, []);
      map.get(n.monthKey)!.push(n);
    });
  } catch { /* ignore */ }
  gradesYearCache.set(year, { monthIndex: map, sourceCount, builtAt: Date.now() });
  return { monthIndex: map, sourceCount };
}

// Hook de debounce optimizado (local a esta página)
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

// --- Utilidad centralizada para obtener rango de un semestre según configuración Calendario ---
function __getSemesterRange(year: number, sem: 'S1'|'S2'): { start?: number; end?: number } {
  const keys = [
    `smart-student-semesters-${year}`, // clave anual nueva
    'smart-student-semesters',         // clave global antigua
    `admin-calendar-${year}`,          // posible inclusión dentro del calendario
    'admin-calendar'
  ];
  const parseDate = (s?: string): number | undefined => {
    if (!s) return undefined;
    // dd-mm-yyyy
    if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
      const [dd, mm, yyyy] = s.split('-').map(Number);
      const d = new Date(yyyy, (mm||1)-1, dd||1); if (!isNaN(d.getTime())) return d.getTime();
    }
    // yyyy-mm-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [yyyy, mm, dd] = s.split('-').map(Number);
      const d = new Date(yyyy, (mm||1)-1, dd||1); if (!isNaN(d.getTime())) return d.getTime();
    }
    const t = Date.parse(s); return isNaN(t) ? undefined : t;
  };
  for (const k of keys) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const cfg = JSON.parse(raw);
      // Formato directo { first:{start,end}, second:{start,end} }
      if (cfg?.first || cfg?.second) {
        const node = sem === 'S1' ? cfg.first : cfg.second;
        if (node) {
          const start = parseDate(node.start || node.inicio || node.from);
          const end = parseDate(node.end || node.fin || node.to);
          if (start && end) {
            // Si las fechas son de un año diferente al solicitado, ajustar al año correcto
            const startDate = new Date(start);
            const endDate = new Date(end);
            if (startDate.getFullYear() !== year || endDate.getFullYear() !== year) {
              startDate.setFullYear(year);
              endDate.setFullYear(year);
              const adjustedStart = startDate.getTime();
              const adjustedEnd = endDate.getTime();
              if (typeof window !== 'undefined') {
              }
              return adjustedStart <= adjustedEnd ? { start: adjustedStart, end: adjustedEnd } : { start: adjustedEnd, end: adjustedStart };
            }
            if (typeof window !== 'undefined') {
            }
            return start <= end ? { start, end } : { start: end, end: start };
          }
        }
      }
      // Formato anidado { semesters:{ first:{...}, second:{...} } }
      if (cfg?.semesters) {
        const node = sem === 'S1' ? cfg.semesters.first : cfg.semesters.second;
        if (node) {
          const start = parseDate(node.start || node.inicio || node.from);
          const end = parseDate(node.end || node.fin || node.to);
          if (start && end) {
            // Si las fechas son de un año diferente al solicitado, ajustar al año correcto
            const startDate = new Date(start);
            const endDate = new Date(end);
            if (startDate.getFullYear() !== year || endDate.getFullYear() !== year) {
              startDate.setFullYear(year);
              endDate.setFullYear(year);
              const adjustedStart = startDate.getTime();
              const adjustedEnd = endDate.getTime();
              if (typeof window !== 'undefined') {
              }
              return adjustedStart <= adjustedEnd ? { start: adjustedStart, end: adjustedEnd } : { start: adjustedEnd, end: adjustedStart };
            }
            if (typeof window !== 'undefined') {
            }
            return start <= end ? { start, end } : { start: end, end: start };
          }
        }
      }
    } catch { /* ignore */ }
  }
  
  // Fallback: si no hay configuración, usar rangos estándar Chile
  // S1: Marzo 1 - Junio 30
  // S2: Julio 1 - Diciembre 31
  const fallbackStart = sem === 'S1' 
    ? new Date(year, 2, 1).getTime()   // 1 de Marzo
    : new Date(year, 6, 1).getTime();  // 1 de Julio
  const fallbackEnd = sem === 'S1'
    ? new Date(year, 5, 30, 23, 59, 59, 999).getTime()  // 30 de Junio
    : new Date(year, 11, 31, 23, 59, 59, 999).getTime(); // 31 de Diciembre
  
  if (typeof window !== 'undefined') {
  }
  
  return { start: fallbackStart, end: fallbackEnd };
}

// Subcomponentes locales para "Notas por Fecha": navegación por año y render en porcentaje
function YearNavigator({ year, onChange, minYear, maxYear }: { year: number; onChange: (y: number) => void; minYear: number; maxYear: number }) {
  const { translate } = useLanguage();
  const t = (key: string, fallback?: string) => {
    const v = translate(key);
    return v === key ? (fallback ?? key) : v;
  };
  const canPrev = year > minYear;
  const canNext = year < maxYear;
  return (
    <div className="inline-flex items-center gap-2 text-xs md:text-sm">
      <button className="px-2 py-1 border rounded hover:bg-muted/50 disabled:opacity-50" onClick={() => canPrev && onChange(Math.max(minYear, year - 1))} disabled={!canPrev} aria-label={t('prevYear','Año anterior')} title={t('prevYear','Año anterior')}>«</button>
      <span className="min-w-[4ch] text-center font-medium">{year}</span>
      <button className="px-2 py-1 border rounded hover:bg-muted/50 disabled:opacity-50" onClick={() => canNext && onChange(Math.min(maxYear, year + 1))} disabled={!canNext} aria-label={t('nextYear','Año siguiente')} title={t('nextYear','Año siguiente')}>»</button>
    </div>
  );
}

function GradesOverTimeChart({ monthlyPctByKey, semester, comparisonType, displayYear, onYearChange, filters, zoomY, sqlGrades, isSQLConnected, sqlAttendance, isAttendanceSQLConnected }: { monthlyPctByKey: Record<string, number>; semester?: Exclude<Semester,'all'>; comparisonType?: 'notas' | 'asistencia'; displayYear?: number; onYearChange?: (year: number) => void; filters?: any; zoomY?: boolean; sqlGrades?: Record<number, any[]>; isSQLConnected?: boolean; sqlAttendance?: Record<number, any[]>; isAttendanceSQLConnected?: boolean }) {
  const { translate, language } = useLanguage();
  const t = (key: string, fallback?: string) => {
    const v = translate(key);
    return v === key ? (fallback ?? key) : v;
  };
  const currentYear = new Date().getFullYear();
  const minYear = currentYear - 2; // 2023
  const maxYear = currentYear - 1; // 2024 (solo años anteriores al actual)
  const [year, setYear] = useState<number>(displayYear || (currentYear - 1));
  const [visibleSeries, setVisibleSeries] = useState<Set<number>>(new Set([0, 1])); // Básica y Media
  const [localAttendanceData, setLocalAttendanceData] = useState<any[]>([]);
  
  // Sincronizar estado interno con prop displayYear
  useEffect(() => {
    if (displayYear && displayYear !== year) {
      setYear(displayYear);
    }
  }, [displayYear, year]);
  
  // 🔥 Cargar datos de asistencia directamente desde Firebase cuando no hay datos SQL
  useEffect(() => {
    if (comparisonType !== 'asistencia') return;
    
    // Si ya tenemos datos SQL, no necesitamos cargar localmente
    if (isAttendanceSQLConnected && sqlAttendance && Array.isArray(sqlAttendance[year]) && sqlAttendance[year].length > 0) {
      console.log(`📊 [GradesOverTimeChart] Usando datos SQL para año ${year}:`, sqlAttendance[year].length, 'registros');
      return;
    }
    
    // Intentar cargar desde Firebase directamente
    const loadFromFirebase = async () => {
      try {
        const { isFirebaseEnabled } = await import('@/lib/sql-config');
        if (!isFirebaseEnabled()) return;
        
        const { firestoreDB } = await import('@/lib/firestore-database');
        console.log(`🔥 [GradesOverTimeChart] Cargando asistencia de Firebase para año ${year}...`);
        const data = await firestoreDB.getAttendanceByYear(year);
        console.log(`✅ [GradesOverTimeChart] Datos de Firebase para año ${year}:`, data.length, 'registros');
        if (Array.isArray(data) && data.length > 0) {
          setLocalAttendanceData(data);
        }
      } catch (e) {
        console.warn('⚠️ [GradesOverTimeChart] Error cargando desde Firebase:', e);
      }
    };
    
    loadFromFirebase();
  }, [comparisonType, year, isAttendanceSQLConnected, sqlAttendance]);
  
  // Usar zoomY desde props en lugar de estado local
  const zoomYValue = zoomY ?? true; // Valor por defecto true si no se pasa
  const labelsES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const labelsEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const colors = ['#3B82F6', '#F59E0B']; // Azul para Básica, Naranja para Media
  const setYearClamped = (y:number) => {
    const newYear = Math.max(minYear, Math.min(maxYear, y));
    setYear(newYear);
    onYearChange?.(newYear);
  };
  const getCalendarMonthRange = (): { start: number; end: number } => {
    // Para asistencia: con zoom => últimos ~90 días del año anterior (3 meses);
    // sin zoom => rango fijo Mar (1) a Dic (15) del año seleccionado
    if (comparisonType === 'asistencia') {
      // Si el usuario fuerza semestre, respetarlo
      if (semester) {
        // Requisito: 1er Semestre = Marzo(2) a Junio(5); 2do Semestre = Julio(6) a Diciembre(11)
        const start = semester === 'S1' ? 2 : 6; // 0-based
        const end = semester === 'S1' ? 5 : 11;  // 0-based
        return { start, end };
      }
      if (zoomYValue) {
        // Últimos 90 días equivalentes del año anterior: tomar los 3 meses completos
        const currentMonth = new Date().getMonth(); // 0-11
        const endMonth = Math.max(0, currentMonth - 1); // mes anterior al actual
        const startMonth = Math.max(0, endMonth - 2);   // 3 meses hacia atrás
        return { start: startMonth, end: endMonth };
      }
      // Zoom desactivado: Mar..Dic
      return { start: 2, end: 11 };
    }
    
    // Para calificaciones: cuando el zoom está activado y no hay semestre, mostrar últimos ~90 días
    if (zoomYValue && !semester) {
      // Tomamos el mes de "hoy" y proyectamos 3 meses al año seleccionado (últimos ~90 días)
      // Cierre: mes anterior al actual. Manejar borde de año para que en ene/feb se use Oct–Dic del año seleccionado.
      const todayMonth = new Date().getMonth(); // 0-11
      let end = (todayMonth - 1 + 12) % 12; // mes anterior a hoy, con wrap
      let start: number;
      if (end <= 1) {
        // Si caemos en ene(0)/feb(1), forzar último trimestre del año seleccionado: Oct(9)–Dic(11)
        start = 9; end = 11;
      } else {
        start = Math.max(0, end - 2);
      }
      return { start, end };
    }

    // Para calificaciones: usar configuración de semestres del Calendario si existe
    try {
      if (semester) {
        const yearRef = year; // tomar año actual del selector interno
        const rng = __getSemesterRange(yearRef, semester);
        if (rng.start && rng.end) {
          const sM = new Date(rng.start).getMonth();
          const eM = new Date(rng.end).getMonth();
          return { start: Math.min(sM, eM), end: Math.max(sM, eM) };
        }
      } else {
        // Rango global si hay configuración anual (tomar min y max de ambos semestres)
        const s1 = __getSemesterRange(year, 'S1');
        const s2 = __getSemesterRange(year, 'S2');
        const months:number[] = [];
        if (s1.start) months.push(new Date(s1.start).getMonth()+1);
        if (s1.end) months.push(new Date(s1.end).getMonth()+1);
        if (s2.start) months.push(new Date(s2.start).getMonth()+1);
        if (s2.end) months.push(new Date(s2.end).getMonth()+1);
        if (months.length) return { start: Math.min(...months)-1, end: Math.max(...months)-1 };
      }
    } catch {}
  // Fallback sin calendario: S1=Mar-Jun, S2=Jul-Dic
  if (semester === 'S1') return { start:2, end:5 };
    if (semester === 'S2') return { start:6, end:11 };
    // Zoom OFF por defecto: período académico Mar (2) – Dic (11)
    return { start:2, end:11 };
  };
  // Obtener años con datos para el selector de años
  const yearsWithData = useMemo(() => {
    if (comparisonType === 'asistencia') {
      // Para asistencia, obtener años desde datos reales
      const yearSet = new Set<number>();
      for (let testYear = currentYear - 5; testYear < currentYear; testYear++) {
        // Preferir SQL si hay datos
        let hasData = false;
        if (isAttendanceSQLConnected && sqlAttendance && Array.isArray(sqlAttendance[testYear]) && sqlAttendance[testYear].length > 0) {
          hasData = true;
        } else if (localAttendanceData && Array.isArray(localAttendanceData) && localAttendanceData.length > 0 && testYear === year) {
          // Datos de Firebase cargados localmente para el año actual
          hasData = true;
        } else {
          // Fallback a LocalStorage
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            const localData = LocalStorageManager.getAttendanceForYear?.(testYear) || [];
            if (Array.isArray(localData) && localData.length > 0) hasData = true;
          } catch {
            try {
              const localData = JSON.parse(localStorage.getItem(`smart-student-attendance-${testYear}`) || '[]');
              if (Array.isArray(localData) && localData.length > 0) hasData = true;
            } catch {}
          }
        }
        if (hasData) {
          yearSet.add(testYear);
        }
      }
      return Array.from(yearSet).sort((a, b) => b - a);
    }
    
    // Para calificaciones, buscar años en el localStorage
    const yearSet = new Set<number>();
    try {
      for (let testYear = currentYear - 5; testYear < currentYear; testYear++) {
        const key = `smart-student-tasks-${testYear}`;
        const data = localStorage.getItem(key);
        if (data) {
          yearSet.add(testYear);
        }
      }
    } catch (e) {
      // Fallback silencioso
    }
    
    return Array.from(yearSet).sort((a, b) => b - a);
  }, [comparisonType, currentYear, sqlAttendance, isAttendanceSQLConnected, localAttendanceData, year]);

  // Obtener datos procesados para el gráfico
  const processedMonthlyData = useMemo(() => {
    if (comparisonType === 'asistencia') {
      // Obtener datos de asistencia para el año específico
      // Preferir SQL; luego datos locales de Firebase; fallback a LocalStorage
      let attendanceData: any[] = [];
      try {
        const hasRemoteAttendance = sqlAttendance && Array.isArray(sqlAttendance[year]) && sqlAttendance[year].length > 0;
        if (hasRemoteAttendance) {
          attendanceData = sqlAttendance![year] || [];
          console.log(`📊 [processedMonthlyData] Usando datos remotos para año ${year}:`, attendanceData.length);
        } else if (localAttendanceData && localAttendanceData.length > 0) {
          // Usar datos cargados localmente desde Firebase
          attendanceData = localAttendanceData;
          console.log(`🔥 [processedMonthlyData] Usando datos locales Firebase para año ${year}:`, attendanceData.length);
        } else {
          // Fallback a LocalStorage
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            attendanceData = LocalStorageManager.getAttendanceForYear?.(year) || [];
          } catch {
            attendanceData = JSON.parse(localStorage.getItem(`smart-student-attendance-${year}`) || '[]');
          }
          console.log(`💾 [processedMonthlyData] Usando datos LocalStorage para año ${year}:`, attendanceData.length);
        }
      } catch {
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          attendanceData = LocalStorageManager.getAttendanceForYear?.(year) || [];
        } catch {
          attendanceData = JSON.parse(localStorage.getItem(`smart-student-attendance-${year}`) || '[]');
        }
      }
      
      // Garantizar que sea un array
      if (!Array.isArray(attendanceData)) {
        attendanceData = [];
      }
      
      // Debug para verificar carga de datos
      if (typeof window !== 'undefined') {
      }
      
      // Filtrar por curso si hay filtros
      let filteredData = attendanceData || [];
      if (filters?.selectedCourse && filters.selectedCourse !== 'all') {
        filteredData = filteredData.filter((record: any) => 
          record.studentId && record.studentId.startsWith(filters.selectedCourse)
        );
      }
      
      // Función helper para inferir nivel desde el registro (igual que en el bloque de scopes más abajo)
      const inferLevel = (rec: any): 'basica' | 'media' | undefined => {
        // 1) Campo explícito de nivel
        const explicit = (rec?.level || rec?.courseLevel || '').toString().toLowerCase();
        if (/basica|basico|basic/.test(explicit)) return 'basica';
        if (/media|medio|secundaria|secondary|high/.test(explicit)) return 'media';
        
        // 2) Inferir desde el campo "course" (puede ser string con nombre o un objeto)
        const courseName = (typeof rec?.course === 'string' ? rec.course : (rec?.course?.name || rec?.courseName || '')).toString().toLowerCase();
        if (courseName) {
          if (/basica|basico|b[aá]sico/.test(courseName)) return 'basica';
          if (/media|medio|secundaria|secondary|high/.test(courseName)) return 'media';
        }
        
        // 3) Inferir desde courseId si es legible
        const courseId = (rec?.courseId || '').toString().toLowerCase();
        if (courseId.includes('media') || courseId.includes('medio') || courseId.includes('secundaria') || courseId.includes('high')) return 'media';
        if (courseId.includes('basica') || courseId.includes('basico') || courseId.includes('primaria') || courseId.includes('basic')) return 'basica';
        
        // 4) Heurística por studentId (solo si tiene formato compatible)
        const sid = (rec?.studentId || '').toString();
        if (sid) {
          const ch = sid.charAt(0).toUpperCase();
          if (['1', '2', '3', '4', '5', '6', '7', '8'].includes(ch)) return 'basica';
          if (['I', '9'].includes(ch) || (sid.includes('M') && ['1', '2', '3', '4'].includes(ch))) return 'media';
        }
        
        return undefined;
      };
      
      // Separar datos por nivel educativo usando inferencia robusta
      const basicaData = filteredData.filter((record: any) => inferLevel(record) === 'basica');
      const mediaData = filteredData.filter((record: any) => inferLevel(record) === 'media');
      
      // Función para procesar datos de un nivel
      const processLevelData = (levelData: any[]) => {
        const monthlyAttendance: Record<string, { total: number, present: number }> = {};
        
        levelData.forEach((record: any) => {
          if (record.date) {
            const sessionDate = new Date(record.date);
            const monthIndex = sessionDate.getMonth();
            const yearMonth = `${sessionDate.getFullYear()}-${String(monthIndex + 1).padStart(2, '0')}`;
            
            // Filtrar por semestre si está especificado
            if (semester) {
              const month = sessionDate.getMonth() + 1;
              // S1: Marzo(3)..Junio(6); S2: Julio(7)..Diciembre(12)
              const isFirstSemester = month >= 3 && month <= 6;
              const isSecondSemester = month >= 7 && month <= 12;
              if (semester === 'S1' && !isFirstSemester) return;
              if (semester === 'S2' && !isSecondSemester) return;
            }
            
            if (!monthlyAttendance[yearMonth]) {
              monthlyAttendance[yearMonth] = { total: 0, present: 0 };
            }
            
            monthlyAttendance[yearMonth].total++;
            if (record.status === 'present') {
              monthlyAttendance[yearMonth].present++;
            }
          }
        });
        
        // Convertir a porcentajes mensuales
        const monthlyPct: Record<string, number> = {};
        Object.entries(monthlyAttendance).forEach(([yearMonth, data]) => {
          monthlyPct[yearMonth] = data.total > 0 ? (data.present / data.total) * 100 : 0;
        });
        
        return monthlyPct;
      };
      
      return {
        basica: processLevelData(basicaData),
        media: processLevelData(mediaData)
      };
    }
    
    // Para calificaciones, usar monthlyPctByKey; si está vacío, construir un fallback rápido desde submissions por año
    const hasAny = monthlyPctByKey && Object.keys(monthlyPctByKey).length > 0;
    if (hasAny) return monthlyPctByKey;
    try {
      const yearToUse = year;
      const { LocalStorageManager } = require('@/lib/education-utils');
      const subs = LocalStorageManager.getSubmissionsForYear?.(yearToUse) || JSON.parse(localStorage.getItem(`smart-student-submissions-${yearToUse}`) || '[]') || [];
      const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const agg: Record<string,{sum:number;n:number}> = {};
      subs
        .filter((s:any)=> (typeof s.grade === 'number' || typeof s.score === 'number'))
        .forEach((s:any)=>{
          const v = s.createdAt || s.gradedAt || s.timestamp || s.when || s.date;
          let ts = 0;
          if (typeof v === 'number') ts = v; else if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t)) ts = t; }
          if (!ts) return;
          const d = new Date(ts); if (d.getFullYear() !== yearToUse) return;
          const key = monthKey(d);
          const pct = toPercentFromConfigured(typeof s.grade === 'number' ? s.grade : s.score);
          if (!agg[key]) agg[key] = { sum:0, n:0 };
          if (typeof pct === 'number' && isFinite(pct)) { agg[key].sum += pct; agg[key].n += 1; }
        });
      const out: Record<string, number> = {};
      Object.keys(agg).forEach(k=>{ if (agg[k].n>0) out[k] = agg[k].sum/agg[k].n; });
      return out;
    } catch { return monthlyPctByKey; }
  }, [comparisonType, year, monthlyPctByKey, filters, semester, sqlAttendance, isAttendanceSQLConnected, localAttendanceData]);

  // Convertir datos procesados en formato para el gráfico
  const { visibleStart, visibleEnd, currentMonthIdx } = useMemo(() => {
    const { start: visibleStart, end: visibleEnd } = getCalendarMonthRange();
    const currentMonthIdx = new Date().getMonth();
    return { visibleStart, visibleEnd, currentMonthIdx };
  }, [comparisonType, zoomYValue, semester, language]); // Agregar zoomYValue como dependencia
  
  // Para asistencia: respetar visibleEnd calculado (Mar..Dic o 3m), sin acotar por mes actual
  const actualVisibleEnd = (comparisonType === 'asistencia')
    ? visibleEnd
    : (year === currentYear ? Math.min(visibleEnd, currentMonthIdx) : visibleEnd);
  
  // Para asistencia con MÚLTIPLES series dinámicas (nivel→grados, curso→secciones, sección única, o Básica/Media)
  if (comparisonType === 'asistencia') {
    // Paleta extendida (misma idea que en Comparación de Cursos)
    const palette = ['#60A5FA','#F59E0B','#10B981','#F97316','#8B5CF6','#EC4899','#14B8A6','#F43F5E','#A3E635','#FDE047','#6366F1','#84CC16'];

    // Utilidades locales para obtener cursos/secciones por AÑO objetivo - Optimizado con cache
    const readJson = (k: string) => getCachedLocalStorageJson(k, []);
    const coursesYear = [
      ...readJson(`smart-student-admin-courses-${year}`),
      ...readJson(`smart-student-courses-${year}`),
    ];
    const sectionsYear = [
      ...readJson(`smart-student-admin-sections-${year}`),
      ...readJson(`smart-student-sections-${year}`),
    ];
    // Colecciones globales para localizar metadatos cuando el ID pertenece a otro año
    const allCoursesAnyYear = (() => {
      const out: any[] = [];
      const keys = Object.keys(localStorage).filter(k => /^(smart-student-(admin-)?courses)(-|$)/.test(k));
      keys.forEach(k => { const a = readJson(k); if (Array.isArray(a)) out.push(...a); });
      if (out.length === 0) out.push(...readJson('smart-student-courses'));
      return out;
    })();
    const allSectionsAnyYear = (() => {
      const out: any[] = [];
      const keys = Object.keys(localStorage).filter(k => /^(smart-student-(admin-)?sections)(-|$)/.test(k));
      keys.forEach(k => { const a = readJson(k); if (Array.isArray(a)) out.push(...a); });
      if (out.length === 0) out.push(...readJson('smart-student-sections'));
      return out;
    })();

    const courseByIdAny = (id?: string) => allCoursesAnyYear.find((c:any)=> String(c?.id)===String(id));
    const sectionByIdAny = (id?: string) => allSectionsAnyYear.find((s:any)=> String(s?.id || s?.sectionId)===String(id));
    const courseByIdYear = (id?: string) => coursesYear.find((c:any)=> String(c?.id)===String(id));
    const sectionByIdYear = (id?: string) => sectionsYear.find((s:any)=> String(s?.id || s?.sectionId)===String(id));
    const gradeNumOfCourse = (c:any): number | undefined => {
      const name: string = c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || '';
      const m = name.match(/(\d{1,2})/); return m ? parseInt(m[1],10) : undefined;
    };
    const levelOfCourse = (c:any): 'basica'|'media'|undefined => {
      const lv = (c?.level||'').toString().toLowerCase();
      if (/basica|basico|basic|bsica|bsico/.test(lv)) return 'basica';
      if (/media|medio|secundaria|secondary|high/.test(lv)) return 'media';
      // Inferir por nombre (buscar media primero para evitar que "1ro_medio" sea clasificado como basica por el número)
      const name = (c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || '').toString().toLowerCase();
      if (/media|medio|secundaria|secondary|high/.test(name)) return 'media';
      if (/basica|basico|basic|bsica|bsico/.test(name)) return 'basica';
      const n = gradeNumOfCourse(c);
      if (typeof n === 'number') return n<=8 ? 'basica' : 'media';
      return undefined;
    };
    const normalize = (s?: string) => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
    const normCourseKey = (c:any) => normalize(c?.gradeName || c?.shortName || c?.name || c?.label || '');
    const sectionLetter = (s:any) => normalize((s?.shortName || s?.label || s?.name || '').replace(/.*\bsecci[óo]n\s*/i,''));
    const csOf = (obj:any): { courseId?: string; sectionId?: string } => {
      const cs = obj?.courseSectionId || obj?.course;
      if (typeof cs === 'string' && cs.includes('-')) {
        const parts = cs.split('-');
        return { courseId: parts.slice(0,-1).join('-'), sectionId: parts.at(-1) };
      }
      return { courseId: String(obj?.courseId || obj?.course || ''), sectionId: String(obj?.sectionId || obj?.section || '') };
    };

  // Definir scopes en función de los filtros, igual espíritu que Comparación de Cursos
  // level es opcional y se usa como fallback cuando no hay IDs mapeables para el año objetivo
  type Scope = { label: string; courseIds?: string[]; sectionIds?: string[]; level?: 'basica'|'media' };
    let scopes: Scope[] = [];
    if (filters?.sectionId) {
      // Determinar la sección seleccionada (cualquier año), su letra y el nombre del curso
      const selSec = sectionByIdAny(filters.sectionId);
      const selCourse = courseByIdAny(selSec?.courseId || selSec?.course?.id || selSec?.courseId);
      const selCourseKey = normCourseKey(selCourse);
      const selLetter = sectionLetter(selSec);
      // Buscar la sección equivalente en el AÑO objetivo (misma letra dentro de curso equivalente)
      const yearCourseIds = coursesYear.filter((c:any)=> normCourseKey(c)===selCourseKey).map((c:any)=> String(c.id));
      const eqSections = sectionsYear.filter((s:any)=> yearCourseIds.includes(String(s?.courseId || s?.course?.id || s?.courseId)) && sectionLetter(s)===selLetter);
      if (eqSections.length > 0) {
        scopes = eqSections.map((s:any)=> ({ label: `${(selCourse?.gradeName||selCourse?.name||'Curso')} ${(sectionLetter(s)||'').toUpperCase()}`.trim(), sectionIds: [String(s?.id || s?.sectionId)] }));
      } else {
        // Fallback: si no hay mapeo, usar la sección original (puede no coincidir el ID con el año pero mantenemos etiqueta)
        const secName = (selSec?.name || selSec?.label || '').replace(/.*\bSecci[óo]n\s*/i,'');
        const courseName = selCourse?.gradeName || selCourse?.name || '';
        scopes = [{ label: `${courseName} ${secName}`.trim(), sectionIds: [String(filters.sectionId)] }];
      }
    } else if (filters?.courseId) {
      // CourseId puede pertenecer a otro año; mapear por nombre/clave al año objetivo
      const selCourse = courseByIdAny(filters.courseId) || courseByIdYear(filters.courseId);
      const selKey = normCourseKey(selCourse);
      const yearCourseIds = coursesYear.filter((c:any)=> normCourseKey(c) === selKey).map((c:any)=> String(c.id));
      const secsYear = sectionsYear.filter((s:any)=> yearCourseIds.includes(String(s?.courseId || s?.course?.id || s?.courseId)));
      const courseName = (selCourse?.gradeName || selCourse?.name || '').trim();
      scopes = secsYear.map((s:any)=> ({ label: `${courseName} ${(s?.name||s?.label||'').replace(/.*\bSecci[óo]n\s*/i,'')}`.trim(), sectionIds: [String(s?.id || s?.sectionId)] }));
      if (scopes.length === 0) scopes = [{ label: `${courseName} A`, sectionIds: ['A'] }];
    } else if (filters?.level) {
      const range = filters.level === 'basica' ? Array.from({length:8},(_,i)=>i+1) : Array.from({length:4},(_,i)=>i+1);
      scopes = range.map(n => {
        const cids = coursesYear
          .filter((c:any)=> levelOfCourse(c) === filters.level && gradeNumOfCourse(c) === n)
          .map((c:any)=> String(c.id));
        const label = filters.level === 'basica' ? ({1:'1ero',2:'2do',3:'3ro',4:'4to',5:'5to',6:'6to',7:'7mo',8:'8vo'} as Record<number,string>)[n] : ({1:'1ro',2:'2do',3:'3ro',4:'4to'} as Record<number,string>)[n];
        return { label, courseIds: cids };
      });
    } else {
      // Default: dos series por nivel. Si no hay cursos para el año, dejamos level para inferencia
      const basicaIds = coursesYear.filter((c:any)=> levelOfCourse(c) === 'basica').map((c:any)=> String(c.id));
      const mediaIds = coursesYear.filter((c:any)=> levelOfCourse(c) === 'media').map((c:any)=> String(c.id));
      const hasIds = basicaIds.length > 0 || mediaIds.length > 0;
      const labelBasica = t('attendanceLevelBasic', t('levelBasic','Básica'));
      const labelMedia = t('attendanceLevelHigh', t('levelHigh','Media'));
      scopes = [ 
        { label: labelBasica, courseIds: basicaIds, level: hasIds ? undefined : 'basica' }, 
        { label: labelMedia,  courseIds: mediaIds, level: hasIds ? undefined : 'media'  } 
      ];
    }

    // Cargar asistencia del año seleccionado y construir/usar índice por día (para cambios de filtros más fluidos)
    let attendance: any[] = [];
    try {
      if (isAttendanceSQLConnected && sqlAttendance && Array.isArray(sqlAttendance[year]) && sqlAttendance[year].length > 0) {
        attendance = sqlAttendance[year] || [];
        console.log(`📊 [GradesOverTimeChart-Scopes] Usando datos SQL para año ${year}:`, attendance.length, 'registros');
      } else if (localAttendanceData && Array.isArray(localAttendanceData) && localAttendanceData.length > 0) {
        // Usar datos cargados desde Firebase directamente
        attendance = localAttendanceData;
        console.log(`🔥 [GradesOverTimeChart-Scopes] Usando datos Firebase locales para año ${year}:`, attendance.length, 'registros');
      } else {
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          attendance = LocalStorageManager.getAttendanceForYear?.(year) || [];
        } catch {
          attendance = JSON.parse(localStorage.getItem(`smart-student-attendance-${year}`) || '[]');
        }
        console.log(`💾 [GradesOverTimeChart-Scopes] Usando datos LocalStorage para año ${year}:`, attendance.length, 'registros');
      }
    } catch { attendance = []; }
    if (!Array.isArray(attendance)) attendance = [];
    const { dayIndex } = buildAttendanceYearIndex(year, attendance);

    // Helper para parsear fecha y obtener mes (evitar problemas de zona horaria)
    const parseTs = (r:any): Date | null => {
      const v = r.timestamp || r.date || r.when || r.dateString;
      if (!v) return null;
      if (typeof v === 'number') return new Date(v);
      if (typeof v === 'string') {
        // DD-MM-YYYY
        if (/^\d{2}-\d{2}-\d{4}$/.test(v)) { 
          const [dd,mm,yyyy] = v.split('-').map(Number); 
          return new Date(yyyy,(mm||1)-1,dd||1,12,0,0); // Mediodía para evitar problemas de TZ
        }
        // DD/MM/YYYY
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) { 
          const [dd,mm,yyyy] = v.split('/').map(Number); 
          return new Date(yyyy,(mm||1)-1,dd||1,12,0,0);
        }
        // YYYY-MM-DD (con o sin hora) - extraer solo la parte de fecha
        const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
          const [, yyyy, mm, dd] = isoMatch;
          return new Date(Number(yyyy), Number(mm)-1, Number(dd), 12, 0, 0); // Mediodía local
        }
        const t = Date.parse(v); 
        if (!isNaN(t)) {
          // Convertir a fecha local sin hora
          const d = new Date(t);
          return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
        }
      }
      return null;
    };

    // Agregación mejorada: solo días con datos, etiquetas de meses
    const dayMs = 24 * 60 * 60 * 1000;
    const useDaily = true; // Siempre usar granularidad diaria para asistencia
    
    // Calcular rango temporal basado en meses visibles
    const startDate = new Date(year, visibleStart, 1);
    // Para asistencia cortar al 15 de diciembre en S2 o cuando el rango llega a dic con zoom OFF
    const endDate = (comparisonType === 'asistencia' && ((semester === 'S2') || (!zoomYValue && actualVisibleEnd >= 11)))
      ? new Date(year, 11, 15)
      : new Date(year, actualVisibleEnd + 1, 0); // último día del mes final
    const startTs = startDate.getTime();
    const endTs = endDate.getTime();
    
    // Primer paso: recopilar todas las fechas que tienen datos
    const datesWithData = new Set<string>();
    const monthNames = language === 'en' ? labelsEN : labelsES;
    
    // Asegurar que attendance sea un array antes de usar forEach
    if (Array.isArray(attendance)) {
      attendance.forEach(rec => {
        const d = parseTs(rec); if (!d) return;
        if (d.getFullYear() !== year) return;
        
        const recordDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const recordTs = recordDate.getTime();
        if (recordTs >= startTs && recordTs <= endTs) {
          // Usar formato YYYY-MM-DD con mes 1-based y padding para coincidir con keyOfDayLocal y dayIndex
          const dateKey = `${recordDate.getFullYear()}-${String(recordDate.getMonth() + 1).padStart(2, '0')}-${String(recordDate.getDate()).padStart(2, '0')}`;
          datesWithData.add(dateKey);
        }
      });
    }
    
    // Ordenar fechas y crear mapeo
    const sortedDates = Array.from(datesWithData)
      .map(dateKey => {
        const [yearPart, monthPart, dayPart] = dateKey.split('-').map(Number);
        // El mes en dateKey ahora es 1-based (1=Enero, 12=Diciembre), convertir a 0-based para Date
        return new Date(yearPart, (monthPart || 1) - 1, dayPart || 1);
      })
      .sort((a, b) => a.getTime() - b.getTime());
    
    // Crear etiquetas con solo nombres de meses (mostrar mes cuando cambia)
    const labelsDetail: string[] = [];
    let lastMonth = -1;
    
    sortedDates.forEach((date, index) => {
      const currentMonth = date.getMonth();
      if (currentMonth !== lastMonth) {
        labelsDetail.push(monthNames[currentMonth]);
        lastMonth = currentMonth;
      } else {
        labelsDetail.push(''); // Etiqueta vacía para días del mismo mes
      }
    });
    
    // Inicializar agregadores solo para días con datos
    let aggDetail: Array<Array<{present: number; total: number}>> = [];
    aggDetail = scopes.map(() => Array.from({length: sortedDates.length}, () => ({present: 0, total: 0})));

    // Inferir nivel cuando no hay IDs disponibles para el año
    const inferLevelFromRecord = (rec:any): 'basica'|'media'|undefined => {
      // 1) Campo explícito de nivel
      const explicit = (rec?.level || rec?.courseLevel || '').toString().toLowerCase();
      if (/basica|basico|basic/.test(explicit)) return 'basica';
      if (/media|medio|secundaria|secondary|high/.test(explicit)) return 'media';
      
      // 2) Inferir desde el campo "course" (nombre del curso como string, ej: "1ro Básico A")
      const courseName = (typeof rec?.course === 'string' ? rec.course : (rec?.course?.name || rec?.courseName || '')).toString().toLowerCase();
      if (courseName) {
        if (/basica|basico|b[aá]sico/.test(courseName)) return 'basica';
        if (/media|medio|secundaria|secondary|high/.test(courseName)) return 'media';
      }
      
      // 3) Buscar curso por id en colecciones locales
      const { courseId } = csOf(rec);
      const c = courseByIdYear(courseId) || courseByIdAny(courseId);
      const lv = c ? levelOfCourse(c) : undefined;
      if (lv) return lv;
      
      // 4) Inferir desde el ID del curso si es legible (ej: "1ro Medio")
      if (courseId) {
        const lower = courseId.toLowerCase();
        if (lower.includes('media') || lower.includes('medio') || lower.includes('secundaria') || lower.includes('high')) return 'media';
        if (lower.includes('basica') || lower.includes('basico') || lower.includes('primaria') || lower.includes('basic')) return 'basica';
      }

      // 5) Heurística por studentId como en el agregado mensual
      const sid = (rec?.studentId || '').toString();
      if (sid) {
        const ch = sid.charAt(0).toUpperCase();
        if (['1','2','3','4','5','6','7','8'].includes(ch)) return 'basica';
        if (['I','9'].includes(ch) || (sid.includes('M') && ['1','2','3','4'].includes(ch))) return 'media';
      }
      return undefined;
    };

    const matchScope = (rec:any, scope: Scope): boolean => {
      const { courseId, sectionId } = csOf(rec);
      if (scope.sectionIds && scope.sectionIds.length) return scope.sectionIds.some(id => String(id)===String(sectionId));
      if (scope.courseIds && scope.courseIds.length) return scope.courseIds.some(id => String(id)===String(courseId));
      if (scope.level) return inferLevelFromRecord(rec) === scope.level; // Fallback por nivel
      // Sin IDs ni nivel: incluir por defecto para no vaciar la serie
      return true;
    };

    // Crear mapeo de fecha a índice para búsqueda rápida (formato YYYY-MM-DD)
    const dateToIndex = new Map<string, number>();
    sortedDates.forEach((date, index) => {
      const dateKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
      dateToIndex.set(dateKey, index);
    });

    // Recorrer solo días visibles usando el índice precalculado
    for (const [dateKey, idx] of dateToIndex.entries()) {
      const list = dayIndex.get(dateKey);
      if (!list || list.length === 0) continue;
      list.forEach((rec) => {
        // Determinar conteos de presentes/total del registro
        let presentCount = 0; let totalCount = 0;
        if (Array.isArray(rec.presentIds)) {
          presentCount = rec.presentCount || rec.presentIds.length || 0;
          totalCount = rec.totalCount || presentCount;
        } else if (rec.status === 'present' || rec.status === 'absent') {
          totalCount = 1; presentCount = rec.status === 'present' ? 1 : 0;
        } else {
          totalCount = rec.totalCount || 0; presentCount = rec.presentCount || 0;
        }
        if (totalCount <= 0) return;

        scopes.forEach((s, si) => {
          if (!matchScope(rec.raw ?? rec, s)) return;
          if (aggDetail[si] && aggDetail[si][idx]) {
            aggDetail[si][idx].present += presentCount;
            aggDetail[si][idx].total += totalCount;
          }
        });
      });
    }

    // Agregar datos diarios a datos mensuales (1 punto por mes)
    const monthKeysInOrder: string[] = [];
    const monthKeyToIndex = new Map<string, number>();
    sortedDates.forEach(date => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthKeyToIndex.has(key)) {
        monthKeyToIndex.set(key, monthKeysInOrder.length);
        monthKeysInOrder.push(key);
      }
    });

    const monthlyAgg: Array<Array<{ present: number; total: number }>> = scopes.map(() =>
      Array.from({ length: monthKeysInOrder.length }, () => ({ present: 0, total: 0 }))
    );

    sortedDates.forEach((date, dayIdx) => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const monthIdx = monthKeyToIndex.get(key);
      if (typeof monthIdx !== 'number') return;

      scopes.forEach((_, si) => {
        const cell = aggDetail[si]?.[dayIdx];
        if (!cell || cell.total <= 0) return;
        monthlyAgg[si][monthIdx].present += cell.present;
        monthlyAgg[si][monthIdx].total += cell.total;
      });
    });

    // Usar datos mensuales
    const labels = monthKeysInOrder.map(key => {
      const [, mm] = key.split('-').map(Number);
      const monthIdx = Math.max(0, Math.min(11, (mm || 1) - 1));
      return monthNames[monthIdx];
    });
    const agg = monthlyAgg;

    // Construir series finales
    const seriesData = scopes.map((s, si) => ({
      label: s.label,
      color: palette[si % palette.length],
      data: agg[si].map(x => x.total>0 ? Math.max(0, Math.min(100, +(x.present/x.total*100).toFixed(1))) : null)
    }));

    // Visibilidad efectiva: respetar exactamente la selección del usuario (permitir 0 series visibles)
    const effectiveVisible = (() => {
      const requested = visibleSeries as Set<number>;
      return new Set([...Array(seriesData.length).keys()].filter(i => requested.has(i)));
    })();

    const seriesToRender = seriesData.filter((_,i)=> effectiveVisible.has(i));

    // Verificar si hay datos reales en las series (no solo valores null)
    const hasAnyData = seriesData.some(s => s.data.some(v => v !== null));
    const hasVisibleData = seriesToRender.some(s => s.data.some(v => v !== null));

    // Rango dinámico Y basado en series visibles
    const visibleValues = seriesToRender.flatMap(s => s.data.filter(v => v!==null) as number[]);
    const minValue = visibleValues.length ? Math.min(...visibleValues) : 0;
    const maxValue = visibleValues.length ? Math.max(...visibleValues) : 100;
    const pad = (maxValue - minValue) * 0.1;
    const adjustedMin = Math.max(0, minValue - pad);
    const adjustedMax = Math.min(100, maxValue + pad);

    return (
      <div className="space-y-5">
        <div className="relative">
          <div className="h-80 relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4">
            {seriesToRender.length > 0 ? (
              (() => {
                const MultiTrendChart = require('@/components/charts/MultiTrendChart').default as typeof import('@/components/charts/MultiTrendChart').default;
                return (
                  <MultiTrendChart
                    series={seriesToRender}
                    labels={labels}
                    height={288}
                    percentGrid
                    yAxis
                    highlightLastValue
                  />
                );
              })()
            ) : (
              <div className="h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600">
                <div className="text-center">
                  <svg
                    className="animate-spin h-10 w-10 mx-auto text-blue-500 mb-3"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  <p className="text-gray-500 dark:text-gray-400 text-sm">
                    {!hasAnyData 
                      ? t('noAttendanceDataForPeriod', 'No hay datos de asistencia para este período')
                      : !hasVisibleData
                        ? t('noDataInSelectedSeries', 'Sin datos en las series seleccionadas')
                        : t('selectSeriesToShow', 'Selecciona al menos una serie para mostrar datos')
                    }
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Leyenda dinámica (como comparación) */}
        <div className="flex items-center justify-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700">
          {seriesData.map((s, idx) => {
            const isVisible = effectiveVisible.has(idx);
            return (
              <button
                key={s.label+idx}
                onClick={() => {
                  const next = new Set(visibleSeries);
                  if (next.has(idx)) next.delete(idx); else next.add(idx);
                  setVisibleSeries(next);
                }}
                className={`
                  flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 hover:scale-105 
                  ${isVisible 
                    ? 'bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100' 
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }
                `}
              >
                <div className="w-3 h-3 rounded-full border-2 border-white dark:border-gray-800 shadow-sm" style={{ backgroundColor: isVisible ? s.color : '#d1d5db' }} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Para calificaciones (multi-serie como el comparador)
  {
    // Paleta y etiquetas
    const palette = ['#60A5FA', '#F59E0B', '#10B981', '#F97316', '#8B5CF6', '#EC4899', '#14B8A6', '#F43F5E', '#A3E635', '#FDE047', '#6366F1', '#84CC16'];
    const labels: string[] = [];
    for (let m = visibleStart; m <= actualVisibleEnd; m++) labels.push((language === 'en' ? labelsEN : labelsES)[m]);

    // Cargar metadatos de cursos/secciones del año objetivo - Optimizado con cache
    const readJson = (k: string) => getCachedLocalStorageJson(k, []);
    const coursesYear = [ ...readJson(`smart-student-admin-courses-${year}`), ...readJson(`smart-student-courses-${year}`) ];
    const sectionsYear = [ ...readJson(`smart-student-admin-sections-${year}`), ...readJson(`smart-student-sections-${year}`) ];
    const allCoursesAnyYear = (()=>{ const out:any[]=[]; Object.keys(localStorage).filter(k=>/^(smart-student-(admin-)?courses)(-|$)/.test(k)).forEach(k=>{ const a=readJson(k); if(Array.isArray(a)) out.push(...a);}); if(out.length===0) out.push(...readJson('smart-student-courses')); return out;})();
    const allSectionsAnyYear = (()=>{ const out:any[]=[]; Object.keys(localStorage).filter(k=>/^(smart-student-(admin-)?sections)(-|$)/.test(k)).forEach(k=>{ const a=readJson(k); if(Array.isArray(a)) out.push(...a);}); if(out.length===0) out.push(...readJson('smart-student-sections')); return out;})();
    const normalize = (s?: string) => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
    const normCourseKey = (c:any) => normalize(c?.gradeName || c?.shortName || c?.name || c?.label || '');
    const sectionLetter = (s:any) => normalize((s?.shortName || s?.label || s?.name || '').replace(/.*\bsecci[óo]n\s*/i,''));
    const gradeNumOfCourse = (c:any): number | undefined => { const name: string = c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || ''; const m=name.match(/(\d{1,2})/); return m?parseInt(m[1],10):undefined; };
    const levelOfCourse = (c:any): 'basica'|'media'|undefined => {
      // 1. Verificar campo level explícito
      const lv=(c?.level||'').toString().toLowerCase(); 
      if(/basica|basico|basic|bsica|bsico/.test(lv)) return 'basica'; 
      if(/media|medio|secundaria|secondary|high/.test(lv)) return 'media'; 
      // 2. Verificar en el nombre del curso (para courseIds como "1ro_bsico", "2do_medio", etc.)
      const nm=(c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || '').toString().toLowerCase();
      // Primero buscar indicadores explícitos de media (para no confundir "1ro_medio" con basica por el número 1)
      if(/media|medio|secundaria|secondary|high/.test(nm)) return 'media';
      if(/basica|basico|basic|bsica|bsico/.test(nm)) return 'basica';
      // 3. Fallback: inferir del número de grado (solo si no hay indicador de nivel en el nombre)
      const n=gradeNumOfCourse(c); 
      if(typeof n==='number') return n<=8?'basica':'media'; 
      return undefined;
    };

    // Scopes igual que el comparador
    type Scope = { label: string; courseIds?: string[]; sectionIds?: string[] };
    let scopes: Scope[] = [];
    if (filters?.sectionId) {
      const selSec = allSectionsAnyYear.find((s:any)=> String(s?.id||s?.sectionId)===String(filters.sectionId));
      const selCourse = allCoursesAnyYear.find((c:any)=> String(c?.id)===String(selSec?.courseId || selSec?.course?.id || selSec?.courseId));
      const yearCourseIds = coursesYear.filter((c:any)=> normCourseKey(c)===normCourseKey(selCourse)).map((c:any)=> String(c.id));
      const selLetter = sectionLetter(selSec);
      const eqSections = sectionsYear.filter((s:any)=> yearCourseIds.includes(String(s?.courseId || s?.course?.id || s?.courseId)) && sectionLetter(s)===selLetter);
      scopes = (eqSections.length?eqSections:[selSec]).filter(Boolean).map((s:any)=> ({ label: `${(selCourse?.gradeName||selCourse?.name||'Curso')} ${(sectionLetter(s)||'').toUpperCase()}`.trim(), sectionIds: [String(s?.id || s?.sectionId)] }));
    } else if (filters?.courseId) {
      const selCourse = allCoursesAnyYear.find((c:any)=> String(c?.id)===String(filters.courseId)) || coursesYear.find((c:any)=> String(c?.id)===String(filters.courseId));
      const yearCourseIds = coursesYear.filter((c:any)=> normCourseKey(c)===normCourseKey(selCourse)).map((c:any)=> String(c.id));
      const secsYear = sectionsYear.filter((s:any)=> yearCourseIds.includes(String(s?.courseId || s?.course?.id || s?.courseId)));
      const courseName = selCourse?.gradeName || selCourse?.name || '';
      scopes = secsYear.map((s:any)=> ({ label: `${courseName} ${(s?.name||s?.label||'').replace(/.*\bSecci[óo]n\s*/i,'')}`.trim(), sectionIds: [String(s?.id || s?.sectionId)] }));
      if (scopes.length === 0) scopes = [{ label: `${courseName} A`, sectionIds: ['A'] }];
    } else if (filters?.level) {
      const range = filters.level === 'basica' ? Array.from({length:8},(_,i)=>i+1) : Array.from({length:4},(_,i)=>i+1);
      scopes = range.map(n => {
        const cids = coursesYear.filter((c:any)=> levelOfCourse(c)===filters.level && gradeNumOfCourse(c)===n).map((c:any)=> String(c.id));
        const label = filters.level === 'basica' ? ({1:'1ero',2:'2do',3:'3ro',4:'4to',5:'5to',6:'6to',7:'7mo',8:'8vo'} as Record<number,string>)[n] : ({1:'1ro',2:'2do',3:'3ro',4:'4to'} as Record<number,string>)[n];
        return { label, courseIds: cids };
      });
    } else {
      const basicaIds = coursesYear.filter((c:any)=> levelOfCourse(c)==='basica').map((c:any)=> String(c.id));
      const mediaIds = coursesYear.filter((c:any)=> levelOfCourse(c)==='media').map((c:any)=> String(c.id));
      scopes = [ 
        { label: t('attendanceLevelBasic', t('levelBasic','Básica')), courseIds: basicaIds }, 
        { label: t('attendanceLevelHigh', t('levelHigh','Media')), courseIds: mediaIds } 
      ];
    }

    // Cargar calificaciones del año (preferir SQL si está disponible) y usar índice mensual
    // 🔧 CORREGIDO: Mejor fallback cuando SQL está conectado pero no tiene datos para el año
    let grades: any[] = [];
    try {
      // 1. Intentar SQL primero si está conectado Y tiene datos
      if (isSQLConnected && sqlGrades && Array.isArray(sqlGrades[year]) && sqlGrades[year].length > 0) {
        grades = sqlGrades[year];
        console.log(`[GradesOverTimeChart-Grades] Usando SQL para año ${year}:`, grades.length, 'registros');
      } else {
        // 2. Fallback a LocalStorageManager
        try { 
          grades = LocalStorageManager.getTestGradesForYear?.(year) || []; 
          if (grades.length > 0) {
            console.log(`[GradesOverTimeChart-Grades] Usando LocalStorageManager para año ${year}:`, grades.length, 'registros');
          }
        } catch { grades = []; }
        
        // 3. Fallback a localStorage directo
        if (!Array.isArray(grades) || grades.length === 0) {
          try { 
            grades = JSON.parse(localStorage.getItem(`smart-student-submissions-${year}`)||'[]'); 
            if (grades.length > 0) {
              console.log(`[GradesOverTimeChart-Grades] Usando localStorage directo para año ${year}:`, grades.length, 'registros');
            }
          } catch { grades = []; }
        }
      }
    } catch { grades = []; }
    const { monthIndex } = buildGradesYearIndex(year, grades);

    // Agregación mensual por scope vía índice
    const monthCount = Math.max(0, actualVisibleEnd - visibleStart + 1);
    const agg = scopes.map(() => Array.from({length: monthCount}, () => [] as number[]));
    for (let m = visibleStart; m <= actualVisibleEnd; m++) {
      const mk = `${year}-${String(m+1).padStart(2,'0')}`;
      const list = monthIndex.get(mk) || [];
      const idx = m - visibleStart;
      if (!list.length) continue;
      list.forEach(gr => {
        const courseId = String(gr.courseId || '');
        const sectionId = String(gr.sectionId || '');
        const score = gr.score;
        scopes.forEach((s, si) => {
          let matched = false;
          if (s.sectionIds && s.sectionIds.length) { if (s.sectionIds.some(id => String(id)===sectionId)) matched = true; }
          else if (s.courseIds && s.courseIds.length) { if (s.courseIds.some(id => String(id)===courseId)) matched = true; }
          
          // Fallback: Match by inferred level/grade from courseId string
          if (!matched && courseId) {
             const fakeCourse = { name: courseId, level: '' };
             const infLevel = levelOfCourse(fakeCourse);
             if (filters?.level) {
                 if (infLevel === filters.level) {
                     const infGrade = gradeNumOfCourse(fakeCourse);
                     if (infGrade === (si + 1)) matched = true;
                 }
             } else if (!filters?.courseId && !filters?.sectionId) {
                 if (si === 0 && infLevel === 'basica') matched = true;
                 if (si === 1 && infLevel === 'media') matched = true;
             }
          }

          if (matched) agg[si][idx].push(score);
        });
      });
    }

    const seriesData = scopes.map((s, si) => ({
      label: s.label,
      color: palette[si % palette.length],
      data: agg[si].map(list => list.length ? +(list.reduce((a,b)=>a+b,0)/list.length).toFixed(1) : null)
    }));

    // Si el set de visibilidad está vacío o pequeño y hay muchas series, mostrar todas
    const effectiveVisible = (() => {
      const req = visibleSeries as Set<number>;
      // Respetar exactamente lo que el usuario selecciona; permitir 0 series visibles
      return new Set([...Array(seriesData.length).keys()].filter(i => req.has(i)));
    })();
    const seriesToRender = seriesData.filter((_,i)=> effectiveVisible.has(i));

    // Verificar si hay datos reales en las series (no solo valores null)
    const hasAnyGradesData = seriesData.some(s => s.data.some(v => v !== null));
    const hasVisibleGradesData = seriesToRender.some(s => s.data.some(v => v !== null));

    return (
      <div className="space-y-5">
        <div className="relative">
          <div className="h-80 relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4">
            {/* 🔧 CORREGIDO: Verificar hasVisibleGradesData en lugar de solo seriesToRender.length */}
            {seriesToRender.length > 0 && hasVisibleGradesData ? (
              (() => {
                const MultiTrendChart = require('@/components/charts/MultiTrendChart').default as typeof import('@/components/charts/MultiTrendChart').default;
                return (
                  <MultiTrendChart
                    series={seriesToRender}
                    labels={labels}
                    height={288}
                    percentGrid
                    yAxis
                    highlightLastValue
                  />
                );
              })()
            ) : (
              <div className="h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600">
                <div className="text-center">
                  <svg
                    className="animate-spin h-10 w-10 mx-auto text-blue-500 mb-3"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  <p className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">
                    {!hasAnyGradesData 
                      ? t('noGradesDataForPeriod', 'Sin datos de calificaciones')
                      : !hasVisibleGradesData
                        ? t('noDataInSelectedSeries', 'Sin datos en las series seleccionadas')
                        : t('selectSeriesToShow', 'Selecciona al menos una serie para mostrar datos')
                    }
                  </p>
                  {!hasAnyGradesData && (
                    <p className="text-gray-400 dark:text-gray-500 text-xs">
                      {t('tryAnotherPeriodOrCourse', 'Prueba seleccionando otro período o ajusta los filtros')}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700">
          {seriesData.map((s, idx) => {
            const isVisible = effectiveVisible.has(idx);
            return (
              <button
                key={s.label + idx}
                onClick={() => {
                  const next = new Set(visibleSeries);
                  if (next.has(idx)) next.delete(idx); else next.add(idx);
                  setVisibleSeries(next);
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 hover:scale-105 ${isVisible ? 'bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
              >
                <div className="w-3 h-3 rounded-full border-2 border-white dark:border-gray-800 shadow-sm" style={{ backgroundColor: isVisible ? s.color : '#d1d5db' }} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
}

// Componente: Gráfico de comparación de cursos en líneas
function CourseComparisonChart({ 
  data, 
  filters,
  period,
  year,
  comparisonType,
  setComparisonType,
  sqlGrades,
  isSQLConnected,
  sqlAttendance,
  isAttendanceSQLConnected,
  preloadStats,
  loaderDone,
}: { 
  data: Array<{ label: string; avgPct?: number; attendancePct?: number; avg20?: number }>; 
  filters: any,
  period: Period,
  year: number,
  comparisonType: 'notas' | 'asistencia',
  setComparisonType: (type: 'notas' | 'asistencia') => void,
  sqlGrades?: Record<number, any[]>;
  isSQLConnected?: boolean;
  sqlAttendance?: Record<number, any[]>;
  isAttendanceSQLConnected?: boolean;
  preloadStats?: { year: number; sectionAgg?: Array<{ courseId: string | null; sectionId: string | null; present: number; total: number }> } | null;
  loaderDone?: boolean;
}) {
  const { translate, language } = useLanguage();
  const t = (key: string, fallback?: string) => {
    const v = translate(key);
    return v === key ? (fallback ?? key) : v;
  };

  const [zoomY, setZoomY] = useState(true); // Con zoom por defecto
  type CourseTooltip = { x: number; y: number; lines: Array<{ value: string; color: string }>; };
  const [tooltip, setTooltip] = useState<CourseTooltip | null>(null);
  
  // MEJORA 2: Estado para controlar visibilidad de series - inicializar con series básicas
  const [visibleSeries, setVisibleSeries] = useState<Set<number>>(new Set([0, 1])); // Básica y Media por defecto

  // hasAnyVisibleData se calcula luego de dailySeries

  // Resumen de filtros para mostrar como subtítulo
  const titleFiltersSummary = useMemo(() => {
    try {
      const parts: string[] = [];
      if (filters?.semester) parts.push(filters.semester === 'S1' ? t('firstSemester', '1er Semestre') : t('secondSemester', '2do Semestre'));
      if (filters?.level) parts.push(filters.level === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
      // Solo buscar datos reales por año (sin fallback legacy)
      const yearKeys = Object.keys(localStorage).filter(k => /^(smart-student-(admin-)?(courses|sections))-\d{4}$/.test(k));
      const courses: any[] = [];
      const sections: any[] = [];
      yearKeys.forEach(k => {
        try {
          const arr = JSON.parse(localStorage.getItem(k) || '[]');
          if (/courses-\d{4}$/.test(k) && Array.isArray(arr)) courses.push(...arr);
          if (/sections-\d{4}$/.test(k) && Array.isArray(arr)) sections.push(...arr);
        } catch {}
      });
      if (filters?.courseId) {
        const c = courses.find((x:any)=> String(x?.id) === String(filters.courseId));
        const cl = c?.fullName || c?.displayName || c?.longName || c?.label || c?.gradeName || c?.name || String(filters.courseId);
        parts.push(cl);
      }
      if (filters?.sectionId) {
        const s = sections.find((x:any)=> String(x?.id||x?.sectionId) === String(filters.sectionId));
        const sec = (s?.fullName || s?.displayName || s?.longName || s?.label || s?.name || '').replace(/.*\bSecci[óo]n\s*/i, '');
        if (sec) parts.push(`${t('filterSection','Sección')} ${sec}`);
      }
      
      // Si no hay filtros específicos, mostrar información del período
      if (parts.length === 0) {
        const currentYear = new Date().getFullYear();
        if (year === currentYear && period === 'all' && !filters?.level && !filters?.courseId && !filters?.sectionId && !filters?.semester) {
          parts.push(`${t('academicPeriod','Período académico')} • ${year}`);
        } else if (year === currentYear) {
          parts.push(`${t('last45Days', 'Últimos 45 días')} • ${year}`);
        } else {
          parts.push(`${t('monthly', 'Mensual')} • ${year}`);
        }
      } else {
        parts.push(`${year}`);
      }
      
      return parts.join(' • ');
    } catch { return ''; }
  }, [JSON.stringify(filters), year]);

  // Versión compacta del resumen para pantallas pequeñas
  const titleFiltersSummaryCompact = useMemo(() => {
    const s = String(titleFiltersSummary || '');
    if (!s) return '';
    return s
      .replace(/1er\s+Semestre/gi, '1S')
      .replace(/2do\s+Semestre/gi, '2S')
      .replace(/B[áa]sica/gi, 'Bás.')
      .replace(/Media/gi, 'Med.')
      .replace(/B[áa]sico/gi, 'Bás.')
      .replace(/Medio/gi, 'Med.')
      .replace(/Primero/gi, '1°')
      .replace(/Segundo/gi, '2°')
      .replace(/Tercero/gi, '3°')
      .replace(/Cuarto/gi, '4°')
      .replace(/Quinto/gi, '5°')
      .replace(/Sexto/gi, '6°')
      .replace(/S[ée]ptimo/gi, '7°')
      .replace(/Octavo/gi, '8°');
  }, [titleFiltersSummary]);

  // Serie temporal diaria multi-serie basada en calendario y filtros
  const { series: dailySeries, labels: dailyLabels } = useMemo(() => {
    // Rango de fechas robusto por año/semestre/periodo (alineado con AttendanceTrendCard)
    const timeWindow = getTimeWindow(period);
    const isCurrentYear = year === new Date().getFullYear();
    const isPastYear = year < new Date().getFullYear();
    let fromTs: number;
    let toTs: number;
    
    // 1) Si hay semestre seleccionado, usar configuración por AÑO
    if (filters?.semester) {
      const rng = __getSemesterRange(year, filters.semester);
      if (rng.start && rng.end) {
        // Para S2 del año actual, no ir más allá de hoy
        const endAdj = (isCurrentYear && filters.semester === 'S2') ? Math.min(rng.end, Date.now()) : rng.end;
        fromTs = rng.start;
        toTs = endAdj;
      } else {
        // Fallback por meses si no hay calendario cargado
        if (filters.semester === 'S1') { fromTs = new Date(year,2,1).getTime(); toTs = new Date(year,5,30,23,59,59,999).getTime(); }
        else { fromTs = new Date(year,6,1).getTime(); toTs = Math.min(new Date(year,11,31,23,59,59,999).getTime(), Date.now()); }
      }
      // Ajuste adicional: si se eligió un periodo corto (7d/30d/90d), intersectar
      if (period !== 'all') {
        const look = period === '7d' ? 7 : period === '30d' ? 30 : 90;
        const { from: baseStart, to: baseEnd } = getDayAlignedRange(look, toTs);
        fromTs = Math.max(fromTs ?? baseStart, baseStart);
        toTs = Math.min(toTs ?? baseEnd, baseEnd);
      }
    } else if (isPastYear) {
      // 2) Años anteriores sin semestre: por defecto año completo o ventana corta si se pide explícita
  const yearStart = new Date(year,0,1,0,0,0,0).getTime();
  const yearEnd = new Date(year,11,31,23,59,59,999).getTime();
      if (period !== 'all' && timeWindow.from) {
        const anchorEnd = yearEnd;
        const look = period === '7d' ? 7 : period === '30d' ? 30 : 90;
        const { from: baseStart } = getDayAlignedRange(look, anchorEnd);
        fromTs = Math.max(baseStart, yearStart);
        toTs = anchorEnd;
      } else {
        fromTs = yearStart;
        toTs = yearEnd;
      }
    } else {
      // 3) Año actual sin semestre:
      const nowTs = Date.now();
      if (period !== 'all' && timeWindow.from) {
        const look = period === '7d' ? 7 : period === '30d' ? 30 : 90;
        const { from: alignedFrom, to: alignedTo } = getDayAlignedRange(look);
        fromTs = alignedFrom; toTs = alignedTo;
      } else {
        const noDimFilters = !filters?.level && !filters?.courseId && !filters?.sectionId;
        if (noDimFilters) {
          // Determinar inicio real del periodo escolar usando configuración de calendario (fin de summer + primer día hábil)
          let schoolStart = new Date(year,0,1); // fallback
          try {
            const rawCal = localStorage.getItem(`admin-calendar-${year}`);
            if (rawCal) {
              const cal = JSON.parse(rawCal);
              // Si hay rango de summer con end, usar el día siguiente al end como inicio preliminar
              if (cal?.summer?.end) {
                const [Y,M,D] = cal.summer.end.split('-').map(Number);
                if (Y && M && D) {
                  const endDate = new Date(Y,(M||1)-1,D||1);
                  endDate.setDate(endDate.getDate()+1);
                  schoolStart = endDate;
                }
              }
              // Asegurar que el inicio no caiga en fin de semana, feriado o vacaciones de invierno
              const holidays: string[] = Array.isArray(cal?.holidays) ? cal.holidays : [];
              const inRange = (d: Date, r?: {start?: string; end?: string}) => {
                if (!r?.start || !r?.end) return false;
                const [y1,m1,d1] = r.start.split('-').map(Number);
                const [y2,m2,d2] = r.end.split('-').map(Number);
                if (!(y1&&m1&&d1&&y2&&m2&&d2)) return false;
                const a = new Date(y1,(m1||1)-1,d1||1).getTime();
                const b = new Date(y2,(m2||1)-1,d2||1).getTime();
                const t = d.getTime();
                return t >= Math.min(a,b) && t <= Math.max(a,b);
              };
              // Avanzar hasta primer día lectivo (L-V, no holiday, fuera de summer/winter)
              for (let i=0;i<30;i++) { // límite de seguridad
                const dow = schoolStart.getDay();
                const ymd = `${schoolStart.getFullYear()}-${String(schoolStart.getMonth()+1).padStart(2,'0')}-${String(schoolStart.getDate()).padStart(2,'0')}`;
                const isWeekend = dow===0 || dow===6;
                const isHoliday = holidays.includes(ymd);
                const inSummer = inRange(schoolStart, cal?.summer);
                const inWinter = inRange(schoolStart, cal?.winter);
                if (!isWeekend && !isHoliday && !inSummer && !inWinter) break;
                schoolStart.setDate(schoolStart.getDate()+1);
              }
            }
          } catch {}
          fromTs = schoolStart.getTime();
          toTs = nowTs;
        } else {
          // 🔧 CORREGIDO: Con filtros de curso/sección, también mostrar período académico completo
          // en lugar de solo los últimos 45 días
          const march1 = new Date(year, 2, 1); // Mes 2 = Marzo
          march1.setHours(0, 0, 0, 0);
          fromTs = march1.getTime();
          toTs = nowTs;
        }
      }
    }

    // Ajuste: Período académico completo
    // Queremos que el gráfico muestre desde Marzo hasta Diciembre (o hasta hoy si es año actual)
    // 🔧 CORREGIDO: Mostrar todo el año académico, no solo hasta hoy
    if (!filters?.semester && period === 'all') {
      const today = new Date();
      const march1 = new Date(year, 2, 1); // Mes 2 = Marzo
      march1.setHours(0, 0, 0, 0);
      
      // Si aún no llegamos a marzo en el año actual, usar desde enero
      const start = (year === today.getFullYear() && today.getTime() < march1.getTime()) 
        ? new Date(year, 0, 1) 
        : march1;
      start.setHours(0, 0, 0, 0);
      
      // Fin: Para año actual usar hoy, para años pasados usar 31 de diciembre
      let end: Date;
      if (year === today.getFullYear()) {
        end = new Date(today);
      } else {
        // Para años pasados, mostrar hasta el 31 de diciembre
        end = new Date(year, 11, 31); // Mes 11 = Diciembre, día 31
      }
      end.setHours(23, 59, 59, 999);
      
      fromTs = start.getTime();
      toTs = end.getTime();
    }

    // Config calendario
    type VacationRange = { start?: string; end?: string };
    type CalendarYearConfig = { showWeekends: boolean; summer: VacationRange; winter: VacationRange; holidays: string[] };
    const getCalCfg = (year: number): CalendarYearConfig => {
      const def: CalendarYearConfig = { showWeekends: true, summer: {}, winter: {}, holidays: [] };
      try {
        const raw = localStorage.getItem(`admin-calendar-${year}`);
        if (!raw) return def;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return { ...def, ...parsed } as CalendarYearConfig;
        return def;
      } catch { return def; }
    };
    const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const inRangeLocal = (date: Date, range?: VacationRange) => {
      if (!range?.start || !range?.end) return false;
      const parseYmdLocal = (ymd: string) => {
        const [y,m,d] = ymd.split('-').map(Number);
        return new Date(y, (m||1)-1, d||1);
      };
      const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const a = parseYmdLocal(range.start).getTime();
      const b = parseYmdLocal(range.end).getTime();
      const [min,max] = a<=b ? [a,b] : [b,a];
      return t>=min && t<=max;
    };

    // Días válidos (L-V) excluyendo vacaciones/feriados
    const validDays: Date[] = [];
    const d = new Date(fromTs); d.setHours(0,0,0,0);
    const end = new Date(toTs); end.setHours(0,0,0,0);
    while (d <= end) {
      const cfg = getCalCfg(d.getFullYear());
      const dow = d.getDay();
      const weekday = dow>=1 && dow<=5;
      const holiday = cfg.holidays.includes(keyOf(d));
      const summer = inRangeLocal(d, cfg.summer);
      const winter = inRangeLocal(d, cfg.winter);
      if (weekday && !holiday && !summer && !winter) validDays.push(new Date(d));
      d.setDate(d.getDate()+1);
    }

    const dayMs = days(1);
    const buckets: { from: number; to: number; date: Date }[] = validDays.map(dt => ({ from: dt.getTime(), to: dt.getTime()+dayMs, date: dt }));
    const isInBucket = (ts: number, b: { from: number; to: number }) => ts >= b.from && ts < b.to;

    // Helpers de datos - USANDO MISMO PATRÓN QUE AttendanceTrendCard con optimizaciones
    const read = (k: string): any[] => { 
      return getCachedData(k, () => {
        try { 
          return JSON.parse(localStorage.getItem(k) || '[]'); 
        } catch { 
          return []; 
        }
      }, CACHE_TTL);
    };
    
    // 🔧 PRIORIDAD: IndexedDB/SQL primero, localStorage como fallback
    let attendance: any[] = [];
    
    // 1. Intentar primero desde IndexedDB/SQL (fuente principal)
    if (sqlAttendance && Array.isArray(sqlAttendance[year]) && sqlAttendance[year].length > 0) {
      attendance = sqlAttendance[year];
      console.log(`[CourseComparison] Usando ${attendance.length} registros de IndexedDB/SQL para año ${year}`);
    }
    
    // 2. Fallback a localStorage solo si IndexedDB está vacío
    if (attendance.length === 0) {
      try { 
        const { LocalStorageManager } = require('@/lib/education-utils'); 
        const lsData = LocalStorageManager.getAttendanceForYear(year) || [];
        if (Array.isArray(lsData) && lsData.length > 0) {
          attendance = lsData;
          console.log(`[CourseComparison] Fallback: Usando ${attendance.length} registros de LocalStorage para año ${year}`);
        }
      } catch { 
        /* ignore */ 
      }
    }
    
    // 3. Fallback adicional a localStorage directo
    if (attendance.length === 0) {
      try {
        attendance = JSON.parse(localStorage.getItem(`smart-student-attendance-${year}`) || '[]');
        if (attendance.length > 0) {
          console.log(`[CourseComparison] Fallback: Usando ${attendance.length} registros de localStorage directo para año ${year}`);
        }
      } catch {
        attendance = [];
      }
    }
    
    // Si no hay datos específicos del año, filtrar datos globales por año
    if (!Array.isArray(attendance) || attendance.length === 0) {
      try {
        const globalAttendance = read('smart-student-attendance');
        if (Array.isArray(globalAttendance)) {
          attendance = globalAttendance.filter(r => {
            const v = r.timestamp || r.date || r.when;
            let ts = 0;
            if (typeof v === 'number') ts = v; 
            else if (typeof v === 'string') {
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) ts = new Date(v + 'T00:00:00').getTime();
              else if (/^\d{2}-\d{2}-\d{4}$/.test(v)) { 
                const [dd,mm,yyyy] = v.split('-').map(Number); 
                ts = new Date(yyyy,(mm||1)-1,dd||1).getTime(); 
              }
              else { const t = Date.parse(v); if (!isNaN(t)) ts = t; }
            }
            if (!ts) return false;
            return new Date(ts).getFullYear() === year;
          });
        }
      } catch { /* ignore */ }
    }
    
    // Cargar submissions por año (similar a asistencia)
    let submissions: any[] = [];
    try { 
      const { LocalStorageManager } = require('@/lib/education-utils'); 
      submissions = LocalStorageManager.getSubmissionsForYear(year) || []; 
      
      // DEBUG: Log para verificar datos cargados
      if (typeof window !== 'undefined') {
        
        // Verificar si tienen calificaciones
        const withGrades = submissions.filter(s => (typeof s.grade === 'number' || typeof s.score === 'number'));
        if (withGrades.length > 0) {
        }
      }
    } catch { 
      submissions = JSON.parse(localStorage.getItem(`smart-student-submissions-${year}`) || '[]'); 
      if (typeof window !== 'undefined') {
      }
    }
    
    // Si no hay datos específicos del año, filtrar datos globales por año
    if (!Array.isArray(submissions) || submissions.length === 0) {
      try {
        const globalSubmissions = read('smart-student-submissions');
        if (typeof window !== 'undefined') {
        }
        
        if (Array.isArray(globalSubmissions)) {
          submissions = globalSubmissions.filter(s => {
            const createdAt = s.createdAt || s.timestamp || s.when || s.date;
            let ts = 0;
            if (typeof createdAt === 'number') ts = createdAt; 
            else if (typeof createdAt === 'string') {
              if (/^\d{4}-\d{2}-\d{2}/.test(createdAt)) ts = new Date(createdAt).getTime();
              else if (/^\d{2}-\d{2}-\d{4}$/.test(createdAt)) { 
                const [dd,mm,yyyy] = createdAt.split('-').map(Number); 
                ts = new Date(yyyy,(mm||1)-1,dd||1).getTime(); 
              }
              else { const t = Date.parse(createdAt); if (!isNaN(t)) ts = t; }
            }
            if (!ts) return false;
            return new Date(ts).getFullYear() === year;
          });
          
          if (typeof window !== 'undefined') {
            if (submissions.length > 0) {
              const withGrades = submissions.filter(s => (typeof s.grade === 'number' || typeof s.score === 'number'));
            }
          }
        }
      } catch { /* ignore */ }
    }
    
    // Usar el año seleccionado como pivote para buscar datos en claves segmentadas - CON CACHE
  const yearSuffixes = [year-1, year, year+1];
    // Solo considerar claves por año; sin fallback a legacy
    const collectYearData = (base:string) => {
      const cacheKey = `${base}-years-${year}`;
      return getCachedData(cacheKey, () => {
        const out:any[] = [];
        yearSuffixes.forEach(y=>{ 
          try { 
            const arr = JSON.parse(localStorage.getItem(`${base}-${y}`) || '[]'); 
            if (Array.isArray(arr)) out.push(...arr); 
          } catch {} 
        });
        return out;
      });
    };
    
    let courses = [...collectYearData('smart-student-admin-courses'), ...collectYearData('smart-student-courses')];
    let sections = [...collectYearData('smart-student-admin-sections'), ...collectYearData('smart-student-sections')];
    
    // Fallback a claves legacy sin año si no hay datos para el año seleccionado
    if (courses.length === 0) {
      const cacheKey = `legacy-courses`;
      courses = getCachedData(cacheKey, () => {
        try {
          const admin = JSON.parse(localStorage.getItem('smart-student-admin-courses') || '[]');
          const user = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
          if (Array.isArray(admin) || Array.isArray(user)) return [...(admin||[]), ...(user||[])];
          return [];
        } catch { return []; }
      });
    }
    if (sections.length === 0) {
      const cacheKey = `legacy-sections`;
      sections = getCachedData(cacheKey, () => {
        try {
          const admin = JSON.parse(localStorage.getItem('smart-student-admin-sections') || '[]');
          const user = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
          if (Array.isArray(admin) || Array.isArray(user)) return [...(admin||[]), ...(user||[])];
          return [];
        } catch { return []; }
      });
    }
    // Normalización de nivel para cursos antiguos ("básico", "medio", mayúsculas, etc.)
    const normTxt = (s?: string) => (s||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const normalizeCourseLevel = (c:any): Level | undefined => {
      const lv = normTxt(c?.level);
      const name = normTxt(c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name);
      const id = normTxt(c?.id || c?.courseId);
      const allText = `${lv} ${name} ${id}`;
      
      // Detectar indicadores con regex más flexible
      // b[aá]?sic[oa] matchea: basica, basico, bsico, bsica, básica, básico
      const hasBasicaIndicator = /b[aá]?sic[oa]|primaria|primary/i.test(allText);
      const hasMediaIndicator = /medi[oa]|secundaria|secondary|high/i.test(allText);
      
      // Priorizar indicadores explícitos
      if (hasBasicaIndicator && !hasMediaIndicator) return 'basica';
      if (hasMediaIndicator && !hasBasicaIndicator) return 'media';
      
      // Si hay ambos, usar el del campo level primero
      if (/b[aá]?sic[oa]/i.test(lv)) return 'basica';
      if (/medi[oa]|secundaria|secondary|high/i.test(lv)) return 'media';
      
      // Inferir por número si no hay indicadores claros
      const m = allText.match(/(\d{1,2})/); const n = m ? parseInt(m[1],10) : undefined;
      if (typeof n === 'number') {
        // Solo inferir por número si no hay indicadores contradictorios
        if (n >= 1 && n <= 8 && !hasMediaIndicator) return 'basica';
        if (n >= 9 && n <= 12) return 'media';
        // Para media con grados 1-4, necesita indicador explícito
        if (n >= 1 && n <= 4 && hasMediaIndicator) return 'media';
      }
      return undefined;
    };
    const levelByCourseId: Record<string, Level | undefined> = {}; courses.forEach((c:any)=>{ if (c?.id) levelByCourseId[String(c.id)] = normalizeCourseLevel(c); });
    const csOf = (obj:any): { courseId?: string; sectionId?: string } => {
      const cs = obj?.courseSectionId || obj?.course;
      let result;
      
      if (typeof cs === 'string' && cs.includes('-')) { 
        const parts = cs.split('-'); 
        result = { courseId: parts.slice(0,-1).join('-'), sectionId: parts.at(-1) };
      } else {
        result = { courseId: String(obj?.courseId || obj?.course || ''), sectionId: String(obj?.sectionId || obj?.section || '') };
      }
      
      // DEBUG: Log específico para registros del 29 de agosto
      if (typeof window !== 'undefined' && obj.date && String(obj.date).includes('29-08-2025')) {
      }
      
      return result;
    };
    
    // Función auxiliar para normalizar IDs para comparación flexible
    const normId = (id: string | undefined): string => {
      if (!id) return '';
      return String(id)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_')
        .replace(/-/g, '_')
        .replace(/_+/g, '_')
        .trim();
    };
    
    // Definir getCourseMeta antes de usarlo
    const getCourseMeta = (courseId?: string) => courses.find((c:any)=> String(c?.id) === String(courseId));
    
    // Obtener metadatos del curso filtrado para matching por nombre
    const filterCourseMeta = filters?.courseId ? getCourseMeta(filters.courseId) : null;
    const filterCourseNameLower = filterCourseMeta 
      ? (filterCourseMeta.gradeName || filterCourseMeta.name || filterCourseMeta.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      : '';
    const filterCourseIdNorm = normId(filters?.courseId);
    
    const matchFilters = (obj:any): boolean => {
      const { courseId, sectionId } = csOf(obj);
      
      if (filters?.courseId) {
        const objIdNorm = normId(courseId);
        // También obtener nombre del curso del objeto para matching alternativo
        const objCourseName = (obj.course || obj.courseName || obj.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        // Obtener courseSectionId para matching adicional
        const objCourseSectionId = (obj.courseSectionId || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        // Match por ID normalizado O por nombre O por courseSectionId
        const matchById = objIdNorm === filterCourseIdNorm;
        const matchByName = filterCourseNameLower && (objCourseName.includes(filterCourseNameLower) || filterCourseNameLower.includes(objCourseName));
        const matchBySectionId = filterCourseNameLower && objCourseSectionId.includes(filterCourseNameLower);
        
        // 🔧 NUEVO: Match fuzzy (sin vocales para manejar "bsico" vs "basico")
        const normalizeForFuzzy = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[aeiou]/g, '').replace(/[-_\s]+/g, '');
        const filterFuzzy = normalizeForFuzzy(filterCourseNameLower || '');
        const objNameFuzzy = normalizeForFuzzy(objCourseName);
        const objSectionIdFuzzy = normalizeForFuzzy(objCourseSectionId);
        const matchByFuzzy = filterFuzzy && (objNameFuzzy.includes(filterFuzzy) || objSectionIdFuzzy.includes(filterFuzzy));
        
        // 🔧 NUEVO: Match por grado + nivel
        const extractInfo = (str: string) => {
          const norm = str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const gradeMatch = norm.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
          const gradeNum = gradeMatch ? parseInt(gradeMatch[1]) : null;
          let level: string | null = null;
          if (/b[aá]?sic[oa]|primaria/i.test(norm)) level = 'basica';
          else if (/medi[oa]|secundaria/i.test(norm)) level = 'media';
          return { gradeNum, level };
        };
        const filterInfo = extractInfo(filterCourseNameLower || filters?.courseId || '');
        const objInfo = extractInfo(`${objCourseName} ${objCourseSectionId}`);
        const matchByGradeLevel = filterInfo.gradeNum && objInfo.gradeNum && 
          filterInfo.gradeNum === objInfo.gradeNum && 
          filterInfo.level === objInfo.level;
        
        if (!matchById && !matchByName && !matchBySectionId && !matchByFuzzy && !matchByGradeLevel) return false;
      }
      if (filters?.sectionId) {
        // 🔧 MEJORADO: Matching flexible para sectionId
        const objSectionId = String(sectionId || '').toLowerCase().trim();
        const filterSectionId = String(filters.sectionId).toLowerCase().trim();
        
        // Match exacto
        if (objSectionId === filterSectionId) {
          // OK, pasa
        } else {
          // Obtener metadata de la sección para comparar por nombre
          const secMeta = getSectionMeta(filters.sectionId);
          const filterSectionName = secMeta 
            ? (secMeta.name || secMeta.sectionName || secMeta.section || secMeta.displayName || secMeta.label || '')
                .toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
            : '';
          
          // Match por nombre de sección
          const objSectionName = (obj.section || obj.sectionName || '').toLowerCase().trim();
          const matchBySectionName = filterSectionName && (
            objSectionName === filterSectionName ||
            objSectionId === filterSectionName ||
            objSectionName.includes(filterSectionName) ||
            filterSectionName.includes(objSectionName)
          );
          
          // Match por suffix en courseSectionId (ej: "1ro-basico-a" termina en "-a")
          const courseSectionId = (obj.courseSectionId || '').toLowerCase().trim();
          const matchBySuffix = filterSectionName && (
            courseSectionId.endsWith('-' + filterSectionName) ||
            courseSectionId.endsWith('_' + filterSectionName) ||
            courseSectionId.endsWith(' ' + filterSectionName)
          );
          
          // 🔧 NUEVO: Si el registro ya pasó el filtro de courseId y no tiene sectionId,
          // asumir que pertenece a la sección correcta (para datos sin sectionId explícito)
          const hasNoClearSection = !objSectionId && !objSectionName && !courseSectionId.match(/[-_\s][a-z]$/i);
          const matchByAssociation = hasNoClearSection && filters?.courseId;
          
          if (!matchBySectionName && !matchBySuffix && !matchByAssociation) return false;
        }
      }
      if (filters?.level) {
        // Primero intentar con levelByCourseId
        let lvl = courseId ? levelByCourseId[String(courseId)] : undefined;
        
        // Si no está en el mapa, inferir desde el texto del curso
        if (!lvl) {
          const courseText = [obj.course, obj.courseId, obj.courseName, obj.courseSectionId, obj.gradeName, courseId]
            .filter(Boolean).join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          const hasBasicaIndicator = /b[aá]?sic[oa]|primaria|primary/i.test(courseText);
          const hasMediaIndicator = /medi[oa]|secundaria|secondary|high/i.test(courseText);
          
          if (hasBasicaIndicator && !hasMediaIndicator) {
            lvl = 'basica';
          } else if (hasMediaIndicator && !hasBasicaIndicator) {
            lvl = 'media';
          } else {
            // Inferir por número de grado
            const gradeMatch = courseText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
            if (gradeMatch) {
              const grade = parseInt(gradeMatch[1]);
              if (grade >= 1 && grade <= 8 && !hasMediaIndicator) lvl = 'basica';
              else if (grade >= 9 && grade <= 12) lvl = 'media';
              else if (grade >= 1 && grade <= 4 && hasMediaIndicator) lvl = 'media';
            }
          }
        }
        
        if (lvl !== filters.level) return false;
      }
      return true;
    };
    const norm100 = (s:any) => {
      const raw = typeof s.grade === 'number' ? s.grade : (typeof s.score === 'number' ? s.score : undefined);
      return toPercentFromConfigured(raw);
    };
    const parseDateAny = (s: any): number => {
      return parseTimestampOptimized(s);
    };

    // Nombres de meses para el eje X
    const monthNamesShortES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const monthNamesShortEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthShort = language === 'en' ? monthNamesShortEN : monthNamesShortES;
    
    // Generar etiquetas del eje X en formato DD/Mes/YY (ej: 03/Mar/25)
    const labels: string[] = buckets.map(b => { 
      const d = new Date(b.from); 
      const day = String(d.getDate()).padStart(2,'0');
      const month = monthShort[d.getMonth()];
      const yr = String(d.getFullYear()).slice(-2);
      return `${day}/${month}/${yr}`; 
    });

    // Scopes según filtros: determinan series paralelas
  type Scope = { label: string; courseIds?: string[]; courseNames?: string[]; sectionIds?: string[]; sectionNames?: string[]; levelTag?: Level; gradeNum?: number };
    // getCourseMeta ya está definido arriba
    const getSectionMeta = (sectionId?: string) => sections.find((s:any)=> String(s?.id || s?.sectionId) === String(sectionId));
  const courseLabelOf = (c:any) => c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || t('course','Curso');
    const secNameOf = (s:any) => (s?.fullName || s?.displayName || s?.longName || s?.label || s?.name || '').replace(/.*\bSecci[óo]n\s*/i, '') || '—';
    const ordinalBasica = (n:number) => ({1:'1ero',2:'2do',3:'3ro',4:'4to',5:'5to',6:'6to',7:'7mo',8:'8vo'} as Record<number,string>)[n] || `${n}º`;
    const ordinalMedia = (n:number) => ({1:'1ro',2:'2do',3:'3ro',4:'4to'} as Record<number,string>)[n] || `${n}º`;
    const getCourseGradeNum = (courseId?: string): number | undefined => {
      const c = getCourseMeta(courseId);
      const name: string = c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || '';
      const m = name.match(/(\d{1,2})/); const n = m ? parseInt(m[1],10) : undefined; return n;
    };

    let scopes: Scope[] = [];
  if (filters?.sectionId) {
      const sec = getSectionMeta(filters.sectionId);
      // Obtener courseId de la sección o del filtro de curso si está disponible
      const courseIdFromSection = sec?.courseId || (sec?.course && (sec.course.id || sec.courseId));
      const courseIdToUse = filters?.courseId || courseIdFromSection;
      const course = courseIdToUse ? getCourseMeta(courseIdToUse) : null;
      
      // 🔧 CORRECCIÓN CRÍTICA: Usar sectionLetter del filtro si está disponible
      // Esto es necesario cuando hay IDs duplicados (ambas secciones tienen el mismo UUID)
      const sectionLetterFromFilter = filters?.sectionLetter 
        ? String(filters.sectionLetter).toLowerCase().trim()
        : '';
      
      // Fallback: extraer del metadata solo si no viene del filtro
      const sectionLetterFromMeta = sec 
        ? (sec.name || sec.section || sec.label || sec.sectionName || '')
            .toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
        : '';
      
      // Priorizar la letra del filtro sobre el metadata
      const sectionLetter = sectionLetterFromFilter || sectionLetterFromMeta;
      
      // Usar la letra de sección para el label si está disponible
      const sectionDisplayName = sectionLetter.toUpperCase() || secNameOf(sec);
      const label = `${courseLabelOf(course)} ${sectionDisplayName}`.trim();
      
      // 🔧 CORRECCIÓN: Incluir courseIds, courseNames Y sectionNames en el scope para matching flexible
      const courseNameLower = course 
        ? (course.gradeName || course.name || course.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        : '';
      
      scopes = [{ 
        label, 
        sectionIds: [String(filters.sectionId)],
        sectionNames: sectionLetter ? [sectionLetter] : [],  // 🔧 USAR la letra correcta
        courseIds: courseIdToUse ? [String(courseIdToUse)] : [],
        courseNames: courseNameLower ? [courseNameLower] : []
      }];
      
      // DEBUG: Log para verificar scope de sección
      if (typeof window !== 'undefined') {
      }
    } else if (filters?.courseId) {
      // MEJORA: Cuando hay filtro de curso, crear scopes por secciones
      // Primero buscar secciones en el catálogo
      let secs = sections.filter((s:any)=> {
        const secCourseId = String(s?.courseId || s?.course?.id || '');
        const filterCourseId = String(filters.courseId);
        // Comparar por ID directo o normalizado
        if (secCourseId === filterCourseId) return true;
        // También comparar normalizando ambos IDs
        const normSec = normId(secCourseId);
        const normFilter = normId(filterCourseId);
        if (normSec && normFilter && normSec === normFilter) return true;
        return false;
      });
      
      const c = getCourseMeta(filters.courseId);
      const courseLabel = courseLabelOf(c) || String(filters.courseId).replace(/[-_]/g, ' ');
      // 🔧 MEJORADO: Usar courseId como fallback si no hay metadata del curso
      let courseNameLower = (c?.gradeName || c?.name || c?.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!courseNameLower && filters.courseId) {
        // Convertir courseId a nombre legible: "1ro_medio" -> "1ro medio"
        courseNameLower = String(filters.courseId).toLowerCase().replace(/[-_]/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
      
      // 🔥 DEBUG: Ver qué valores tenemos para el matching
      if (typeof window !== 'undefined') {
        console.log('🔍 [SCOPES INIT] Buscando secciones para curso:', {
          filterId: filters.courseId,
          courseMeta: c ? { id: c.id, name: c.name, gradeName: c.gradeName } : null,
          courseLabel,
          courseNameLower,
          secsFromCatalog: secs.length
        });
      }
      
      // Si no hay secciones en el catálogo, intentar extraerlas de los datos
      // Esto es útil cuando los datos vienen de Firebase/SQL con estructura diferente
      if (secs.length === 0 && typeof window !== 'undefined') {
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          const uniqueSections = new Map<string, { id: string; name: string }>();
          
          // 🔧 NUEVO: Buscar PRIMERO en datos de SQL/IndexedDB si están disponibles
          // Esto es necesario porque los datos de carga masiva van a SQL, no a localStorage
          if (isSQLConnected && sqlGrades && Array.isArray(sqlGrades[year]) && sqlGrades[year].length > 0) {
            const sqlGradesYear = sqlGrades[year];
            
            // 🔥 DEBUG: Mostrar primeros registros para ver su estructura
            console.log(`🔍 [SCOPES] Buscando secciones en ${sqlGradesYear.length} calificaciones de SQL para curso: "${courseNameLower}" (filterId: ${filters.courseId})`);
            console.log('📋 [SCOPES] Primeros 3 registros SQL:', sqlGradesYear.slice(0, 3).map((g: any) => ({
              courseId: g.courseId,
              sectionId: g.sectionId,
              section: g.section,
              courseSectionId: g.courseSectionId,
              courseName: g.courseName
            })));
            
            // Contar matches para debug
            let matchCount = 0;
            console.log(`🔍 [SCOPES] Buscando secciones en ${sqlGradesYear.length} calificaciones de SQL para curso: ${courseNameLower || filters.courseId}`);
            
            sqlGradesYear.forEach((g: any) => {
              const gCourseId = g.courseId || g.course || '';
              const gCourseName = (g.courseName || g.course || g.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const gCourseSectionId = g.courseSectionId || '';
              
              const matchById = normId(gCourseId) === normId(filters.courseId);
              const matchByName = courseNameLower && gCourseName.includes(courseNameLower);
              const matchByCombined = gCourseSectionId.toLowerCase().includes(courseNameLower);
              
              // También matchear si el courseId del registro coincide con el nombre del curso (ej: "1ro_bsico" vs "1ro Básico")
              const gIdReadable = gCourseId.toLowerCase().replace(/[-_]/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const filterNameReadable = courseNameLower.replace(/[-_]/g, ' ');
              const matchByReadableName = gIdReadable && filterNameReadable && (
                gIdReadable.includes(filterNameReadable) || 
                filterNameReadable.includes(gIdReadable) ||
                // Match fuzzy sin vocales
                gIdReadable.replace(/[aeiou]/g, '') === filterNameReadable.replace(/[aeiou]/g, '')
              );
              
              if (matchById || matchByName || matchByCombined || matchByReadableName) {
                matchCount++;
                let secId = g.sectionId || g.section || '';
                let secName = g.sectionName || g.section || '';
                
                // Si sectionId es solo una letra (a, b, c), normalizar a mayúscula
                if (secId && secId.length === 1 && /^[a-zA-Z]$/.test(secId)) {
                  secId = secId.toUpperCase();
                  secName = secId;
                }
                
                if (!secId && gCourseSectionId) {
                  const parts = gCourseSectionId.split(/[-_]/);
                  if (parts.length > 1) {
                    secId = parts[parts.length - 1].trim().toUpperCase();
                    secName = secId;
                  }
                }
                
                if (secId && !uniqueSections.has(secId)) {
                  uniqueSections.set(secId, { id: secId, name: secName || secId });
                }
              }
            });
            
            console.log(`🔍 [SCOPES] Registros que matchearon: ${matchCount} de ${sqlGradesYear.length}`);
            console.log(`🔍 [SCOPES] Secciones encontradas en SQL: ${[...uniqueSections.keys()].join(', ') || 'ninguna'}`);
          }
          
          // Buscar en datos de asistencia
          const yearAttendance = LocalStorageManager.getAttendanceForYear(year) || [];
          yearAttendance.forEach((r: any) => {
            // Verificar si el registro pertenece al curso filtrado
            const rCourseId = r.courseId || r.course || '';
            const rCourseName = (r.courseName || r.course || r.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const rCourseSectionId = r.courseSectionId || '';
            
            // Match por ID o nombre
            const matchById = normId(rCourseId) === normId(filters.courseId);
            const matchByName = courseNameLower && rCourseName.includes(courseNameLower);
            const matchByCombined = rCourseSectionId.toLowerCase().includes(courseNameLower);
            
            if (matchById || matchByName || matchByCombined) {
              // Extraer sección
              let secId = r.sectionId || r.section || '';
              let secName = r.sectionName || r.section || '';
              
              // Si no hay sectionId explícito, intentar extraer del courseSectionId (ej: "1ro Básico-A" -> "A")
              if (!secId && rCourseSectionId) {
                const parts = rCourseSectionId.split(/[-_]/);
                if (parts.length > 1) {
                  secId = parts[parts.length - 1].trim();
                  secName = secId;
                }
              }
              
              if (secId && !uniqueSections.has(secId)) {
                uniqueSections.set(secId, { id: secId, name: secName || secId });
              }
            }
          });
          
          // También buscar en datos de calificaciones de localStorage (fallback)
          if (uniqueSections.size === 0) {
            const yearGrades = LocalStorageManager.getTestGradesForYear(year) || [];
            yearGrades.forEach((g: any) => {
              const gCourseId = g.courseId || g.course || '';
              const gCourseName = (g.courseName || g.course || g.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const gCourseSectionId = g.courseSectionId || '';
              
              const matchById = normId(gCourseId) === normId(filters.courseId);
              const matchByName = courseNameLower && gCourseName.includes(courseNameLower);
              const matchByCombined = gCourseSectionId.toLowerCase().includes(courseNameLower);
              
              if (matchById || matchByName || matchByCombined) {
                let secId = g.sectionId || g.section || '';
                let secName = g.sectionName || g.section || '';
                
                if (!secId && gCourseSectionId) {
                  const parts = gCourseSectionId.split(/[-_]/);
                  if (parts.length > 1) {
                    secId = parts[parts.length - 1].trim();
                    secName = secId;
                  }
                }
                
                if (secId && !uniqueSections.has(secId)) {
                  uniqueSections.set(secId, { id: secId, name: secName || secId });
                }
              }
            });
          }
          
          // Convertir a array de secciones
          if (uniqueSections.size > 0) {
            secs = Array.from(uniqueSections.values()).map(s => ({
              id: s.id,
              sectionId: s.id,
              name: s.name,
              courseId: filters.courseId
            }));
            console.log(`✅ [SCOPES] ${secs.length} secciones extraídas de datos: ${secs.map(s => s.name).join(', ')}`);
          }
        } catch (err) {
          console.warn('Error extrayendo secciones de datos:', err);
        }
      }
      
      if (secs.length > 0) {
        // Si hay secciones, crear un scope por cada sección
        // 🔧 MEJORA: Mostrar nombre completo "1ro Básico A" en lugar de solo "A"
        scopes = secs.map((s:any)=> {
          const sectionLetter = secNameOf(s) || s.name || s.id || '—';
          const fullLabel = courseLabel ? `${courseLabel} ${sectionLetter}`.trim() : sectionLetter;
          // 🔧 CORRECCIÓN: Incluir sectionNames para matching consistente con filtro de sección
          const sectionNameLower = sectionLetter.toLowerCase().trim();
          return { 
            label: fullLabel,
            sectionIds: [String(s?.id || s?.sectionId)],
            sectionNames: sectionNameLower ? [sectionNameLower] : [],  // ← AGREGADO para matching consistente
            courseIds: [String(filters.courseId)],
            courseNames: courseNameLower ? [courseNameLower] : [] // Incluir nombre para matching
          };
        });
      } else {
        // Si NO hay secciones definidas, crear UN SOLO scope que filtre por courseId
        // Esto permite mostrar datos aunque no haya secciones cargadas en el sistema
        scopes = [{ 
          label: courseLabel || t('selectedCourse', 'Curso Seleccionado'), 
          courseIds: [String(filters.courseId)],
          courseNames: courseNameLower ? [courseNameLower] : [] // Incluir nombre para matching
        }];
      }
      
      // DEBUG: Log para verificar scopes creados
      if (typeof window !== 'undefined') {
      }
    } else if (filters?.level) {
      // CORREGIDO: Cuando hay filtro de nivel, crear DOS scopes:
      // 1. Un scope para el nivel filtrado que muestra datos por grado
      // 2. Opcionalmente comparar con el otro nivel
      // Para simplificar y asegurar que se muestren datos, crear scopes por grado del nivel seleccionado
      const range = filters.level === 'basica' ? Array.from({length:8},(_,i)=>i+1) : Array.from({length:4},(_,i)=>i+1);
      
      // Buscar courseIds que coincidan con el nivel (usando múltiples estrategias)
      const levelCourseIds = courses.filter((c:any)=> {
        const courseLevel = normalizeCourseLevel(c);
        return courseLevel === filters.level;
      }).map((c:any)=> String(c.id));
      
      scopes = range.map(n => {
        const label = filters.level === 'basica' ? ordinalBasica(n) : ordinalMedia(n);
        // Buscar cursos específicos de este grado
        const cids = courses.filter((c:any)=> {
          const courseLevel = normalizeCourseLevel(c);
          const gradeNum = getCourseGradeNum(c?.id);
          return courseLevel === filters.level && gradeNum === n;
        }).map((c:any)=> String(c.id));
        // Incluir gradeNum para poder filtrar por grado específico aunque no haya courseIds
        return { label, courseIds: cids, levelTag: filters.level as Level, gradeNum: n };
      });
      
      // DEBUG: Log para verificar scopes por nivel
      if (typeof window !== 'undefined') {
      }
    } else {
      // Sin filtros dimensionales: mostrar dos series por defecto (Básica y Media)
      // Esto es consistente con el gráfico "Asistencia - Periodo" y permite comparar niveles
      scopes = [ 
        { label: t('levelBasic','Básica'), courseIds: [], levelTag: 'basica' as Level },
        { label: t('levelHigh','Media'), courseIds: [], levelTag: 'media' as Level }
      ];
      
      // DEBUG: Log cuando no hay filtros
      if (typeof window !== 'undefined') {
      }
    }

  const matchScope = (obj:any, scope: Scope): boolean => {
      const { courseId, sectionId } = csOf(obj);
      
      // Si el scope no tiene restricciones (General), matchear todos los registros
      if ((!scope.courseIds || scope.courseIds.length === 0) && 
          (!scope.sectionIds || scope.sectionIds.length === 0) && 
          !scope.levelTag) {
        return true;
      }
      
      // Si el scope tiene levelTag (Básica/Media), inferir nivel del registro
      if (scope.levelTag) {
        // 1. Verificar por courseId en levelByCourseId
        if (courseId && levelByCourseId[String(courseId)] === scope.levelTag) {
          return true;
        }
        
        // 2. Buscar en múltiples campos posibles del registro
        const fieldsToCheck = [
          obj?.courseSectionId,
          obj?.course,
          obj?.courseId,
          obj?.curso,
          obj?.gradeName,
          obj?.grade,
          obj?.level,
          obj?.nivel,
          courseId
        ].filter(Boolean);
        
        const combinedText = fieldsToCheck.join(' ').toLowerCase();
        
        // Detectar indicadores de nivel con regex más flexible
        // b[aá]?sic[oa] matchea: basica, basico, bsico, bsica, básica, básico
        const hasBasicaIndicator = /b[aá]?sic[oa]|primaria|primary/i.test(combinedText);
        const hasMediaIndicator = /medi[oa]|secundaria|secondary|high/i.test(combinedText);
        
        if (scope.levelTag === 'basica') {
          // Detectar patrones de básica
          if (hasBasicaIndicator) return true;
          // Detectar grados 1-8 que no sean media
          const gradeMatch = combinedText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
          if (gradeMatch) {
            const grade = parseInt(gradeMatch[1]);
            if (grade >= 1 && grade <= 8 && !hasMediaIndicator) return true;
          }
        }
        
        if (scope.levelTag === 'media') {
          // Detectar patrones de media
          if (hasMediaIndicator) return true;
          // Detectar grados 9-12 o 1-4 si tiene "medio/media"
          const gradeMatch = combinedText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
          if (gradeMatch) {
            const grade = parseInt(gradeMatch[1]);
            if (grade >= 9 && grade <= 12) return true;
            // Si tiene medio/media explícito con grado 1-4, también es media
            if (grade >= 1 && grade <= 4 && hasMediaIndicator) return true;
          }
        }
        
        // 3. Usar normalizeCourseLevel como fallback
        const inferred = normalizeCourseLevel({ id: courseId, name: combinedText, gradeName: combinedText });
        if (inferred === scope.levelTag) return true;
        
        return false;
      }
      
      // Si no tiene courseId, no puede matchear por courseIds
      if (!courseId && scope.courseIds && scope.courseIds.length) {
        return false;
      }
      
      if (scope.sectionIds && scope.sectionIds.length) {
        // Comparación flexible de sectionId
        const objSectionNorm = String(sectionId || '').toLowerCase().trim();
        
        // Matchear por ID directo
        if (scope.sectionIds.some(id => String(id).toLowerCase().trim() === objSectionNorm)) {
          return true;
        }
        
        // También intentar extraer sección del courseSectionId (ej: "1ro Básico-A" -> "A")
        const courseSectionId = obj?.courseSectionId || '';
        if (courseSectionId) {
          const parts = courseSectionId.split(/[-_\s]/);
          const lastPart = parts[parts.length - 1]?.trim().toLowerCase();
          if (lastPart && scope.sectionIds.some(id => String(id).toLowerCase().trim() === lastPart)) {
            return true;
          }
        }
        
        // Intentar matchear por nombre de sección en el objeto
        const objSectionName = (obj?.sectionName || obj?.section || '').toLowerCase().trim();
        if (objSectionName && scope.sectionIds.some(id => String(id).toLowerCase().trim() === objSectionName)) {
          return true;
        }
        
        return false;
      }
      
      if (scope.courseIds && scope.courseIds.length) {
        // Comparación flexible de courseId
        const objCourseNorm = normId(courseId);
        const objCourseName = (obj?.course || obj?.courseName || obj?.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        const matches = scope.courseIds.some(id => {
          const scopeIdNorm = normId(id);
          // Match por ID normalizado
          if (objCourseNorm && scopeIdNorm && objCourseNorm === scopeIdNorm) return true;
          // Match por nombre de curso
          const scopeCourse = getCourseMeta(id);
          if (scopeCourse) {
            const scopeName = (scopeCourse.gradeName || scopeCourse.name || scopeCourse.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (scopeName && objCourseName.includes(scopeName)) return true;
          }
          return false;
        });
        return matches;
      }
      
      return false;
    };

    // Matching extendido: si no hay courseId en el registro, intenta inferir por nivel de estudiantes presentes
    const matchScopeExtended = (obj:any, scope: Scope, studentLevelMap: Record<string, Level>): boolean => {
      // 1) Intentar match normal por course/section
      if (matchScope(obj, scope)) return true;
      
      // 2) Si el scope es por nivel (Básica/Media), usar múltiples estrategias de inferencia
      if (scope.levelTag) {
        const { courseId } = csOf(obj);
        
        // 2a) Verificar courseId directo en levelByCourseId
        if (courseId && levelByCourseId[String(courseId)] === scope.levelTag) {
          return true;
        }
        
        // 2b) Inferir nivel desde cualquier campo disponible del registro
        const allTexts = [
          obj.courseName, obj.courseSectionId, obj.course, courseId,
          obj.gradeName, obj.sectionName, obj.className, obj.level,
          obj.courseSectionId?.split?.('-')?.[0] // Extraer parte del curso de courseSectionId
        ].filter(Boolean).join(' ').toLowerCase();
        
        // Detectar patrones de básica (1ro-8vo, básica, básico, primary, etc.)
        if (scope.levelTag === 'basica') {
          if (/\b(basica|basico|basic|primaria|primary|elemental)\b/i.test(allTexts)) return true;
          // Detectar grados 1-8 con patrones comunes
          const gradeMatch = allTexts.match(/\b(\d{1,2})(?:ro|do|to|vo|er|°|º|st|nd|rd|th)?\s*(?:basico|basica|grado|grade)?/i);
          if (gradeMatch) {
            const grade = parseInt(gradeMatch[1]);
            if (grade >= 1 && grade <= 8) return true;
          }
          // Patrón específico: "1ro básico A", "2do-A", etc.
          if (/\b[1-8](?:ro|do|er|to|vo)?[\s-]*(?:basico|basica|a|b|c)?\b/i.test(allTexts)) {
            // Verificar que no sea media
            if (!/\b(media|medio|secundaria|secondary|high)\b/i.test(allTexts)) return true;
          }
        }
        
        // Detectar patrones de media (1ro-4to media, secundaria, etc.)
        if (scope.levelTag === 'media') {
          if (/\b(media|medio|secundaria|secondary|high\s*school)\b/i.test(allTexts)) return true;
          // Detectar grados 9-12 o 1ro-4to media
          const gradeMatch = allTexts.match(/\b(\d{1,2})(?:ro|do|to|vo|er|°|º|st|nd|rd|th)?\s*(?:medio|media|grado|grade)?/i);
          if (gradeMatch) {
            const grade = parseInt(gradeMatch[1]);
            if (grade >= 9 && grade <= 12) return true;
            // 1-4 media
            if ((grade >= 1 && grade <= 4) && /\b(media|medio|secundaria)\b/i.test(allTexts)) return true;
          }
        }
        
        // 2c) Revisar lista de estudiantes presentes
        const list: any[] = Array.isArray(obj.presentStudents) ? obj.presentStudents : [];
        if (list.length) {
          for (const ps of list) {
            const pid = String(ps?.studentId || ps?.id || ps?.username || ps).toLowerCase();
            if (!pid) continue;
            const stLevel = studentLevelMap[pid] || (() => { const cid = String(ps?.courseId || obj.courseId || obj.course || ''); return levelByCourseId[cid]; })();
            if (stLevel && stLevel === scope.levelTag) {
              return true;
            }
          }
        }
        
        // 2d) Fallback final: usar normalizeCourseLevel con objeto construido
        const objForNormalize = {
          id: courseId,
          courseId: courseId,
          name: obj.courseName || obj.courseSectionId || obj.course || courseId || '',
          gradeName: obj.gradeName || obj.courseName || '',
          level: obj.level,
          section: obj.sectionId || obj.section
        };
        const inferredLevel = normalizeCourseLevel(objForNormalize);
        if (inferredLevel === scope.levelTag) {
          return true;
        }

        // 2e) Check individual student ID against the map
        const pid = String(obj.studentId || obj.studentUsername || obj.username || obj.user || '').toLowerCase();
        if (pid) {
             const stLevel = studentLevelMap[pid];
             if (stLevel && stLevel === scope.levelTag) return true;
        }
      }
      
      return false;
    };

  let outSeries: Array<{ label: string; values: (number | null)[] }> = scopes.map(s => ({ label: s.label, values: new Array(buckets.length).fill(null) }));
  // Hacer visible fuera del bloque de asistencia para fallback mensual
  let filteredAtt: any[] = [];

    if (comparisonType === 'notas') {
      // 🔥 DEBUG INICIAL: Log los filtros recibidos
      if (typeof window !== 'undefined') {
        const now = Date.now();
      }
      
      // Preferir SQL si está conectado (usar datos SQL aunque estén vacíos); 
      // fallback a LocalStorage SOLO si NO hay conexión SQL
      let testGrades: any[] = [];
      if (isSQLConnected) {
        // 🔧 Cuando hay conexión SQL, usar SOLO datos SQL (puede estar vacío si no hay calificaciones)
        const sqlData = (sqlGrades && Array.isArray(sqlGrades[year])) ? sqlGrades[year] : [];
        testGrades = sqlData.map((g: any) => ({
          ...g,
          gradedAt: typeof g.gradedAt === 'number' ? g.gradedAt : (g.gradedAt ? Date.parse(g.gradedAt) : 0),
          score: typeof g.score === 'number' ? g.score : (typeof g.grade === 'number' ? toPercentFromConfigured(g.grade) : undefined)
        }));
        if (typeof window !== 'undefined') {
          // 🔥 DEBUG: Mostrar qué courseIds únicos hay en las calificaciones
          const uniqueCourseIds = [...new Set(testGrades.map(g => g.courseId))].filter(Boolean);
          if (filters?.courseId) {
            const matchingGrades = testGrades.filter(g => g.courseId === filters.courseId);
          }
        }
      } else {
        try {
          testGrades = LocalStorageManager.getTestGradesForYear(year) || [];
          if (typeof window !== 'undefined') {
            
            // DEBUG: Verificar qué hay en localStorage directamente
            const allKeys = Object.keys(localStorage).filter(k => k.includes('grade') || k.includes('test'));
            
            // Intentar leer directamente la key de calificaciones
            const gradesKey = `testGrades_${year}`;
            const rawData = localStorage.getItem(gradesKey);
            
            if (testGrades.length > 0) {
            } else {
              // Intentar con la key sin año
              const fallbackData = localStorage.getItem('testGrades');
              if (fallbackData) {
                try {
                  const parsed = JSON.parse(fallbackData);
                } catch (e) {
                  console.error('Error parseando testGrades:', e);
                }
              }
            }
          }
        } catch (err) {
          console.warn('Error loading test grades:', err);
        }
      }
      
      // 🔥 DEBUG CRÍTICO: Ver estructura de sectionId en los datos
      if (typeof window !== 'undefined' && testGrades.length > 0) {
        const uniqueSectionIds = [...new Set(testGrades.map(g => g.sectionId))].filter(Boolean);
        const uniqueSections = [...new Set(testGrades.map(g => g.section))].filter(Boolean);
        const uniqueCourseSectionIds = [...new Set(testGrades.map(g => g.courseSectionId))].filter(Boolean);
        console.log('📋 [GRADES DATA] Estructura de secciones en datos:', {
          totalGrades: testGrades.length,
          sectionIds: uniqueSectionIds.slice(0, 10),
          sections: uniqueSections.slice(0, 10),
          courseSectionIds: uniqueCourseSectionIds.slice(0, 10),
          sampleRecord: testGrades[0] ? { 
            sectionId: testGrades[0].sectionId, 
            section: testGrades[0].section, 
            courseId: testGrades[0].courseId 
          } : null
        });
      }
      
      // 🔧 NUEVO: Crear mapa de studentId -> sectionLetter para inferir sección de calificaciones
      // Esto es necesario porque las calificaciones de Firebase no tienen el campo section/sectionId diferenciado
      const studentToSectionMap: Record<string, { sectionId: string; sectionLetter: string }> = {};
      try {
        const { LocalStorageManager } = require('@/lib/education-utils');
        
        // Obtener estudiantes del año
        let studentsArr: any[] = LocalStorageManager.getStudentsForYear?.(year) || [];
        if ((!Array.isArray(studentsArr) || studentsArr.length === 0) && typeof window !== 'undefined') {
          studentsArr = JSON.parse(localStorage.getItem('smart-student-students')||'[]');
        }
        
        // Obtener asignaciones de estudiantes a secciones
        const studentAssignments: any[] = LocalStorageManager.getStudentAssignmentsForYear?.(year) || [];
        
        // Construir mapa desde asignaciones
        studentAssignments.forEach((sa: any) => {
          if (sa.studentId && sa.sectionId) {
            const secMeta = getSectionMeta(sa.sectionId);
            const secLetter = secMeta 
              ? (secMeta.name || secMeta.section || secMeta.label || '').toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
              : '';
            studentToSectionMap[String(sa.studentId).toLowerCase()] = {
              sectionId: String(sa.sectionId),
              sectionLetter: secLetter
            };
          }
        });
        
        // Fallback: construir desde estudiantes con sectionId directo
        if (Array.isArray(studentsArr)) {
          studentsArr.forEach((st: any) => {
            const stId = String(st.id || st.studentId || '').toLowerCase();
            if (stId && st.sectionId && !studentToSectionMap[stId]) {
              const secMeta = getSectionMeta(st.sectionId);
              const secLetter = secMeta 
                ? (secMeta.name || secMeta.section || secMeta.label || '').toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
                : '';
              studentToSectionMap[stId] = {
                sectionId: String(st.sectionId),
                sectionLetter: secLetter
              };
            }
          });
        }
        
        if (typeof window !== 'undefined') {
          if (Object.keys(studentToSectionMap).length > 0) {
            // Contar estudiantes por sección
            const countBySection: Record<string, number> = {};
            Object.values(studentToSectionMap).forEach(v => {
              const letter = v.sectionLetter || 'unknown';
              countBySection[letter] = (countBySection[letter] || 0) + 1;
            });
          } else {
          }
        }
      } catch (err) {
        console.warn('Error creando studentToSectionMap:', err);
      }
      
      // 🔧 DEBUG CRÍTICO: Ver el estado del filtro de sección al inicio
      if (typeof window !== 'undefined' && filters?.sectionId) {
        const sectionMeta = getSectionMeta(filters.sectionId);
      }
      
      // DEBUG: Log rango de fechas
      if (typeof window !== 'undefined') {
      }
      
      // Filtrar por rango de fechas (marzo-diciembre 2025 por defecto)
      const gradedInRange = testGrades.filter(g => {
        const ts = typeof g.gradedAt === 'number' ? g.gradedAt : (g.gradedAt ? Date.parse(g.gradedAt) : undefined);
        if (!ts) return false;
        return ts >= fromTs && ts <= toTs;
      });
      
      // Función auxiliar para normalizar IDs de curso para comparación flexible
      const normalizeCourseIdForCompare = (id: string | undefined): string => {
        if (!id) return '';
        return String(id)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '') // quitar acentos
          .replace(/\s+/g, '-')
          .replace(/_/g, '-')
          .replace(/-+/g, '-')
          .trim();
      };
      
      // Extraer nombre legible del curso de un ID normalizado (ej: "1ro-basico-a" -> "1ro basico a")
      const courseIdToReadable = (id: string | undefined): string => {
        if (!id) return '';
        return String(id)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[-_]+/g, ' ')
          .trim();
      };
      
      // Obtener metadatos del curso filtrado para matching por nombre también
      const filterCourse = filters?.courseId ? getCourseMeta(filters.courseId) : null;
      const filterCourseName = filterCourse ? (filterCourse.gradeName || filterCourse.name || filterCourse.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
      const filterCourseIdNorm = normalizeCourseIdForCompare(filters?.courseId);
      const filterCourseIdReadable = courseIdToReadable(filters?.courseId);
      
      // 🔧 NUEVO: Buscar el curso en el catálogo por UUID para obtener el nombre
      // Esto es necesario cuando el filtro es un UUID pero el metadata no se encontró
      let filterCourseNameFallback = filterCourseName;
      if (!filterCourseNameFallback && filters?.courseId) {
        const courseFromCatalog = courses.find((c: any) => 
          c?.id === filters.courseId || 
          String(c?.id).toLowerCase() === String(filters.courseId).toLowerCase()
        );
        if (courseFromCatalog) {
          filterCourseNameFallback = (courseFromCatalog.gradeName || courseFromCatalog.name || courseFromCatalog.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }
      }
      
      // Debug para ver qué estamos comparando
      if (typeof window !== 'undefined' && filters?.courseId) {
        if (gradedInRange.length > 0) {
        }
      }
      
      // Filtrar por filtros activos - con matching INTELIGENTE
      // 🔥 CORRECCIÓN: Usar nombre del curso desde metadata para matching
      // El filtro viene como UUID pero los datos en Firebase tienen nombres como "1ro_bsico"
      const filteredGrades = gradedInRange.filter(g => {
        // 🔧 NUEVO: Si hay filtro de sección, verificar PRIMERO si la letra de sección coincide
        // Esto es necesario porque los registros de Firebase pueden tener courseId incorrecto
        // (ej: registros de sección B tienen courseId: '1ro_medio' en lugar de '1ro_basico')
        let passedBySectionLetterMatch = false;
        if (filters?.sectionId) {
          // 🔧 CORRECCIÓN CRÍTICA: Priorizar sectionLetter del filtro sobre metadata
          const filterSectionLetterFromProp = filters?.sectionLetter 
            ? String(filters.sectionLetter).toLowerCase().trim()
            : '';
          
          const sectionMetaForCheck = getSectionMeta(filters.sectionId);
          const filterSectionLetterFromMeta = sectionMetaForCheck
            ? (sectionMetaForCheck.name || sectionMetaForCheck.section || sectionMetaForCheck.label || '')
                .toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
            : '';
          
          // PRIORIZAR la letra del filtro
          const filterSectionLetterForCheck = filterSectionLetterFromProp || filterSectionLetterFromMeta;
          
          // Extraer letra de sección del registro
          const recSectionId = String(g.sectionId || '').toLowerCase().trim();
          const recSectionName = (g.section || g.sectionName || '').toLowerCase().trim();
          let recSectionLetter = '';
          
          // Si sectionId es una sola letra (a, b, c)
          if (recSectionId.length === 1 && /^[a-z]$/i.test(recSectionId)) {
            recSectionLetter = recSectionId;
          }
          // Si section/sectionName es una sola letra
          else if (recSectionName.length === 1 && /^[a-z]$/i.test(recSectionName)) {
            recSectionLetter = recSectionName;
          }
          // Buscar en courseSectionId, course, etc.
          else {
            const fieldsToSearch = [g.courseSectionId, g.course, g.courseName, g.courseId].filter(Boolean);
            for (const field of fieldsToSearch) {
              const fieldStr = String(field);
              // Buscar letra al final: "1ro Básico A" -> "a"
              const letterMatch = fieldStr.match(/[-_\s]([A-Z])\s*$/i);
              if (letterMatch) {
                recSectionLetter = letterMatch[1].toLowerCase();
                break;
              }
            }
          }
          
          // Si ambas letras existen y coinciden, marcar como pasado por sección
          if (filterSectionLetterForCheck && recSectionLetter && 
              filterSectionLetterForCheck === recSectionLetter) {
            passedBySectionLetterMatch = true;
          }
        }
        
        if (filters?.courseId) {
          // 🔧 NUEVO: Si ya pasó por coincidencia de letra de sección, saltarse verificación de courseId
          // Esto resuelve el problema donde registros de sección B tienen courseId: '1ro_medio'
          if (passedBySectionLetterMatch) {
            // Confiar en la coincidencia de sección, no verificar courseId
            // (el registro será validado nuevamente en el filtro de sección)
          } else {
            // Verificación normal de courseId
          const gradeIdNorm = normalizeCourseIdForCompare(g.courseId);
          const gradeIdReadable = courseIdToReadable(g.courseId);
          const gradeNameNorm = (g.course || g.courseName || g.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          // Helper para normalizar quitando vocales problemáticas (bsico vs basico)
          const normalizeForFuzzyMatch = (str: string): string => {
            if (!str) return '';
            return str
              .toLowerCase()
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '') // quitar acentos
              .replace(/[aeiou]/g, '') // quitar vocales para matching fuzzy
              .replace(/\s+/g, '')
              .replace(/[-_]/g, '')
              .trim();
          };
          
          // Helper para extraer número de grado de un string
          const extractGradeNumber = (str: string): string | null => {
            if (!str) return null;
            // 🔧 IGNORAR UUIDs - si parece UUID, no extraer números de él
            // UUIDs tienen formato: 8-4-4-4-12 hexadecimales (ej: caddcb86-4299-47c8-bf83-cda368438818)
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim())) {
              return null;
            }
            // Buscar patrones como "1ro", "2do", "3ro", "1°", "2º"
            const match = str.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/i);
            return match ? match[1] : null;
          };
          
          // Helper para extraer nivel (basica/media) de un string
          const extractLevel = (str: string): string | null => {
            if (!str) return null;
            const normalized = str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (/b[aá]?s[ií]?c[oa]|primaria/i.test(normalized)) return 'basica';
            if (/med[ií]?[oa]|secundaria/i.test(normalized)) return 'media';
            return null;
          };
          
          // Match 1: Por ID normalizado exacto
          const matchesById = gradeIdNorm === filterCourseIdNorm;
          
          // Match 2: Por nombre legible exacto
          const matchesByReadable = filterCourseIdReadable && gradeIdReadable && gradeIdReadable === filterCourseIdReadable;
          
          // Match 3: Por nombre de curso exacto (usar fallback si filterCourseName está vacío)
          const effectiveFilterName = filterCourseName || filterCourseNameFallback;
          const matchesByName = effectiveFilterName && gradeNameNorm === effectiveFilterName;
          
          // Match 4: Por ID limpio (sin guiones)
          const gradeIdClean = gradeIdNorm.replace(/-/g, '');
          const filterIdClean = filterCourseIdNorm.replace(/-/g, '');
          const matchesByCleanId = gradeIdClean && filterIdClean && gradeIdClean === filterIdClean;
          
          // 🔥 Match 5: FUZZY - Comparar gradeIdReadable con filterCourseName (del metadata o catálogo)
          // Esto resuelve: "1ro bsico" (datos) vs "1ro basico" (metadata)
          const gradeIdFuzzy = normalizeForFuzzyMatch(gradeIdReadable);
          const filterNameFuzzy = normalizeForFuzzyMatch(effectiveFilterName);
          const matchesByFuzzyName = gradeIdFuzzy && filterNameFuzzy && gradeIdFuzzy === filterNameFuzzy;
          
          // 🔧 Match 6: NUEVO - Comparar gradeIdReadable con effectiveFilterName directamente
          // Esto resuelve: "1ro medio" (datos) vs "1ro Medio" (catálogo)
          const gradeIdReadableNorm = gradeIdReadable.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
          const filterNameReadableNorm = effectiveFilterName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
          const matchesByReadableName = gradeIdReadableNorm && filterNameReadableNorm && gradeIdReadableNorm === filterNameReadableNorm;
          
          // Match 7: INTELIGENTE - comparar número de grado + nivel
          // Esto permite matchear "1ro-basico" con "1ro básico A" pero NO con "2do básico"
          let matchesByGradeAndLevel = false;
          // 🔧 CORRECCIÓN: Priorizar effectiveFilterName sobre filterCourseIdNorm
          // porque filterCourseIdNorm puede ser un UUID que contiene números falsos (ej: "86" en caddcb86)
          const filterGradeNum = extractGradeNumber(effectiveFilterName) || extractGradeNumber(filterCourseIdNorm);
          const filterLevel = extractLevel(effectiveFilterName) || extractLevel(filterCourseIdNorm);
          
          if (filterGradeNum) {
            // Intentar extraer de todos los campos posibles del registro
            const allGradeFields = [g.courseId, g.courseSectionId, g.course, g.courseName, g.gradeName].filter(Boolean).join(' ');
            const gradeGradeNum = extractGradeNumber(allGradeFields);
            const gradeLevel = extractLevel(allGradeFields);
            
            // El número de grado debe coincidir exactamente
            if (gradeGradeNum === filterGradeNum) {
              // Si ambos tienen nivel, deben coincidir; si no, es match
              if (filterLevel && gradeLevel) {
                matchesByGradeAndLevel = filterLevel === gradeLevel;
              } else {
                matchesByGradeAndLevel = true; // Solo coincide el número, pero no hay conflicto de nivel
              }
            }
          }
          
          const isMatch = matchesById || matchesByReadable || matchesByName || matchesByCleanId || matchesByFuzzyName || matchesByReadableName || matchesByGradeAndLevel;
          
          // 🔥 DEBUG: Log detallado para ver los valores calculados
          if (typeof window !== 'undefined' && !g._loggedMatchInfo) {
            g._loggedMatchInfo = true;
            const gIdx = gradedInRange.indexOf(g);
            if (gIdx < 5) {
            }
          }
          
          // 🔥 DEBUG: Log detallado solo para primeros 3 que no matchean
          if (!isMatch && typeof window !== 'undefined') {
            if (!g._loggedNoMatch) {
              g._loggedNoMatch = true;
            }
          }
          
          if (!isMatch) return false;
          } // Cierre del else para verificación de courseId
        }
        if (filters?.sectionId) {
          // Matching flexible para sectionId - también verificar por nombre de sección
          const sectionMeta = getSectionMeta(filters.sectionId);
          
          // 🔧 CORRECCIÓN CRÍTICA: Priorizar sectionLetter del filtro sobre metadata
          // Esto es necesario cuando hay IDs duplicados (ambas secciones tienen el mismo UUID)
          const filterSectionLetterFromProp = filters?.sectionLetter 
            ? String(filters.sectionLetter).toLowerCase().trim()
            : '';
          
          const filterSectionName = sectionMeta 
            ? (sectionMeta.name || sectionMeta.sectionName || sectionMeta.section || sectionMeta.displayName || sectionMeta.label || '')
                .toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
            : '';
          
          // Extraer letra del metadata como fallback
          const filterSectionLetterFromMeta = filterSectionName.length === 1 && /^[a-z]$/i.test(filterSectionName) 
            ? filterSectionName.toLowerCase() 
            : (sectionMeta?.name?.match?.(/^([A-Z])$/i)?.[1]?.toLowerCase() || 
               sectionMeta?.section?.match?.(/^([A-Z])$/i)?.[1]?.toLowerCase() ||
               sectionMeta?.label?.match?.(/^([A-Z])$/i)?.[1]?.toLowerCase() ||
               '');
          
          // 🔧 PRIORIZAR la letra del filtro sobre el metadata
          const filterSectionLetter = filterSectionLetterFromProp || filterSectionLetterFromMeta;
          
          const gradeSecId = String(g.sectionId || '');
          const gradeSectionName = (g.section || g.sectionName || '').toLowerCase().trim();
          
          // 🔧 DEBUG CRÍTICO: Ver los valores de sección
          const gIdx = gradedInRange.indexOf(g);
          if (gIdx < 3 && typeof window !== 'undefined') {
          }
          
          // Match por ID exacto (UUID = UUID)
          const matchesBySectionId = gradeSecId && gradeSecId === String(filters.sectionId);
          
          // 🔧 CORRECCIÓN: Usar filterSectionLetter para el match si está disponible
          // Esto evita usar filterSectionName que puede venir del metadata incorrecto
          const effectiveFilterSection = filterSectionLetter || filterSectionName;
          
          // Match por nombre de sección - SOLO si las secciones coinciden
          const matchesBySectionName = effectiveFilterSection && gradeSectionName && (
            gradeSectionName === effectiveFilterSection
          );
          
          // 🔧 NUEVO: Match por letra de sección (A, B, C, etc.)
          // Esto es importante cuando el registro tiene sectionId como letra
          const gradeSectionLetter = gradeSecId.length === 1 && /^[a-z]$/i.test(gradeSecId) 
            ? gradeSecId.toLowerCase() 
            : (gradeSectionName.length === 1 && /^[a-z]$/i.test(gradeSectionName) 
                ? gradeSectionName.toLowerCase() 
                : '');
          const matchesBySectionLetter = filterSectionLetter && gradeSectionLetter && filterSectionLetter === gradeSectionLetter;
          
          // 🔥 DEBUG DETALLADO: Ver cada variable
          const gIdx2 = gradedInRange.indexOf(g);
          if (gIdx2 < 5 && typeof window !== 'undefined') {
          }
          
          // 🔧 MEJORADO: Extraer sección de múltiples campos con más patrones
          let matchesByCourseSection = false;
          // Buscar en todos los campos posibles que podrían contener la sección
          const allFieldsToCheck = [
            g.courseSectionId,
            g.course,
            g.courseName,
            g.courseId,
            g.gradeName
          ].filter(Boolean);
          
          // Determinar la letra de sección a buscar (priorizar filterSectionLetter sobre filterSectionName)
          const letterToMatch = filterSectionLetter || filterSectionName;
          
          for (const field of allFieldsToCheck) {
            if (matchesByCourseSection) break;
            const fieldStr = String(field);
            
            // Patrón 1: "1ro Básico A" o "1ro_Básico_A" -> buscar última letra separada
            const lastLetterMatch = fieldStr.match(/[-_\s]([A-Z])\s*$/i);
            if (lastLetterMatch && letterToMatch) {
              if (lastLetterMatch[1].toLowerCase() === letterToMatch.toLowerCase()) {
                matchesByCourseSection = true;
                break;
              }
            }
            
            // Patrón 2: "1ro-basico-a" -> última parte después de guión/underscore
            const parts = fieldStr.split(/[-_]/);
            if (parts.length > 1) {
              const lastPart = parts[parts.length - 1].toLowerCase().trim();
              // Solo considerar si es una letra sola (A, B, C, etc.)
              if (lastPart.length === 1 && /^[a-z]$/i.test(lastPart) && letterToMatch) {
                if (lastPart === letterToMatch.toLowerCase()) {
                  matchesByCourseSection = true;
                  break;
                }
              }
            }
            
            // Patrón 3: Buscar la letra de sección en cualquier parte del campo con espacios
            // ej: "1ro Básico A" tiene " A" al final
            const spaceLetterMatch = fieldStr.match(/\s([A-Z])(?:\s|$)/i);
            if (spaceLetterMatch && letterToMatch) {
              if (spaceLetterMatch[1].toLowerCase() === letterToMatch.toLowerCase()) {
                matchesByCourseSection = true;
                break;
              }
            }
          }
          
          // 🔧 NUEVO: Match por studentId -> inferir sección del estudiante
          // Esto resuelve el problema cuando las calificaciones NO tienen campo section/sectionId
          let matchesByStudentSection = false;
          if (!matchesBySectionId && !matchesBySectionName && !matchesBySectionLetter && !matchesByCourseSection) {
            const studentIdKey = String(g.studentId || '').toLowerCase();
            const studentSection = studentToSectionMap[studentIdKey];
            if (studentSection) {
              // Comparar sectionId del estudiante con el filtro
              if (studentSection.sectionId === String(filters.sectionId)) {
                matchesByStudentSection = true;
              }
              // O comparar letra de sección
              else if (letterToMatch && studentSection.sectionLetter === letterToMatch.toLowerCase()) {
                matchesByStudentSection = true;
              }
            }
          }
          
          // 🔧 IMPORTANTE: Si ningún patrón matcheó y los datos NO tienen sección identificable,
          // rechazar el registro para evitar mezclar datos de diferentes secciones
          
          // DEBUG: Log para diagnóstico (solo si NO matcheó por ningún método incluyendo studentSection)
          if (typeof window !== 'undefined' && !matchesBySectionId && !matchesBySectionName && !matchesBySectionLetter && !matchesByCourseSection && !matchesByStudentSection) {
            const studentIdKey = String(g.studentId || '').toLowerCase();
          }
          
          // DEBUG: Log cuando SÍ matchea para entender por qué
          if (typeof window !== 'undefined' && (matchesBySectionId || matchesBySectionName || matchesBySectionLetter || matchesByCourseSection || matchesByStudentSection)) {
            const gIdx = gradedInRange.indexOf(g);
            if (gIdx < 5) {
            }
          }
          
          if (!matchesBySectionId && !matchesBySectionName && !matchesBySectionLetter && !matchesByCourseSection && !matchesByStudentSection) return false;
        }
        
        // 🔥 DEBUG: Ver qué registros pasaron todos los filtros
        if (typeof window !== 'undefined' && filters?.sectionId) {
          const recSecId = String(g.sectionId || '').toLowerCase();
          if (!g._loggedPassed) {
            g._loggedPassed = true;
            const count = gradedInRange.filter(x => x._loggedPassed).length;
            if (count <= 5) {
            }
          }
        }
        
        if (filters?.level) {
          // Primero intentar obtener nivel desde el catálogo de cursos
          let courseLevel = levelByCourseId[String(g.courseId)];
          
          // Si no está en el catálogo, intentar buscar por nombre normalizado del courseId
          if (!courseLevel && g.courseId) {
            // Buscar curso que coincida por ID normalizado
            const gIdNorm = normalizeCourseIdForCompare(g.courseId);
            const matchingCourse = courses.find((c: any) => normalizeCourseIdForCompare(c?.id) === gIdNorm);
            if (matchingCourse) {
              courseLevel = normalizeCourseLevel(matchingCourse);
            }
          }
          
          // Si todavía no hay nivel, inferir desde los campos del registro
          if (!courseLevel) {
            const fieldsToCheck = [
              g?.courseSectionId,
              g?.course,
              g?.courseId,
              g?.courseName,
              g?.gradeName,
              g?.level
            ].filter(Boolean);
            
            const combinedText = fieldsToCheck.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            
            // Detectar básica - usar regex flexible para matchear 'bsico', 'basico', 'básica', etc.
            if (/b[aá]?sic[oa]|primaria|primary/i.test(combinedText)) {
              courseLevel = 'basica';
            } 
            // Detectar media
            else if (/medi[oa]|secundaria|secondary|high/i.test(combinedText)) {
              courseLevel = 'media';
            }
            // Inferir por número de grado
            else {
              const gradeMatch = combinedText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
              if (gradeMatch) {
                const grade = parseInt(gradeMatch[1]);
                if (grade >= 1 && grade <= 8) courseLevel = 'basica';
                else if (grade >= 9 && grade <= 12) courseLevel = 'media';
              }
            }
          }
          
          if (courseLevel !== filters.level) return false;
        }
        return true;
      });
      
      if (typeof window !== 'undefined') {
        console.log(`📊 [GRADES FILTER] ${filteredGrades.length} registros pasaron filtros de ${gradedInRange.length} en rango`);
        
        // 🔥 DEBUG CRÍTICO: Ver las secciones únicas en los registros filtrados
        const uniqueSectionsInFiltered = [...new Set(filteredGrades.map(g => g.sectionId || g.section || 'N/A'))];
        console.log(`📊 [GRADES FILTER] Secciones únicas en filtrados:`, uniqueSectionsInFiltered);
        
        // 🔥 NUEVO: Contar por qué método los registros pasaron el filtro de sección
        if (filters?.sectionId && filteredGrades.length > 0) {
          const matchMethods = { bySectionId: 0, bySectionName: 0, bySectionLetter: 0, byCourseSection: 0, byStudentSection: 0, noMatch: 0 };
          
          // 🔧 CORRECCIÓN: Priorizar sectionLetter del filtro
          const filterSectionLetterFromProp = filters?.sectionLetter 
            ? String(filters.sectionLetter).toLowerCase().trim()
            : '';
          const sectionMeta = getSectionMeta(filters.sectionId);
          const filterSectionName = sectionMeta 
            ? (sectionMeta.name || sectionMeta.sectionName || sectionMeta.section || '')
                .toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '')
            : '';
          const filterSectionLetterFromMeta = filterSectionName.length === 1 && /^[a-z]$/i.test(filterSectionName) 
            ? filterSectionName.toLowerCase() 
            : (sectionMeta?.name?.match?.(/^([A-Z])$/i)?.[1]?.toLowerCase() || '');
          const filterSectionLetter = filterSectionLetterFromProp || filterSectionLetterFromMeta;
          
          filteredGrades.forEach(g => {
            const gradeSecId = String(g.sectionId || '');
            const gradeSectionName = (g.section || g.sectionName || '').toLowerCase().trim();
            const gradeSectionLetter = gradeSecId.length === 1 && /^[a-z]$/i.test(gradeSecId) 
              ? gradeSecId.toLowerCase() 
              : (gradeSectionName.length === 1 && /^[a-z]$/i.test(gradeSectionName) 
                  ? gradeSectionName.toLowerCase() 
                  : '');
            
            let matched = false;
            if (gradeSecId && gradeSecId === String(filters.sectionId)) { matchMethods.bySectionId++; matched = true; }
            else if (filterSectionName && (gradeSectionName === filterSectionName || gradeSectionName.includes(filterSectionName))) { matchMethods.bySectionName++; matched = true; }
            else if (filterSectionLetter && gradeSectionLetter && filterSectionLetter === gradeSectionLetter) { matchMethods.bySectionLetter++; matched = true; }
            else if ([g.courseSectionId, g.course, g.courseName].some(f => {
              if (!f) return false;
              const letterMatch = String(f).match(/[-_\s]([A-Z])\s*$/i);
              return letterMatch && (filterSectionLetter || filterSectionName) && 
                     letterMatch[1].toLowerCase() === (filterSectionLetter || filterSectionName).toLowerCase();
            })) { matchMethods.byCourseSection++; matched = true; }
            else {
              const studentIdKey = String(g.studentId || '').toLowerCase();
              const studentSection = studentToSectionMap[studentIdKey];
              if (studentSection && (studentSection.sectionId === String(filters.sectionId) || 
                  (filterSectionLetter && studentSection.sectionLetter === filterSectionLetter))) {
                matchMethods.byStudentSection++;
                matched = true;
              }
            }
            if (!matched) matchMethods.noMatch++;
          });
          
          // ALERTA: Si hay registros que no deberían haber pasado
          if (matchMethods.noMatch > 0) {
          }
        }
        
        // 🔥 DEBUG CRÍTICO: Ver si los registros tienen información de sección
        if (filters?.sectionId && filteredGrades.length !== gradedInRange.length) {
          const rechazados = gradedInRange.length - filteredGrades.length;
        }
        
        
        // Debug adicional para verificar problema de courseId/sectionId matching
        if ((filters?.courseId || filters?.sectionId) && gradedInRange.length > 0 && filteredGrades.length === 0) {
          gradedInRange.slice(0, 5).forEach((g, idx) => {
            const gradeIdNorm = normalizeCourseIdForCompare(g.courseId);
            const gradeNameNorm = (g.course || g.courseName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const matchesById = gradeIdNorm === filterCourseIdNorm;
            const matchesByName = filterCourseName && gradeNameNorm.includes(filterCourseName);
          });
        }
        
        // Debug adicional para verificar inferencia de nivel
        if (filters?.level && gradedInRange.length > 0 && filteredGrades.length === 0) {
          gradedInRange.slice(0, 5).forEach((g, idx) => {
            const fieldsToCheck = [g?.courseSectionId, g?.course, g?.courseId, g?.courseName, g?.gradeName, g?.level].filter(Boolean);
            const combinedText = fieldsToCheck.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const hasBasica = /basica|basico|basic|primaria|primary/i.test(combinedText);
            const hasMedia = /media|medio|secundaria|secondary|high/i.test(combinedText);
          });
        }
      }
      
      // 🔥 CORRECCIÓN TEMPRANA: Si no hay datos de calificaciones en absoluto, retornar series vacías inmediatamente
      // Esto es CRÍTICO para evitar mostrar datos de asistencia cuando no hay calificaciones en Firebase
      if (testGrades.length === 0) {
        if (typeof window !== 'undefined') {
        }
        
        // Generar etiquetas de meses del rango de fechas actual
        const monthNamesShortES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const monthNamesShortEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthNamesEmpty = language === 'en' ? monthNamesShortEN : monthNamesShortES;
        const emptyMonthLabels: string[] = [];
        const startMonth = new Date(fromTs).getMonth();
        const endMonth = new Date(toTs).getMonth();
        const startYear = new Date(fromTs).getFullYear();
        
        for (let m = startMonth; m <= endMonth; m++) {
          emptyMonthLabels.push(`${monthNamesEmpty[m]} ${String(startYear).slice(-2)}`);
        }
        
        if (emptyMonthLabels.length === 0) {
          const currentMonth = new Date().getMonth();
          for (let i = 0; i < 3; i++) {
            const m = (currentMonth - 2 + i + 12) % 12;
            emptyMonthLabels.push(`${monthNamesEmpty[m]} ${String(year).slice(-2)}`);
          }
        }
        
        const emptySeries = scopes.map(sc => ({
          label: sc.label,
          values: emptyMonthLabels.map(() => null as number | null)
        }));
        
        return { series: emptySeries, labels: emptyMonthLabels };
      }
      
      // 🔥 CORRECCIÓN TEMPRANA: Si hay filtro de curso/sección pero no hay datos, retornar series vacías inmediatamente
      // Esto asegura que el gráfico se refresque correctamente cuando se cambia a un curso sin calificaciones
      // Replicando el comportamiento del gráfico de asistencia
      if ((filters?.courseId || filters?.sectionId) && filteredGrades.length === 0) {
        if (typeof window !== 'undefined') {
        }
        
        // Generar etiquetas de meses del rango de fechas actual
        const monthNamesShortES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const monthNamesShortEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthNamesEmpty = language === 'en' ? monthNamesShortEN : monthNamesShortES;
        const emptyMonthLabels: string[] = [];
        const startMonth = new Date(fromTs).getMonth();
        const endMonth = new Date(toTs).getMonth();
        const startYear = new Date(fromTs).getFullYear();
        
        // Generar etiquetas para todos los meses en el rango
        for (let m = startMonth; m <= endMonth; m++) {
          emptyMonthLabels.push(`${monthNamesEmpty[m]} ${String(startYear).slice(-2)}`);
        }
        
        // Si no hay meses, generar al menos 3 etiquetas de referencia
        if (emptyMonthLabels.length === 0) {
          const currentMonth = new Date().getMonth();
          for (let i = 0; i < 3; i++) {
            const m = (currentMonth - 2 + i + 12) % 12;
            emptyMonthLabels.push(`${monthNamesEmpty[m]} ${String(year).slice(-2)}`);
          }
        }
        
        // Retornar series con valores null para indicar "sin datos"
        const emptySeries = scopes.map(sc => ({
          label: sc.label,
          values: emptyMonthLabels.map(() => null as number | null)
        }));
        
        return { series: emptySeries, labels: emptyMonthLabels };
      }
      
      // Procesar por scopes y buckets
      outSeries.forEach((serie, si) => {
        buckets.forEach((b, bi) => {
          const scope = scopes[si];
          
          // DEBUG: Log para verificar estructura del scope
          if (si === 0 && bi === 0 && typeof window !== 'undefined') {
            console.log(`🔍 [SCOPE ${si}] Estructura:`, {
              label: scope.label,
              sectionIds: scope.sectionIds,
              sectionNames: scope.sectionNames,
              courseIds: scope.courseIds,
              filteredGradesCount: filteredGrades.length
            });
          }
          
          // Filtrar grades que pertenecen a este scope usando matchScope para consistencia
          const scopeGrades = filteredGrades.filter(g => {
            // 🔧 CORREGIDO: Solo usar optimización de courseId si NO hay sectionIds en el scope
            // Si el scope tiene sectionIds, necesitamos verificar la sección del registro
            if (filters?.courseId && scope.courseIds && scope.courseIds.length > 0 && 
                (!scope.sectionIds || scope.sectionIds.length === 0)) {
              // El scope fue creado con el mismo courseId del filtro Y no tiene filtro de sección
              if (scope.courseIds.includes(String(filters.courseId))) {
                return true;
              }
            }
            
            // 🔧 CORREGIDO: Si hay filtro de sección, verificar que el registro coincida
            // NO aceptar automáticamente - los datos de filteredGrades ya pasaron el filtro inicial,
            // pero aquí verificamos de nuevo para el scope específico
            if (scope.sectionIds && scope.sectionIds.length > 0) {
              // 🔧 MEJORADO: Usar sectionNames del scope si está disponible (más confiable)
              // Normalizar a lowercase para comparación consistente
              const scopeSectionLetter = (scope.sectionNames?.[0] || scope.sectionIds[0] || '').toLowerCase().trim();
              
              // Extraer sección del registro - buscar en múltiples campos
              const gSectionId = String(g.sectionId || '').toLowerCase().trim();
              const gSectionName = (g.section || g.sectionName || '').toLowerCase().trim();
              
              // 🔥 DEBUG: Log para entender qué datos tenemos
              const gIdx = filteredGrades.indexOf(g);
              if (gIdx < 3 && si < 2 && bi === 0 && typeof window !== 'undefined') {
                console.log(`🔍 [SCOPE ${si}] Verificando registro ${gIdx}:`, {
                  scopeLabel: scope.label,
                  scopeSectionLetter,
                  scopeSectionIds: scope.sectionIds,
                  gSectionId,
                  gSectionName,
                  courseId: g.courseId
                });
              }
              
              // Match 1: Por sectionId directo (ej: "a" === "a")
              if (gSectionId && gSectionId === scopeSectionLetter) {
                return true;
              }
              
              // Match 2: Por sectionId contra sectionIds del scope (case-insensitive)
              if (gSectionId && scope.sectionIds.some(id => String(id).toLowerCase().trim() === gSectionId)) {
                return true;
              }
              
              // Match 3: Por nombre de sección
              if (gSectionName && gSectionName === scopeSectionLetter) {
                return true;
              }
              
              // Match 4: Por letra en courseId (ej: "1ro_bsico_a" -> "a")
              const courseIdStr = String(g.courseId || '').toLowerCase();
              if (courseIdStr) {
                const parts = courseIdStr.split(/[-_]/);
                const lastPart = parts[parts.length - 1]?.trim();
                if (lastPart && lastPart.length === 1 && /^[a-z]$/i.test(lastPart)) {
                  if (lastPart === scopeSectionLetter) {
                    return true;
                  }
                }
              }
              
              // Match 5: Por letra en courseSectionId, course, etc.
              const allFields = [g.courseSectionId, g.course, g.courseName, g.gradeName].filter(Boolean);
              for (const field of allFields) {
                const fieldStr = String(field).toLowerCase();
                // Buscar letra al final separada por espacio, guión o underscore
                const letterMatch = fieldStr.match(/[-_\s]([a-z])\s*$/i);
                if (letterMatch && letterMatch[1] === scopeSectionLetter) {
                  return true;
                }
                // Buscar última parte después de separador
                const parts = fieldStr.split(/[-_\s]/);
                const lastPart = parts[parts.length - 1]?.trim();
                if (lastPart && lastPart.length === 1 && /^[a-z]$/i.test(lastPart) && lastPart === scopeSectionLetter) {
                  return true;
                }
              }
              
              // Match 6: Por studentId -> inferir sección del estudiante
              const studentIdForScope = String(g.studentId || '').toLowerCase();
              const studentSectionForScope = studentToSectionMap[studentIdForScope];
              if (studentSectionForScope) {
                const studentSectionLetter = studentSectionForScope.sectionLetter?.toLowerCase();
                if (studentSectionLetter === scopeSectionLetter) {
                  return true;
                }
                // El estudiante está en otra sección, rechazar
                return false;
              }
              
              // 🔥 DEBUG: Log cuando NO matchea ninguna condición
              if (typeof window !== 'undefined' && gIdx < 5 && si === 0 && bi === 0) {
                console.warn(`❌ [SCOPE ${si}] Registro ${gIdx} NO matcheó sección:`, {
                  scopeSectionLetter,
                  gSectionId,
                  gSectionName,
                  courseId: g.courseId,
                  studentId: g.studentId
                });
              }
              
              // Si no matcheó ninguna condición, rechazar
              return false;
            }
            
            // Si el scope tiene gradeNum, SIEMPRE verificar que el grado del registro coincida
            // Esto tiene prioridad sobre courseIds porque queremos filtrar por grado específico
            if (typeof scope.gradeNum === 'number' && scope.gradeNum > 0) {
              const fieldsToCheck = [
                g?.courseSectionId,
                g?.course,
                g?.courseId,
                g?.courseName,
                g?.gradeName,
                g?.grade,
                g?.level
              ].filter(Boolean);
              
              const combinedText = fieldsToCheck.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              
              // Extraer número de grado del registro
              let recordGradeNum: number | undefined;
              const gradeMatch = combinedText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º|st|nd|rd|th)?/);
              if (gradeMatch) {
                recordGradeNum = parseInt(gradeMatch[1]);
              }
              
              // Si no pudimos extraer el grado, no matchear
              if (recordGradeNum === undefined) {
                return false;
              }
              
              // Verificar que el grado coincida exactamente
              if (recordGradeNum !== scope.gradeNum) {
                return false;
              }
              
              // También verificar el nivel si está especificado
              if (scope.levelTag) {
                const hasBasicaIndicator = /b[aá]?sic[oa]|primaria|primary/i.test(combinedText);
                const hasMediaIndicator = /medi[oa]|secundaria|secondary|high/i.test(combinedText);
                
                let isCorrectLevel = false;
                if (scope.levelTag === 'basica') {
                  isCorrectLevel = hasBasicaIndicator || 
                    (recordGradeNum >= 1 && recordGradeNum <= 8 && !hasMediaIndicator);
                } else if (scope.levelTag === 'media') {
                  isCorrectLevel = hasMediaIndicator ||
                    (recordGradeNum >= 9 && recordGradeNum <= 12) ||
                    (recordGradeNum >= 1 && recordGradeNum <= 4 && hasMediaIndicator);
                }
                
                if (!isCorrectLevel) {
                  return false;
                }
              }
              
              // El grado coincide (y el nivel también si estaba especificado)
              return true;
            }
            
            // Verificar por courseIds (solo si hay IDs definidos y NO hay gradeNum)
            if (scope.courseIds && scope.courseIds.length > 0) {
              // DEBUG: Log cuando entra en el bloque de courseIds
              if (si === 0 && bi === 0 && typeof window !== 'undefined') {
                const gIdx = filteredGrades.indexOf(g);
                if (gIdx < 2) {
                }
              }
              
              // Usar normalización flexible para comparar courseIds
              const gIdNorm = normalizeCourseIdForCompare(g.courseId);
              const gNameNorm = (g.course || g.courseName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              return scope.courseIds.some(id => {
                const scopeIdNorm = normalizeCourseIdForCompare(id);
                // Match por ID normalizado
                if (gIdNorm === scopeIdNorm) return true;
                // También buscar el nombre del curso del scope para matching alternativo
                const scopeCourse = getCourseMeta(id);
                if (scopeCourse) {
                  const scopeName = (scopeCourse.gradeName || scopeCourse.name || scopeCourse.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                  if (scopeName && gNameNorm.includes(scopeName)) return true;
                }
                return false;
              });
            }
            
            // Si tiene levelTag SIN gradeNum específico, matchear por nivel general
            if (scope.levelTag && !(typeof scope.gradeNum === 'number' && scope.gradeNum > 0)) {
              const fieldsToCheck = [
                g?.courseSectionId,
                g?.course,
                g?.courseId,
                g?.courseName,
                g?.gradeName,
                g?.grade,
                g?.level
              ].filter(Boolean);
              
              const combinedText = fieldsToCheck.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              
              // Extraer número de grado del registro
              let recordGradeNum: number | undefined;
              const gradeMatch = combinedText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º|st|nd|rd|th)?/);
              if (gradeMatch) {
                recordGradeNum = parseInt(gradeMatch[1]);
              }
              
              // Verificar por courseId en levelByCourseId
              const courseLevel = levelByCourseId[String(g.courseId)];
              if (courseLevel === scope.levelTag) return true;
              
              // Detectar indicadores de nivel con regex más flexible
              const hasBasicaIndicator = /b[aá]?sic[oa]|primaria|primary/i.test(combinedText);
              const hasMediaIndicator = /medi[oa]|secundaria|secondary|high/i.test(combinedText);
              
              if (scope.levelTag === 'basica') {
                if (hasBasicaIndicator) return true;
                if (recordGradeNum !== undefined && recordGradeNum >= 1 && recordGradeNum <= 8 && !hasMediaIndicator) return true;
              }
              
              if (scope.levelTag === 'media') {
                if (hasMediaIndicator) return true;
                if (recordGradeNum !== undefined && recordGradeNum >= 9 && recordGradeNum <= 12) return true;
                if (recordGradeNum !== undefined && recordGradeNum >= 1 && recordGradeNum <= 4 && hasMediaIndicator) return true;
              }
              
              return false;
            }
            // Sin restricciones específicas, matchear todo
            return true;
          });
          
          // DEBUG: Log cuántos registros matchean cada scope (solo para el primer bucket y primer scope)
          if (bi === 0 && typeof window !== 'undefined') {
            console.log(`📊 [SCOPE ${si}] "${scope.label}": ${scopeGrades.length} registros matchean de ${filteredGrades.length} filtrados`);
            
            // Log adicional para diagnosticar por qué no hay matches cuando hay sectionIds
            if (scopeGrades.length === 0 && filteredGrades.length > 0 && scope.sectionIds?.length) {
              console.warn(`⚠️ [SCOPE ${si}] Ningún registro matcheó sección. SectionIds del scope:`, scope.sectionIds, 'SectionNames:', scope.sectionNames);
              const sample = filteredGrades.slice(0, 3);
              sample.forEach((g, idx) => {
                console.log(`   Registro ${idx}:`, { 
                  sectionId: g.sectionId, 
                  section: g.section, 
                  courseId: g.courseId,
                  studentId: g.studentId 
                });
              });
            }
          }
          
          // Filtrar por bucket de tiempo
          const dayGrades = scopeGrades.filter(g => {
            const ts = typeof g.gradedAt === 'number' ? g.gradedAt : (g.gradedAt ? Date.parse(g.gradedAt) : undefined);
            return ts && isInBucket(ts, b);
          });
          
          // Calcular promedio del día
          const scores = dayGrades.map(g => g.score).filter((v): v is number => typeof v === 'number' && isFinite(v));
          // MEJORA 1: Omitir días con datos ceros - usar null en lugar de 0
          serie.values[bi] = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length) : null;
        });
      });
      
      // DEBUG: Log series resultantes para calificaciones
      if (typeof window !== 'undefined') {
        outSeries.forEach((serie, idx) => {
          const validValues = serie.values.filter(v => v !== null) as number[];
          const totalValues = validValues.reduce((a, b) => a + b, 0);
        });
      }
      
      // AGREGACIÓN MENSUAL PARA CALIFICACIONES cuando hay filtro de curso
      const useMonthlyGrades = filters?.courseId;
      
      if (useMonthlyGrades) {
        const monthNamesShortES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const monthNamesShortEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthNames = language === 'en' ? monthNamesShortEN : monthNamesShortES;
        
        const monthKeyOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
        const parseGradeTs = (g: any): number | undefined => {
          const v = g.gradedAt;
          if (typeof v === 'number') return v;
          if (typeof v === 'string') {
            const t = Date.parse(v);
            if (!Number.isNaN(t)) return t;
          }
          return undefined;
        };
        
        // Agregación por mes para cada scope
        const monthsAggPerScope: Array<Record<string, { sum: number; count: number }>> = scopes.map(() => ({}));
        
        // 🔥 DEBUG: Contar asignaciones a cada scope
        const scopeAssignments = scopes.map(() => 0);
        let debugLogCount = 0;
        
        filteredGrades.forEach((g: any) => {
          const ts = parseGradeTs(g);
          if (!ts || ts < fromTs || ts > toTs) return;
          
          const score = g.score;
          if (typeof score !== 'number' || !isFinite(score)) return;
          
          // Extraer sectionId del registro
          let extractedSection = (g.sectionId || g.section || '').toLowerCase().trim();
          if (!extractedSection && g.courseSectionId) {
            const parts = g.courseSectionId.split(/[-_\s]+/);
            if (parts.length > 1) {
              const lastPart = parts[parts.length - 1].trim().toLowerCase();
              if (lastPart.length <= 2 && /^[a-z]$/i.test(lastPart)) {
                extractedSection = lastPart;
              }
            }
          }
          
          const gCid = (g.courseId || g.course || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const gCourseName = (g.courseName || g.course || g.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const gCourseSectionId = (g.courseSectionId || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          scopes.forEach((sc, si) => {
            let matches = false;
            
            // Helper para verificar si un curso coincide
            const courseMatchesFn = () => {
              // Match por courseIds
              if (sc.courseIds?.some(cid => {
                const cidNorm = String(cid).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_\s]+/g, '');
                const gCidNorm = gCid.replace(/[-_\s]+/g, '');
                const gCourseNameNorm = gCourseName.replace(/[-_\s]+/g, '');
                const gCourseSectionIdNorm = gCourseSectionId.replace(/[-_\s]+/g, '');
                return gCidNorm === cidNorm || gCourseNameNorm.includes(cidNorm) || gCourseSectionIdNorm.includes(cidNorm);
              })) return true;
              
              // Match por courseNames
              if (sc.courseNames?.some(cn => {
                const cnNorm = cn.replace(/[-_\s]+/g, '');
                const gCourseNameNorm = gCourseName.replace(/[-_\s]+/g, '');
                const gCourseSectionIdNorm = gCourseSectionId.replace(/[-_\s]+/g, '');
                return gCourseNameNorm.includes(cnNorm) || gCourseSectionIdNorm.includes(cnNorm) || cnNorm.includes(gCourseNameNorm);
              })) return true;
              
              return false;
            };
            
            // Matching por sectionIds
            if (sc.sectionIds && sc.sectionIds.length > 0) {
              // Verificar pertenencia al curso
              if (!courseMatchesFn()) return;
              
              // 🔥 DEBUG: Log para ver comparación de secciones
              if (debugLogCount < 5 && typeof window !== 'undefined') {
                console.log(`🔍 [MONTHLY AGG ${si}] Comparando secciones:`, {
                  extractedSection,
                  sectionIds: sc.sectionIds,
                  sectionIdsNormalized: sc.sectionIds.map(id => String(id).toLowerCase().trim()),
                  sectionNames: sc.sectionNames,
                  gCourseSectionId,
                  record: { courseId: g.courseId, sectionId: g.sectionId, section: g.section }
                });
                debugLogCount++;
              }
              
              // 🔧 CORREGIDO: Usar sectionNames como fuente principal (ya está en lowercase)
              const scopeSectionLetters = (sc.sectionNames && sc.sectionNames.length > 0)
                ? sc.sectionNames.map(n => String(n).toLowerCase().trim())
                : sc.sectionIds.map(id => String(id).toLowerCase().trim());
              
              // Match por sectionId
              if (extractedSection && scopeSectionLetters.includes(extractedSection)) {
                matches = true;
              } else if (gCourseSectionId && scopeSectionLetters.some(sidNorm => {
                return gCourseSectionId.endsWith('-' + sidNorm) || gCourseSectionId.endsWith('_' + sidNorm) || gCourseSectionId.endsWith(' ' + sidNorm);
              })) {
                matches = true;
              }
              // 🔧 ELIMINADO el fallback que asignaba todo a si === 0
              // Esto causaba que TODOS los registros fueran a la primera sección
            }
            
            // Matching solo por courseIds/courseNames (sin sectionIds)
            if (!matches && (sc.courseIds?.length || sc.courseNames?.length) && !sc.sectionIds) {
              matches = courseMatchesFn();
            }
            
            if (matches) {
              const mKey = monthKeyOf(ts);
              const agg = (monthsAggPerScope[si][mKey] ||= { sum: 0, count: 0 });
              agg.sum += score;
              agg.count += 1;
              scopeAssignments[si]++;
            }
          });
        });
        
        // 🔥 DEBUG: Log asignaciones finales por scope
        if (typeof window !== 'undefined') {
          console.log('📊 [MONTHLY AGG] Asignaciones por scope:', scopeAssignments.map((count, i) => `"${scopes[i]?.label}": ${count}`).join(', '));
        }
        
        // 🔥 CORRECCIÓN: Generar etiquetas de TODOS los meses del rango de fechas
        // No solo los meses que tienen datos, sino todos desde fromTs hasta toTs
        const generateMonthKeysForRange = (fromTimestamp: number, toTimestamp: number): string[] => {
          const result: string[] = [];
          const startDate = new Date(fromTimestamp);
          const endDate = new Date(toTimestamp);
          
          // Normalizar al primer día del mes de inicio
          const currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
          const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
          
          while (currentDate <= endMonth) {
            const key = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
            result.push(key);
            currentDate.setMonth(currentDate.getMonth() + 1);
          }
          return result;
        };
        
        // Usar rango completo para las keys, no solo datos existentes
        const keys = generateMonthKeysForRange(fromTs, toTs);
        
        const monthlyLabels = keys.map(k => { 
          const [yy, mm] = k.split('-').map(Number); 
          const monthIdx = Math.max(0, Math.min(11, (isNaN(mm) ? 1 : mm) - 1)); 
          return `${monthNames[monthIdx]} ${String(yy || year).slice(-2)}`; 
        });
        
        const monthlySeries = monthsAggPerScope.map((map, si) => {
          const values = keys.map(k => {
            const m = map[k];
            if (!m || m.count === 0) return null;
            return Math.round(m.sum / m.count);
          });
          return { label: scopes[si]?.label || `Serie ${si+1}`, values };
        });
        
        if (typeof window !== 'undefined') {
          console.log('[CourseComparison] Notas - Meses generados:', keys.length, 'desde', new Date(fromTs).toLocaleDateString(), 'hasta', new Date(toTs).toLocaleDateString());
          
          // 🔧 DEBUG: Mostrar distribución de datos por mes
          const dataByMonth: Record<string, number> = {};
          Object.entries(monthsAggPerScope[0] || {}).forEach(([k, v]) => {
            if (v && (v as any).count > 0) {
              dataByMonth[k] = (v as any).count;
            }
          });
          console.log('[CourseComparison] Notas - Datos por mes:', dataByMonth);
          console.log('[CourseComparison] Notas - Total registros filtrados:', filteredGrades.length);
          
          // Mostrar rango de fechas de los datos
          if (filteredGrades.length > 0) {
            const timestamps = filteredGrades
              .map((g: any) => typeof g.gradedAt === 'number' ? g.gradedAt : Date.parse(g.gradedAt))
              .filter((t: number) => !isNaN(t) && t > 0);
            if (timestamps.length > 0) {
              const minTs = Math.min(...timestamps);
              const maxTs = Math.max(...timestamps);
              console.log('[CourseComparison] Notas - Rango de fechas en datos:', 
                new Date(minTs).toLocaleDateString(), '-', new Date(maxTs).toLocaleDateString());
            }
          }
          
          // 🔥 DEBUG CRÍTICO: Mostrar valores finales de cada serie
          console.log('📊 [CourseComparison] SERIES FINALES (Calificaciones):');
          monthlySeries.forEach((s, idx) => {
            console.log(`   Serie ${idx} "${s.label}": valores = [${s.values.map(v => v !== null ? v.toFixed(1) : 'null').join(', ')}]`);
          });
        }
        
        return { series: monthlySeries, labels: monthlyLabels };
      }
    } else {
      // Procesamiento de asistencia usando la misma lógica que AttendanceTrendCard
  const isPastYear = year < new Date().getFullYear();
  const hasDimFilters = !!(filters?.level || filters?.courseId || filters?.sectionId);
  // Ajuste: usar vista mensual cuando:
  // 1. No hay filtros de dimensión y período es 'all'
  // 2. Hay filtro de semestre sin otros filtros
  // 3. Hay filtro de nivel + semestre (la vista mensual tiene inferencia robusta de nivel)
  // 4. Solo hay filtro de nivel (para mostrar cursos del nivel con inferencia robusta)
  // 5. Hay filtro de curso (para mostrar secciones del curso con agregación mensual)
  // 6. Hay filtro de sección (para mostrar datos de la sección específica)
  const useMonthly = (!hasDimFilters && period === 'all') || 
                     (filters?.semester && !filters?.courseId && !filters?.sectionId) ||
                     (filters?.level && !filters?.courseId && !filters?.sectionId) ||
                     (filters?.courseId) ||
                     (filters?.sectionId);
      
      // DEBUG: Agregar logging para verificar la condición useMonthly
      if (typeof window !== 'undefined' && comparisonType === 'asistencia') {
      }

      // CORRECCIÓN: Usar datos SQL primero si hay conexión (NO hacer fallback a LocalStorage cuando hay SQL conectado)
      let sourceAttendance: any[] = [];
      
      // 1. Si hay conexión SQL/Firebase, usar SOLO esos datos (aunque estén vacíos)
      if (isAttendanceSQLConnected) {
        sourceAttendance = (sqlAttendance && Array.isArray(sqlAttendance[year])) ? sqlAttendance[year] : [];
        if (typeof window !== 'undefined') {
        }
      } 
      // 2. Fallback a LocalStorage SOLO si NO hay conexión SQL
      else {
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          const yearSpecificData = LocalStorageManager.getAttendanceForYear(year) || [];
          if (yearSpecificData.length > 0) {
            sourceAttendance = yearSpecificData;
            if (typeof window !== 'undefined') {
            }
          } else {
            // 3. Último fallback: usar prop attendance
            sourceAttendance = (attendance as any[]) || [];
            if (typeof window !== 'undefined') {
            }
          }
        } catch (err) {
          if (typeof window !== 'undefined') {
            console.warn('Error loading year-specific attendance data:', err);
          }
          sourceAttendance = (attendance as any[]) || [];
        }
      }
      
      // FAST-PATH AJUSTADO: Si no hay filtros de dimensión y tenemos snapshot por secciones, 
      // úsalo como valor inicial para llenar el gráfico mientras se calcula la serie real.
      // Evitamos retornar temprano para no mostrar datos "no reales" cuando existan datos diarios.
      let snapshotInitialSeries: Array<{ label: string; values: (number | null)[] }> | null = null;
      const canUseSnapshot = !filters?.level && !filters?.courseId && !filters?.sectionId && preloadStats?.year === year && Array.isArray(preloadStats?.sectionAgg) && (preloadStats!.sectionAgg!.length > 0);
      if (canUseSnapshot) {
        try {
          let basicPresent = 0, basicTotal = 0, mediaPresent = 0, mediaTotal = 0;
          (preloadStats!.sectionAgg as Array<{ courseId: string | null; sectionId: string | null; present: number; total: number }>).forEach(it => {
            const cid = String(it.courseId || '');
            if (!cid) return;
            const lvl = levelByCourseId[cid];
            if (lvl === 'basica') { basicPresent += (it.present || 0); basicTotal += (it.total || 0); }
            else if (lvl === 'media') { mediaPresent += (it.present || 0); mediaTotal += (it.total || 0); }
          });
          const basicaPct = basicTotal > 0 ? Math.max(0, Math.min(100, +(basicPresent / basicTotal * 100).toFixed(1))) : null;
          const mediaPct = mediaTotal > 0 ? Math.max(0, Math.min(100, +(mediaPresent / mediaTotal * 100).toFixed(1))) : null;
          snapshotInitialSeries = [
            { label: t('levelBasic','Básica'), values: buckets.map(() => basicaPct) },
            { label: t('levelHigh','Media'), values: buckets.map(() => mediaPct) },
          ];
        } catch (e) {
          if (typeof window !== 'undefined') console.warn('Snapshot prefill failed, continuing with normal calculation:', e);
        }
      }

      filteredAtt = sourceAttendance
        .filter(a => {
          // Parsing mejorado de timestamp/fecha
          let t = 0;
          const v = a.timestamp || a.date || a.when;
          if (typeof v === 'number') {
            t = v;
          } else if (typeof v === 'string') {
            // Soportar dd-mm-yyyy
            if (/^\d{2}-\d{2}-\d{4}$/.test(v)) {
              const [dd, mm, yyyy] = v.split('-').map(Number);
              t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
            } 
            // Soportar dd/mm/yyyy
            else if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
              const [dd, mm, yyyy] = v.split('/').map(Number);
              t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
            }
            // Soportar yyyy-mm-dd
            else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
              t = new Date(v + 'T00:00:00').getTime();
            }
            // Otros formatos
            else {
              t = Date.parse(v);
            }
          } else {
            t = parseDateAny(a.date);
          }
          
          return t >= fromTs && t <= toTs;
        })
        .filter(matchFilters);
        
      // DEBUG: Log datos filtrados  
      if (typeof window !== 'undefined' && comparisonType === 'asistencia') {
        
        if (filters?.semester) {
          
          // Verificar si hay datos en el rango de fechas del semestre
          const semesterData = filteredAtt.filter(a => {
            let t = 0;
            const v = a.timestamp || a.date || a.when;
            if (typeof v === 'number') {
              t = v;
            } else if (typeof v === 'string') {
              if (/^\d{2}-\d{2}-\d{4}$/.test(v)) {
                const [dd, mm, yyyy] = v.split('-').map(Number);
                t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
              } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
                const [dd, mm, yyyy] = v.split('/').map(Number);
                t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
              } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                t = new Date(v + 'T00:00:00').getTime();
              } else {
                t = Date.parse(v);
              }
            }
            return t >= fromTs && t <= toTs;
          });
          
          if (semesterData.length > 0) {
          }
        }
        
  const aug22Filtered = filteredAtt.filter(a => {
          const d = a.date || a.timestamp || a.when || '';
          return String(d).includes('22-08-2025') || String(d).includes('22/08/2025') || String(d).includes('2025-08-22');
        });
        if (aug22Filtered.length > 0) {
        }
      }
        
        if (useMonthly) {
          // CORRECCIÓN IMPORTANTE: Para la vista mensual de asistencia, usar la misma lógica robusta
          // que el Bloque 2 (líneas ~2870+), que itera directamente sobre filteredAtt e infiere nivel
          // desde múltiples fuentes incluyendo globalStudentLevelMap
          
          const monthNamesShortES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
          const monthNamesShortEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const monthNames = language === 'en' ? monthNamesShortEN : monthNamesShortES;
          
          const monthKeyOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
          const parseTs = (r: any): number | undefined => {
            const v = r.timestamp || r.date || r.when;
            if (typeof v === 'number') return v;
            if (typeof v === 'string') {
              if (/^\d{2}-\d{2}-\d{4}$/.test(v)) { const [dd,mm,yy] = v.split('-').map(Number); return new Date(yy,(mm||1)-1,dd||1).getTime(); }
              if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) { const [dd,mm,yy] = v.split('/').map(Number); return new Date(yy,(mm||1)-1,dd||1).getTime(); }
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00').getTime();
              const t = Date.parse(v); if (!Number.isNaN(t)) return t;
            }
            return undefined;
          };

          // Construir mapa global de estudiantes para inferencia cruzada (ANTES de procesar registros)
          const globalStudentLevelMap: Record<string, 'basica' | 'media'> = {};
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            let allStudents: any[] = LocalStorageManager.getStudentsForYear?.(year) || [];
            if (!Array.isArray(allStudents) || allStudents.length === 0) {
              const legacy = JSON.parse(localStorage.getItem('smart-student-students')||'[]');
              if (Array.isArray(legacy)) allStudents = legacy;
            }
            if ((!Array.isArray(allStudents) || allStudents.length === 0)) {
              const usersGlobal = JSON.parse(localStorage.getItem('smart-student-users')||'[]');
              if (Array.isArray(usersGlobal)) allStudents = usersGlobal.filter((u:any)=>u?.role==='student');
            }
            if (Array.isArray(allStudents)) {
              allStudents.forEach(st => {
                const cid = String(st.courseId || '');
                const lvl: any = st.level || levelByCourseId[cid];
                if (lvl === 'basica' || lvl === 'media') {
                  const ids: string[] = [];
                  if (st.id) ids.push(String(st.id));
                  if (st.studentId) ids.push(String(st.studentId));
                  if (st.username) ids.push(String(st.username));
                  if (st.rut) ids.push(String(st.rut));
                  ids.forEach(k => { if (k) globalStudentLevelMap[k.toLowerCase()] = lvl; });
                }
              });
            }
          } catch {}

          if (typeof window !== 'undefined') {
            if (filteredAtt && filteredAtt.length > 0) {
            }
          }

          // Usar agregación directa por mes (NO depender de validDays)
          const monthsAggPerScope: Array<Record<string, { present: number; total: number }>> = scopes.map(() => ({}));
          const studentLevelCache: Record<string, 'basica' | 'media' | null> = {};
          
          let matchedCount = 0;
          let unmatchedCount = 0;
          
          (filteredAtt || []).forEach((r: any) => {
            const ts = parseTs(r);
            if (!ts || ts < fromTs || ts > toTs) return;
            
            // Inferir nivel del registro usando múltiples estrategias
            let inferredLevel: 'basica' | 'media' | null = null;
            let inferredGradeNum: number | null = null;
            
            // 1. Verificar courseId en levelByCourseId
            const courseId = r.courseId || r.course || r.courseSectionId?.split('-').slice(0,-1).join('-');
            if (courseId && levelByCourseId[String(courseId)]) {
              inferredLevel = levelByCourseId[String(courseId)] as 'basica' | 'media';
            }
            
            // 2. Inferir desde el nombre del curso (nivel y grado)
            const courseText = [r.course, r.courseId, r.courseName, r.courseSectionId, r.gradeName]
              .filter(Boolean).join(' ').toLowerCase();
            
            if (!inferredLevel) {
              if (/basica|basico|basic|primaria|primary/i.test(courseText)) {
                inferredLevel = 'basica';
              } else if (/media|medio|secundaria|secondary|high/i.test(courseText)) {
                inferredLevel = 'media';
              }
            }
            
            // Extraer número de grado del texto
            const gradeMatch = courseText.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
            if (gradeMatch) {
              const grade = parseInt(gradeMatch[1]);
              inferredGradeNum = grade;
              
              // Si aún no tenemos nivel, inferirlo del número de grado
              if (!inferredLevel) {
                if (grade >= 1 && grade <= 8 && !/media|medio|secundaria|secondary/i.test(courseText)) {
                  inferredLevel = 'basica';
                } else if (grade >= 9 && grade <= 12) {
                  inferredLevel = 'media';
                } else if (grade >= 1 && grade <= 4 && /medio|media/i.test(courseText)) {
                  inferredLevel = 'media';
                }
              }
            }
            
            // 3. Usar mapa global de estudiantes
            const studentKey = String(r.studentId || r.username || r.rut || '').toLowerCase();
            if (!inferredLevel && studentKey && globalStudentLevelMap[studentKey]) {
              inferredLevel = globalStudentLevelMap[studentKey];
            }
            
            // 4. Cache local por studentId
            if (!inferredLevel && studentKey && studentLevelCache[studentKey]) {
              inferredLevel = studentLevelCache[studentKey];
            }
            if (inferredLevel && studentKey) {
              studentLevelCache[studentKey] = inferredLevel;
            }
            
            // Determinar a qué scopes asignar este registro
            const scopeIndicesToUse: number[] = [];
            
            // Extraer sectionId del registro para matching
            let inferredSectionId: string | null = null;
            const rSectionId = r.sectionId || r.section || '';
            if (rSectionId) {
              inferredSectionId = String(rSectionId).toLowerCase().trim();
            } else if (r.courseSectionId) {
              // Extraer de courseSectionId (ej: "1ro Básico-A" -> "a")
              const parts = r.courseSectionId.split(/[-_\s]+/);
              if (parts.length > 1) {
                const lastPart = parts[parts.length - 1].trim().toLowerCase();
                if (lastPart.length <= 2 && /^[a-z]$/i.test(lastPart)) {
                  inferredSectionId = lastPart;
                }
              }
            }
            
            // Helper para verificar si el registro coincide con courseIds del scope
            const recordCourseId = r.courseId || r.course || '';
            const recordCourseName = (r.courseName || r.course || r.gradeName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const recordCourseSectionId = (r.courseSectionId || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            
            // 🔧 HELPER: Normalizar IDs de curso para comparación flexible
            const normalizeForFuzzyMatch = (str: string): string => {
              if (!str) return '';
              return str
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '') // quitar acentos
                .replace(/[aeiou]/g, '') // quitar vocales para matching fuzzy (bsico vs basico)
                .replace(/\s+/g, '')
                .replace(/[-_]/g, '')
                .trim();
            };
            
            // 🔧 HELPER: Extraer número de grado y nivel de un string
            const extractGradeInfo = (str: string): { gradeNum: number | null; level: 'basica' | 'media' | null } => {
              if (!str) return { gradeNum: null, level: null };
              const normalized = str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              
              const gradeMatch = normalized.match(/(\d{1,2})(?:ro|do|to|vo|er|°|º)?/);
              const gradeNum = gradeMatch ? parseInt(gradeMatch[1]) : null;
              
              let level: 'basica' | 'media' | null = null;
              if (/b[aá]?sic[oa]|primaria|primary/i.test(normalized)) level = 'basica';
              else if (/medi[oa]|secundaria|secondary|high/i.test(normalized)) level = 'media';
              else if (gradeNum) {
                if (gradeNum >= 1 && gradeNum <= 8) level = 'basica';
                else if (gradeNum >= 9 && gradeNum <= 12) level = 'media';
              }
              
              return { gradeNum, level };
            };
            
            const matchesCourseScope = (sc: Scope) => {
              // 🔧 VALIDACIÓN PREVIA: Extraer grado+nivel del filtro y del registro
              // Si ambos tienen grado detectable, deben coincidir EXACTAMENTE
              const recordFullText = `${recordCourseId} ${recordCourseName} ${recordCourseSectionId}`;
              const recordGradeInfo = extractGradeInfo(recordFullText);
              
              // Match por courseIds
              if (sc.courseIds?.some(cid => {
                const cidNorm = String(cid).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_\s]+/g, '');
                const rCidNorm = recordCourseId ? String(recordCourseId).toLowerCase().replace(/[-_\s]+/g, '') : '';
                const rCourseNameNorm = recordCourseName.replace(/[-_\s]+/g, '');
                const rCourseSectionIdNorm = recordCourseSectionId.replace(/[-_\s]+/g, '');
                
                // 🔧 NUEVO: Obtener metadata del curso del filtro para extraer grado esperado
                const courseMeta = getCourseMeta(cid);
                const courseMetaName = courseMeta 
                  ? (courseMeta.gradeName || courseMeta.name || courseMeta.label || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                  : '';
                const filterGradeInfo = extractGradeInfo(courseMetaName || cidNorm);
                
                // 🔧 VALIDACIÓN ESTRICTA: Si el filtro tiene un grado específico, 
                // el registro DEBE tener el mismo grado para poder hacer match
                if (filterGradeInfo.gradeNum && recordGradeInfo.gradeNum) {
                  // Si ambos tienen grado detectable, deben coincidir
                  if (filterGradeInfo.gradeNum !== recordGradeInfo.gradeNum) {
                    return false; // Rechazar si grados no coinciden
                  }
                  // También validar nivel si ambos lo tienen
                  if (filterGradeInfo.level && recordGradeInfo.level && 
                      filterGradeInfo.level !== recordGradeInfo.level) {
                    return false; // Rechazar si niveles no coinciden
                  }
                  // Si grado y nivel coinciden, aceptar
                  return true;
                }
                
                // Match exacto por ID normalizado
                if (rCidNorm === cidNorm) return true;
                // Match si el nombre del curso contiene el ID
                if (rCourseNameNorm.includes(cidNorm) || rCourseSectionIdNorm.includes(cidNorm)) return true;
                
                // 🔧 Match fuzzy (sin vocales) - solo si no hay grado detectable en el filtro
                if (!filterGradeInfo.gradeNum) {
                  const cidFuzzy = normalizeForFuzzyMatch(cid);
                  const rCidFuzzy = normalizeForFuzzyMatch(recordCourseId);
                  const rNameFuzzy = normalizeForFuzzyMatch(recordCourseName);
                  const rSectionIdFuzzy = normalizeForFuzzyMatch(recordCourseSectionId);
                  if (cidFuzzy && (rCidFuzzy === cidFuzzy || rNameFuzzy.includes(cidFuzzy) || rSectionIdFuzzy.includes(cidFuzzy))) return true;
                  
                  if (courseMeta) {
                    const courseMetaFuzzy = normalizeForFuzzyMatch(courseMetaName);
                    if (courseMetaName && (rCourseNameNorm.includes(courseMetaName) || rCourseSectionIdNorm.includes(courseMetaName))) return true;
                    if (courseMetaFuzzy && (rNameFuzzy.includes(courseMetaFuzzy) || rSectionIdFuzzy.includes(courseMetaFuzzy))) return true;
                  }
                }
                
                return false;
              })) return true;
              
              // Match por courseNames
              if (sc.courseNames?.some(cn => {
                const cnNorm = cn.replace(/[-_\s]+/g, '');
                const rCourseNameNorm = recordCourseName.replace(/[-_\s]+/g, '');
                const rCourseSectionIdNorm = recordCourseSectionId.replace(/[-_\s]+/g, '');
                
                // 🔧 VALIDACIÓN ESTRICTA POR GRADO: Extraer grado del filtro
                const filterGradeInfo = extractGradeInfo(cn);
                
                // Si el filtro tiene grado específico, validar coincidencia exacta
                if (filterGradeInfo.gradeNum && recordGradeInfo.gradeNum) {
                  if (filterGradeInfo.gradeNum !== recordGradeInfo.gradeNum) {
                    return false; // Rechazar si grados no coinciden
                  }
                  if (filterGradeInfo.level && recordGradeInfo.level && 
                      filterGradeInfo.level !== recordGradeInfo.level) {
                    return false; // Rechazar si niveles no coinciden
                  }
                  // Si grado y nivel coinciden, aceptar
                  return true;
                }
                
                // Match por nombre (solo si no hay grado detectable)
                if (!filterGradeInfo.gradeNum) {
                  if (rCourseNameNorm.includes(cnNorm) || rCourseSectionIdNorm.includes(cnNorm) || cnNorm.includes(rCourseNameNorm)) return true;
                  
                  // Match fuzzy
                  const cnFuzzy = normalizeForFuzzyMatch(cn);
                  const rNameFuzzy = normalizeForFuzzyMatch(recordCourseName);
                  const rSectionIdFuzzy = normalizeForFuzzyMatch(recordCourseSectionId);
                  if (cnFuzzy && (rNameFuzzy.includes(cnFuzzy) || rSectionIdFuzzy.includes(cnFuzzy) || cnFuzzy.includes(rNameFuzzy))) return true;
                }
                
                return false;
              })) return true;
              
              return false;
            };
            
            scopes.forEach((sc, si) => {
              // CASO 1: Scope con sectionIds (filtro por sección específica o curso mostrando secciones)
              if (sc.sectionIds && sc.sectionIds.length > 0) {
                // 🔧 CORRECCIÓN: Si hay courseIds/courseNames, verificar que coincida el curso
                const hasCourseFilter = (sc.courseIds?.length ?? 0) > 0 || (sc.courseNames?.length ?? 0) > 0;
                
                // 🔍 DEBUG: Log detallado para filtro de sección
                if (typeof window !== 'undefined' && matchedCount < 3 && unmatchedCount < 3) {
                  const courseMatchResult = hasCourseFilter ? matchesCourseScope(sc) : 'no-filter';
                }
                
                if (hasCourseFilter && !matchesCourseScope(sc)) return;
                
                // Intentar match por sectionId exacto
                if (inferredSectionId && sc.sectionIds.some(id => String(id).toLowerCase().trim() === inferredSectionId)) {
                  scopeIndicesToUse.push(si);
                  return;
                }
                
                // Match por suffix en courseSectionId (ej: "1ro-basico-a" termina en "-a")
                if (recordCourseSectionId && sc.sectionIds.some(id => {
                  const sidNorm = String(id).toLowerCase().trim();
                  return recordCourseSectionId.endsWith('-' + sidNorm) || 
                         recordCourseSectionId.endsWith('_' + sidNorm) ||
                         recordCourseSectionId.endsWith(' ' + sidNorm);
                })) {
                  scopeIndicesToUse.push(si);
                  return;
                }
                
                // 🔧 NUEVO: Match por sectionId como UUID o ID largo
                // Cuando el filtro usa UUID pero los datos tienen solo letra
                const rSectionDirect = r.sectionId || r.section || '';
                if (rSectionDirect && sc.sectionIds.some(id => {
                  const sidStr = String(id).toLowerCase().trim();
                  const rSecStr = String(rSectionDirect).toLowerCase().trim();
                  // Match exacto
                  if (sidStr === rSecStr) return true;
                  // Si el sectionId del filtro es largo (UUID) pero el del registro es corto (A, B, C)
                  // Obtener metadata de la sección para comparar por nombre
                  const secMeta = getSectionMeta(id);
                  if (secMeta) {
                    const secName = (secMeta.name || secMeta.displayName || secMeta.label || '').toLowerCase().trim().replace(/.*\bsecci[óo]n\s*/i, '');
                    if (secName && (secName === rSecStr || rSecStr === secName)) return true;
                  }
                  return false;
                })) {
                  scopeIndicesToUse.push(si);
                  return;
                }
                
                // 🔧 CORRECCIÓN: Si hay sectionNames en el scope, intentar match por letra de sección
                // Esto es más preciso que incluir todo el curso
                if (sc.sectionNames && sc.sectionNames.length > 0) {
                  const scopeSectionLetter = sc.sectionNames[0]?.toLowerCase?.() || '';
                  
                  // 🔧 PRIMERO: Comparar directamente con inferredSectionId (que viene de r.section)
                  // Esto es el match más directo y confiable
                  if (inferredSectionId && inferredSectionId === scopeSectionLetter) {
                    scopeIndicesToUse.push(si);
                    return;
                  }
                  
                  // Buscar letra de sección en campos del registro
                  const fieldsToCheck = [
                    r.sectionId, r.section, r.sectionName,
                    r.courseSectionId, r.course, r.courseName
                  ].filter(Boolean);
                  
                  for (const field of fieldsToCheck) {
                    const fieldStr = String(field).toLowerCase().trim();
                    // Match por letra al final (ej: "1ro Básico A" -> "a")
                    const letterMatch = fieldStr.match(/[-_\s]([a-z])\s*$/i);
                    if (letterMatch && letterMatch[1].toLowerCase() === scopeSectionLetter) {
                      scopeIndicesToUse.push(si);
                      return;
                    }
                    // Match si el campo ES la letra directamente
                    if (fieldStr.length === 1 && fieldStr === scopeSectionLetter) {
                      scopeIndicesToUse.push(si);
                      return;
                    }
                  }
                }
                
                // 🔧 ELIMINADO: El fallback que asignaba registros no identificados a la primera sección
                // Esto causaba inconsistencias entre filtrar por curso vs filtrar por sección
                // Ahora solo incluimos registros que podamos verificar explícitamente.
                // Si no podemos determinar la sección, NO asignamos el registro a ninguna sección.
                return;
              }
              
              // CASO 2: Scope con courseIds/courseNames solamente (sin sectionIds)
              if ((sc.courseIds?.length || sc.courseNames?.length) && !sc.sectionIds && !sc.levelTag && !sc.gradeNum) {
                if (matchesCourseScope(sc)) {
                  scopeIndicesToUse.push(si);
                }
                return;
              }
              
              // CASO 3: Scope sin levelTag ni gradeNum ni courseIds ni sectionIds - matchear todos
              if (!sc.levelTag && !sc.gradeNum && !sc.courseIds && !sc.sectionIds) {
                scopeIndicesToUse.push(si);
                return;
              }
              
              // CASO 4: Scope tiene gradeNum (filtro por nivel con grados específicos)
              if (sc.gradeNum && sc.levelTag) {
                // Verificar que el nivel coincida
                if (inferredLevel !== sc.levelTag) return;
                // Verificar que el grado coincida - SOLO asignar si coincide exactamente
                if (inferredGradeNum !== sc.gradeNum) return;
                scopeIndicesToUse.push(si);
                return;
              }
              
              // CASO 5: Scope solo tiene levelTag (sin gradeNum específico)
              if (sc.levelTag && !sc.gradeNum) {
                if (inferredLevel === sc.levelTag) {
                  scopeIndicesToUse.push(si);
                }
              }
            });
            
            // CORRECCIÓN: NO distribuir a todos los scopes si no hay match
            // Solo contar como unmatched pero NO asignar a todos los grados
            // Esto evita que un registro de "1ro Básico" aparezca en "2do", "3ro", etc.
            if (scopeIndicesToUse.length === 0) {
              // Si hay scopes con gradeNum específico, no hacer fallback
              const hasGradeNumScopes = scopes.some(s => typeof s.gradeNum === 'number');
              if (hasGradeNumScopes) {
                // No asignar a ningún scope - el registro no coincide con ningún grado
                unmatchedCount++;
                return; // Salir del forEach sin agregar a ningún scope
              }
              // Solo hacer fallback si los scopes son genéricos (sin gradeNum)
              if (scopes.some(s => s.levelTag)) {
                scopes.forEach((_, i) => scopeIndicesToUse.push(i));
                unmatchedCount++;
              }
            } else {
              matchedCount++;
            }
            
            scopeIndicesToUse.forEach((si) => {
              const mKey = monthKeyOf(ts);
              const agg = (monthsAggPerScope[si][mKey] ||= { present: 0, total: 0 });
              
              // Contar presente/ausente según el formato del registro
              if (r.status === 'present' || r.present === true) {
                agg.present += 1;
                agg.total += 1;
              } else if (r.status === 'absent' || r.present === false) {
                agg.total += 1;
              } else if (Array.isArray(r.presentStudents)) {
                const presentIds = new Set<string>();
                r.presentStudents.forEach((ps: any) => { 
                  const pid = String(ps?.studentId || ps?.id || ps?.username || ps).toLowerCase(); 
                  if (pid) presentIds.add(pid); 
                });
                const totalStudents = Array.isArray(r.totalStudents) ? r.totalStudents.length : 
                                     (typeof r.totalCount === 'number' ? r.totalCount : presentIds.size);
                agg.present += presentIds.size; 
                agg.total += totalStudents;
              } else {
                // Registro sin status claro - asumir presente
                agg.present += 1;
                agg.total += 1;
              }
            });
          });
          
          if (typeof window !== 'undefined') {
          }

          // 🔥 CORRECCIÓN: Generar TODOS los meses del rango, no solo los que tienen datos
          const generateMonthKeysForRangeAtt = (fromTimestamp: number, toTimestamp: number): string[] => {
            const result: string[] = [];
            const startDate = new Date(fromTimestamp);
            const endDate = new Date(toTimestamp);
            const currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
            const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
            while (currentDate <= endMonth) {
              const key = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
              result.push(key);
              currentDate.setMonth(currentDate.getMonth() + 1);
            }
            return result;
          };
          
          const keys = generateMonthKeysForRangeAtt(fromTs, toTs);
          const monthlyLabels = keys.map(k => { const [yy,mm] = k.split('-').map(Number); const monthIdx = Math.max(0, Math.min(11, (isNaN(mm) ? 1 : mm) - 1)); return `${monthNames[monthIdx]} ${String(yy || year).slice(-2)}`; });
          const monthlySeries = monthsAggPerScope.map((map, si) => {
            const values = keys.map(k => {
              const m = map[k];
              if (!m || m.total === 0) return null;
              return Number(((m.present / Math.max(1, m.total)) * 100).toFixed(1));
            });
            return { label: scopes[si]?.label || `Serie ${si+1}`, values };
          });
          
          if (typeof window !== 'undefined') {
            console.log('[CourseComparison] Asistencia - Meses generados:', keys.length, 'desde', new Date(fromTs).toLocaleDateString(), 'hasta', new Date(toTs).toLocaleDateString());
          }
          
          return { series: monthlySeries, labels: monthlyLabels };
        } else {
          // Lógica diaria para año actual o con filtros de dimensión: calcular promedio diario real
          outSeries.forEach((serie, si) => {
            // Construir mapa de nivel de estudiantes y base del scope (similar a la rama mensual)
            let scopeStudentBase = 0;
            let scopeStudentLevelMap: Record<string, Level> = {};

            try {
              const { LocalStorageManager } = require('@/lib/education-utils');
              let allStudents: any[] = LocalStorageManager.getStudentsForYear?.(year) || [];
              if (!Array.isArray(allStudents) || allStudents.length === 0) {
                const legacy = JSON.parse(localStorage.getItem('smart-student-students')||'[]');
                if (Array.isArray(legacy)) allStudents = legacy;
              }
              if ((!Array.isArray(allStudents) || allStudents.length === 0)) {
                const usersGlobal = JSON.parse(localStorage.getItem('smart-student-users')||'[]');
                if (Array.isArray(usersGlobal)) allStudents = usersGlobal.filter((u:any)=>u?.role==='student');
              }

              if (Array.isArray(allStudents)) {
                allStudents.forEach(st => {
                  const cid = String(st.courseId || '');
                  const lvl: any = st.level || levelByCourseId[cid];
                  if (lvl === 'basica' || lvl === 'media') {
                    const ids: string[] = [];
                    if (st.id) ids.push(String(st.id));
                    if (st.studentId) ids.push(String(st.studentId));
                    if (st.username) ids.push(String(st.username));
                    if (st.rut) ids.push(String(st.rut));
                    ids.forEach(k => { if (k) scopeStudentLevelMap[k.toLowerCase()] = lvl; });
                  }
                });

                // Filtrar estudiantes por nivel si el scope lo define
                let filteredStudents = [...allStudents];
                filteredStudents = filteredStudents.filter(st => {
                  const cid = String(st.courseId || '');
                  const primaryKey = String(st.id || st.studentId || st.username || st.rut || '').toLowerCase();
                  if (scopes[si].levelTag) {
                    const lvl = scopeStudentLevelMap[primaryKey] || levelByCourseId[cid];
                    if (lvl !== scopes[si].levelTag) return false;
                  }
                  return true;
                });
                scopeStudentBase = filteredStudents.length;
              }
            } catch { /* ignore */ }

            buckets.forEach((b, bi) => {
              const dayRecs = filteredAtt.filter(a => {
                let t = 0;
                const v = a.timestamp || a.date || a.when;
                if (typeof v === 'number') {
                  t = v;
                } else if (typeof v === 'string') {
                  if (/^\d{2}-\d{2}-\d{4}$/.test(v)) {
                    const [dd, mm, yyyy] = v.split('-').map(Number);
                    t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
                  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
                    const [dd, mm, yyyy] = v.split('/').map(Number);
                    t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
                  } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                    t = new Date(v + 'T00:00:00').getTime();
                  } else {
                    t = Date.parse(v);
                  }
                } else {
                  t = parseDateAny(a.date);
                }

                const inBucket = isInBucket(t, b);
                const matchesScope = matchScopeExtended(a, scopes[si], scopeStudentLevelMap);

                return inBucket && matchesScope;
              });

              // Unir presentes y totales por día; usar conteos máximos reportados si existen
              const presentIds = new Set<string>();
              const totalIds = new Set<string>();
              let maxPresentCount = 0;
              let maxTotalCount = 0;

              dayRecs.forEach(r => {
                if (Array.isArray(r.presentStudents) && r.presentStudents.length) {
                  r.presentStudents.forEach((ps: any) => {
                    const pid = String(ps?.studentId || ps?.id || ps?.username || ps).toLowerCase();
                    if (!pid) return;
                    // Si el scope representa un nivel, filtrar por nivel
                    if (scopes[si].levelTag) {
                      const lvl = scopeStudentLevelMap[pid] || (()=>{ const courseId = String(ps?.courseId || r.courseId || r.course || ''); return levelByCourseId[courseId]; })();
                      if (lvl && lvl !== scopes[si].levelTag) return;
                    }
                    presentIds.add(pid);
                    totalIds.add(pid);
                  });
                  if (typeof r.presentCount === 'number') maxPresentCount = Math.max(maxPresentCount, r.presentCount);
                } else if (r.status === 'present' || r.present === true) {
                  const pid = String(r.studentId || r.studentUsername || r.username || r.user || '').toLowerCase();
                  if (pid) {
                    if (scopes[si].levelTag) {
                      const lvl = scopeStudentLevelMap[pid] || (()=>{ const courseId = String(r.courseId || r.course || ''); return levelByCourseId[courseId]; })();
                      if (lvl && lvl !== scopes[si].levelTag) {
                        // Si no coincide el nivel, no contar este presente
                      } else {
                        presentIds.add(pid);
                        totalIds.add(pid);
                      }
                    } else {
                      presentIds.add(pid);
                      totalIds.add(pid);
                    }
                  }
                } else if (r.status === 'absent') {
                  const pid = String(r.studentId || r.studentUsername || r.username || r.user || '').toLowerCase();
                  if (pid) totalIds.add(pid);
                }

                if (typeof r.presentCount === 'number') maxPresentCount = Math.max(maxPresentCount, r.presentCount);
                if (typeof (r as any).totalCount === 'number') maxTotalCount = Math.max(maxTotalCount, Number((r as any).totalCount));
                if (Array.isArray((r as any).students)) {
                  (r as any).students.forEach((st:any)=>{
                    const sid = String(st?.studentId || st?.id || st?.username || st).toLowerCase();
                    if (sid) totalIds.add(sid);
                  });
                }
              });

              // Calcular presente y total del día
              let present = presentIds.size;
              if (maxPresentCount > present) present = maxPresentCount;
              if (scopeStudentBase > 0) present = Math.min(present, scopeStudentBase);

              let dayTotal = 0;
              if (maxTotalCount > 0) dayTotal = maxTotalCount;
              else if (totalIds.size > 0) dayTotal = totalIds.size;
              else if (scopeStudentBase > 0) dayTotal = scopeStudentBase;
              if (maxTotalCount === 0 && totalIds.size === presentIds.size && scopeStudentBase > present) {
                dayTotal = scopeStudentBase;
              }
              if (dayTotal < present) dayTotal = present;
              if (scopeStudentBase > 0) dayTotal = Math.min(dayTotal, scopeStudentBase);

              // Porcentaje del día
              const pct = dayTotal > 0 ? Number(((present / dayTotal) * 100).toFixed(1)) : null;
              serie.values[bi] = pct;
            });
          });
        }
      }

    // Fallback sintético: si es asistencia, año actual, sin filtros específicos y todas las series están en cero
    if (comparisonType === 'asistencia') {
      const currentYear = new Date().getFullYear();
      const noDimFilters = !filters?.level && !filters?.courseId && !filters?.sectionId && !filters?.semester;
      const allZero = outSeries.length > 0 && outSeries.every(s => s.values.every(v => v === 0));
      if (year === currentYear && noDimFilters && allZero) {
        // Si los scopes son Básica/Media (2 series) generar valores promedio estáticos razonables
        if (outSeries.length === 2) {
          const synthetic = [82, 78];
          outSeries = outSeries.map((s, idx) => ({ ...s, values: s.values.map(() => synthetic[idx] || 80) }));
        } else if (outSeries.length === 0) {
          // Crear scopes sintéticos básicos
          outSeries = [
            { label: 'Básica', values: labels.map(() => 82) },
            { label: 'Media', values: labels.map(() => 78) },
          ];
        } else {
          // Un solo scope u otro caso: rellenar con 80% estable
            outSeries = outSeries.map(s => ({ ...s, values: s.values.map(() => 80) }));
        }
      }
    }

    // Si no hay datos diarios en ninguna serie, aplicar un fallback mensual mínimo similar al AttendanceTrendCard
    const noDailyData = outSeries.length > 0 && outSeries.every(s => (s.values || []).every(v => v == null));
    if (noDailyData) {
      // Recalcular datos filtrados localmente desde "attendance" para este fallback
      const filteredAtt2: any[] = (Array.isArray(attendance) ? attendance : []).filter(a => {
        let t = 0;
        const v = (a as any).timestamp || (a as any).date || (a as any).when;
        if (typeof v === 'number') {
          t = v;
        } else if (typeof v === 'string') {
          if (/^\d{2}-\d{2}-\d{4}$/.test(v)) {
            const [dd, mm, yyyy] = v.split('-').map(Number);
            t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
          } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
            const [dd, mm, yyyy] = v.split('/').map(Number);
            t = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            t = new Date(v + 'T00:00:00').getTime();
          } else {
            t = Date.parse(v);
          }
        } else {
          t = parseDateAny((a as any).date);
        }
        return t >= fromTs && t <= toTs;
      }).filter(matchFilters);
      
      if (!Array.isArray(filteredAtt2) || filteredAtt2.length === 0) {
        return { series: outSeries, labels };
      }
      // Agregación mensual por scope usando los registros ya filtrados (fromTs..toTs)
      const monthNamesShortES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      const monthNamesShortEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monthNames = language === 'en' ? monthNamesShortEN : monthNamesShortES;
      const monthKeyOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
      const parseTs = (r: any): number | undefined => {
        const v = r.timestamp || r.date || r.when;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          if (/^\d{2}-\d{2}-\d{4}$/.test(v)) { const [dd,mm,yy] = v.split('-').map(Number); return new Date(yy,(mm||1)-1,dd||1).getTime(); }
          if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) { const [dd,mm,yy] = v.split('/').map(Number); return new Date(yy,(mm||1)-1,dd||1).getTime(); }
          if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00').getTime();
          const t = Date.parse(v); if (!Number.isNaN(t)) return t;
        }
        return undefined;
      };
      const monthsAggPerScope: Array<Record<string, { present: number; total: number }>> = scopes.map(() => ({}));
      filteredAtt2.forEach((r: any) => {
        const ts = parseTs(r); if (!ts || ts < fromTs || ts > toTs) return;
        scopes.forEach((sc, si) => {
          // Reutilizar matchScope para asignar registro al scope
          const matches = matchScope(r, sc) || matchScopeExtended(r, sc, {} as any);
          if (!matches) return;
          const mKey = monthKeyOf(ts);
          const agg = (monthsAggPerScope[si][mKey] ||= { present: 0, total: 0 });
          if (Array.isArray(r.presentStudents)) {
            const ids = new Set<string>();
            r.presentStudents.forEach((ps: any) => { const pid = String(ps?.studentId || ps?.id || ps?.username || ps).toLowerCase(); if (pid) ids.add(pid); });
            agg.present += ids.size; agg.total += ids.size;
          } else if (r.status === 'present' || r.present === true) {
            agg.present += 1; agg.total += 1;
          } else {
            agg.total += 1;
          }
        });
      });
      // 🔥 CORRECCIÓN: Generar TODOS los meses del rango, no solo los que tienen datos
      const generateMonthKeysForRangeFinal = (fromTimestamp: number, toTimestamp: number): string[] => {
        const result: string[] = [];
        const startDate = new Date(fromTimestamp);
        const endDate = new Date(toTimestamp);
        const currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
        while (currentDate <= endMonth) {
          const key = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
          result.push(key);
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        return result;
      };
      
      const keys = generateMonthKeysForRangeFinal(fromTs, toTs);
      const monthlyLabels = keys.map(k => { const [yy,mm] = k.split('-').map(Number); const monthIdx = Math.max(0, Math.min(11, (isNaN(mm) ? 1 : mm) - 1)); return `${monthNames[monthIdx]} ${String(yy || year).slice(-2)}`; });
      const monthlySeries = monthsAggPerScope.map((map, si) => {
        const values = keys.map(k => {
          const m = map[k];
          if (!m || m.total === 0) return null;
          return Number(((m.present / Math.max(1, m.total)) * 100).toFixed(1));
        });
        return { label: scopes[si]?.label || `Serie ${si+1}`, values };
      });
      return { series: monthlySeries, labels: monthlyLabels };
    }

    // 🔥 DEBUG FINAL: Ver las series que se van a retornar
    if (typeof window !== 'undefined') {
      console.log('📈 [FINAL SERIES] Retornando series:', {
        seriesCount: outSeries.length,
        series: outSeries.map(s => ({
          label: s.label,
          valuesCount: s.values?.length || 0,
          nonNullValues: s.values?.filter((v: any) => v !== null).length || 0,
          sampleValues: s.values?.slice(0, 5)
        })),
        labelsCount: labels.length
      });
    }

    return { series: outSeries, labels };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    comparisonType,
    JSON.stringify(filters),
    period,
    year,
    language,
    preloadStats?.year,
    (preloadStats?.sectionAgg ? preloadStats.sectionAgg.length : 0),
    // Recalcular cuando el loader desaparece (señal explícita)
    loaderDone,
    // Y cuando llegan/actualizan datos SQL o locales
    isSQLConnected,
    isAttendanceSQLConnected,
    // 🔥 OPTIMIZADO: Solo verificar longitud de arrays en lugar de stringify completo
    sqlGrades ? Object.keys(sqlGrades).length : 0,
    sqlGrades?.[year]?.length ?? 0,
    sqlAttendance ? Object.keys(sqlAttendance).length : 0,
    sqlAttendance?.[year]?.length ?? 0
  ]) as { series: Array<{ label: string; values: (number | null)[] }>; labels: string[] };

  // Ajustar series visibles cuando cambien las series disponibles
  useEffect(() => {
    if (dailySeries && dailySeries.length > 0) {
      const currentVisible = new Set(visibleSeries);
      // Remover series que ya no existen
      const validVisible = new Set<number>();
      for (let i = 0; i < dailySeries.length; i++) {
        if (currentVisible.has(i)) {
          validVisible.add(i);
        }
      }
      // Actualizar solo si hay cambios (sin forzar reactivación automática)
      if (validVisible.size !== currentVisible.size || 
          Array.from(validVisible).some(i => !currentVisible.has(i))) {
        setVisibleSeries(validVisible);
      }
    }
  }, [dailySeries]);

  // Separar la lógica: datos disponibles vs series visibles
  const hasDataAvailable = useMemo(() => {
    if (!dailySeries || dailySeries.length === 0) return false;
    for (let i = 0; i < dailySeries.length; i++) {
      const serie = dailySeries[i];
      if (serie && Array.isArray(serie.values)) {
        const anyNumeric = serie.values.some(v => typeof v === 'number' && isFinite(v as number));
        if (anyNumeric) return true;
      }
    }
    return false;
  }, [dailySeries]);

  // Verificar si hay series válidas visibles (basado en series reales que existen)
  const hasVisibleSeries = useMemo(() => {
    if (!dailySeries || dailySeries.length === 0) return false;
    // Solo contar series visibles que realmente existen en dailySeries
    for (let i = 0; i < dailySeries.length; i++) {
      if (visibleSeries.has(i)) return true;
    }
    return false;
  }, [dailySeries, visibleSeries]);

  const hasAnyVisibleData = useMemo(() => {
    if (!dailySeries || dailySeries.length === 0) return false;
    if (visibleSeries.size === 0) return false;
    for (let i = 0; i < dailySeries.length; i++) {
      if (!visibleSeries.has(i)) continue;
      const serie = dailySeries[i];
      if (serie && Array.isArray(serie.values)) {
        const anyNumeric = serie.values.some(v => typeof v === 'number' && isFinite(v as number));
        if (anyNumeric) return true;
      }
    }
    return false;
  }, [dailySeries, visibleSeries]);

  const maxValue = 100; // Escala en %
  // 🔧 CORREGIDO: Usar azul más oscuro (#3B82F6) en lugar de azul claro (#60A5FA)
  const colors = ['#3B82F6', '#F59E0B', '#10B981', '#F97316', '#8B5CF6', '#EC4899'];

  // Cálculo de dominio Y dinámico para zoom
  const yDomain = useMemo(() => {
    if (!(zoomY ?? true)) return { min: 0, max: 100 };
    
    // MEJORA 2: Solo considerar series visibles para el zoom
    const visibleSeriesData = (dailySeries || [])
      .filter((s, idx) => visibleSeries.has(idx))
      .flatMap(s => s.values)
      .filter(v => typeof v === 'number' && isFinite(v) && v > 0) as number[];
      
    if (!visibleSeriesData.length) return { min: 0, max: 100 };
    
    let min = Math.min(...visibleSeriesData);
    let max = Math.max(...visibleSeriesData);
    const range = max - min;
    
    // ZOOM INTELIGENTE: Centrar en el rango de datos con padding apropiado
    
    // Calcular padding basado en el rango de datos
    const padding = Math.max(5, range * 0.15); // Mínimo 5%, o 15% del rango
    
    // Aplicar padding
    min = Math.max(0, min - padding);
    max = Math.min(100, max + padding);
    
    // Asegurar ventana mínima de 10% para poder ver diferencias
    if (max - min < 10) {
      const center = (min + max) / 2;
      min = Math.max(0, center - 5);
      max = Math.min(100, center + 5);
    }
    
    // Si los valores están en la parte alta (>70%), dar más espacio arriba
    if (min > 70) {
      max = Math.min(100, max + 5);
    }
    
    // Si los valores están en la parte baja (<30%), dar más espacio abajo
    if (max < 30) {
      min = Math.max(0, min - 5);
    }
    
    // DEBUG: Log del zoom para verificar
    if (typeof window !== 'undefined' && (zoomY ?? true)) {
    }
    
    if (min >= max) return { min: 0, max: 100 };
    // Redondear a enteros para mostrar valores limpios en el eje Y
    return { min: Math.floor(min), max: Math.ceil(max) };
  }, [zoomY, dailySeries, visibleSeries]);

  const yScale = (val: number) => {
    const min = yDomain.min;
    const max = yDomain.max;
    const range = Math.max(1, max - min);
    return 180 - ((val - min) / range) * 160; // 20..180
  };

  // Ticks y líneas de referencia
  const gridLines = useMemo(() => {
    const ticks = (zoomY ?? true) ? [0, 1, 2, 3, 4].map(i => yDomain.min + (i * (yDomain.max - yDomain.min)) / 4) : [0, 25, 50, 75, 100];
    return ticks.map(v => ({
      value: v,
      bottomPct: ((v - yDomain.min) / Math.max(1, (yDomain.max - yDomain.min))) * 100,
      label: `${Math.round(v)}%`,
    }));
  }, [zoomY, yDomain.min, yDomain.max]);

  return (
    <Card className="relative overflow-hidden w-full">
      <CardHeader className="pt-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg font-semibold text-foreground">
              {t('courseComparison', 'Comparación de Cursos')}
            </CardTitle>
            <div className="mt-2 text-sm text-muted-foreground/80">
              {(() => {
                // Construir subtítulo dinámico con formato unificado para ambos tipos
                const parts: string[] = [];
                
                // 1. Tipo de gráfico
                if (comparisonType === 'notas') {
                  parts.push(t('grades','Calificaciones'));
                } else if (comparisonType === 'asistencia') {
                  parts.push(t('cardAttendanceTitle','Asistencia'));
                }
                
                // 2. Año
                parts.push(String(year));
                
                // 3. Semestre (si existe)
                if (filters?.semester) {
                  const semLabel = filters.semester === 'S1' ? t('firstSemester','1er Semestre') : t('secondSemester','2do Semestre');
                  parts.push(semLabel);
                }
                
                // 4. Nivel/Curso/Sección (buscar información detallada)
                try {
                  const courses: any[] = [];
                  const sections: any[] = [];
                  
                  // Cargar datos por año
                  const yearKeys = Object.keys(localStorage).filter(k => /^(smart-student-(admin-)?(courses|sections))-\d{4}$/.test(k));
                  yearKeys.forEach(k => {
                    try {
                      const arr = JSON.parse(localStorage.getItem(k) || '[]');
                      if (/courses-\d{4}$/.test(k) && Array.isArray(arr)) courses.push(...arr);
                      if (/sections-\d{4}$/.test(k) && Array.isArray(arr)) sections.push(...arr);
                    } catch {}
                  });
                  
                  if (filters?.sectionId) {
                    // Si hay sección, mostrar curso completo + sección
                    const section = sections.find((s:any) => String(s?.id||s?.sectionId) === String(filters.sectionId));
                    if (section) {
                      const courseId = section.courseId || (section.course && (section.course.id || section.courseId));
                      const course = courses.find((c:any) => String(c?.id) === String(courseId));
                      
                      if (course) {
                        // Formato: "1ro Básico A"
                        const gradeName = course.gradeName || course.name || course.label || '';
                        const sectionLetter = (section.name || section.label || section.displayName || '').replace(/.*\bSecci[óo]n\s*/i, '') || '';
                        const courseWithSection = `${gradeName}${sectionLetter ? ` ${sectionLetter}` : ''}`.trim();
                        if (courseWithSection) parts.push(courseWithSection);
                      }
                    }
                  } else if (filters?.courseId) {
                    // Si hay curso pero no sección, mostrar solo el curso
                    const course = courses.find((c:any) => String(c?.id) === String(filters.courseId));
                    if (course) {
                      const courseName = course.gradeName || course.name || course.label || '';
                      if (courseName) parts.push(courseName);
                    }
                  } else if (filters?.level) {
                    // Si solo hay nivel, mostrar Básica o Media
                    const levelStr = filters.level === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media');
                    parts.push(levelStr);
                  }
                } catch {}
                
                const subtitle = parts.join(' • ');
                return <span>{subtitle}</span>;
              })()}
            </div>
          </div>
          
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Botones de métrica con recuadro visible para selección */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setComparisonType('notas')}
                className={`inline-flex items-center justify-center rounded-lg w-10 h-10 text-lg font-medium transition-all duration-200 border-2 ${
                  comparisonType === 'notas' 
                    ? 'bg-primary text-primary-foreground border-primary shadow-lg scale-105' 
                    : 'text-muted-foreground border-border/30 bg-background/60 hover:text-foreground hover:bg-accent/50 hover:border-border'
                }`}
                aria-label={t('grades','Notas')}
                title={t('grades','Notas')}
              >
                📊
              </button>
              
              <button
                type="button"
                onClick={() => setComparisonType('asistencia')}
                className={`inline-flex items-center justify-center rounded-lg w-10 h-10 text-lg font-medium transition-all duration-200 border-2 ${
                  comparisonType === 'asistencia' 
                    ? 'bg-primary text-primary-foreground border-primary shadow-lg scale-105' 
                    : 'text-muted-foreground border-border/30 bg-background/60 hover:text-foreground hover:bg-accent/50 hover:border-border'
                }`}
                aria-label={t('cardAttendanceTitle','Asistencia')}
                title={t('cardAttendanceTitle','Asistencia')}
              >
                👥
              </button>
            </div>
            
            {/* Botón de zoom - solo icono */}
            <button
              type="button"
              onClick={() => setZoomY(z => !z)}
              className={`inline-flex items-center justify-center rounded-lg border w-8 h-8 text-xs font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary ${
                zoomY 
                  ? 'border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90' 
                  : 'border-border/50 bg-background/60 text-foreground hover:border-primary/50 hover:bg-accent/50'
              }`}
              title={zoomY ? t('restoreScale','Restaurar escala') : t('zoomToData','Zoom a los datos')}
              aria-label={zoomY ? t('restoreScale','Restaurar escala') : t('zoomToData','Zoom a los datos')}
            >
              {zoomY ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Mostrar spinner de carga cuando loaderDone es false */}
        {!loaderDone ? (
          <div className="space-y-4">
            <div className="h-80 relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4">
              <div className="h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600">
                <div className="text-center">
                  <svg
                    className="animate-spin h-10 w-10 mx-auto text-blue-500 mb-3"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  <p className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">
                    {comparisonType === 'notas'
                      ? t('loadingGradesData', 'Cargando datos de calificaciones...')
                      : t('loadingAttendanceData', 'Cargando datos de asistencia...')}
                  </p>
                  <p className="text-gray-400 dark:text-gray-500 text-xs">
                    {t('dataWillShowSoon', 'Los datos se mostrarán en unos segundos')}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700">
              {[
                { label: t('levelBasic', 'Básica'), color: colors[0] },
                { label: t('levelHigh', 'Media'), color: colors[1] }
              ].map(({ label, color }, idx) => (
                <button
                  key={idx}
                  disabled
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium opacity-50 cursor-not-allowed bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                >
                  <div 
                    className="w-3 h-3 rounded-full border-2 border-white dark:border-gray-800 shadow-sm"
                    style={{ backgroundColor: color }}
                  />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : dailySeries && dailySeries.length > 0 ? (
          <div className="space-y-4">
            {/* Gráfico principal usando MultiTrendChart (mismo formato que Calificaciones - Periodo) */}
            <div className="h-80 relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4">
              {/* 🔥 CORRECCIÓN: Usar hasAnyVisibleData en lugar de hasVisibleSeries para detectar cursos sin datos */}
              {hasAnyVisibleData ? (
                (() => {
                  const MultiTrendChart = require('@/components/charts/MultiTrendChart').default as typeof import('@/components/charts/MultiTrendChart').default;
                  
                  // Agregar datos diarios a mensuales (1 punto por mes)
                  const monthlyData = (() => {
                    if (!dailyLabels || dailyLabels.length === 0 || !dailySeries || dailySeries.length === 0) {
                      return { labels: [] as string[], series: [] as Array<{ data: (number | null)[]; label: string; color: string }> };
                    }
                    
                    // Extraer mes de cada label diario (formato: "DD/Mes/YY" -> "Mes")
                    const monthKeysInOrder: string[] = [];
                    const dayToMonthIdx: number[] = [];
                    
                    dailyLabels.forEach((label) => {
                      let monthKey = '';
                      if (label.includes('/')) {
                        // Formato diario: "03/Mar/25"
                        const parts = label.split('/');
                        monthKey = parts.length >= 2 ? parts[1] : label;
                      } else {
                        // Formato mensual: "Mar 25"
                        const parts = label.split(' ');
                        monthKey = parts[0] || label;
                      }
                      
                      let monthIdx = monthKeysInOrder.indexOf(monthKey);
                      if (monthIdx === -1) {
                        monthIdx = monthKeysInOrder.length;
                        monthKeysInOrder.push(monthKey);
                      }
                      dayToMonthIdx.push(monthIdx);
                    });
                    
                    // Agregar valores por mes para cada serie
                    const aggregatedSeries = dailySeries.map((serie, serieIdx) => {
                      const monthlyValues: { sum: number; count: number }[] = 
                        Array.from({ length: monthKeysInOrder.length }, () => ({ sum: 0, count: 0 }));
                      
                      serie.values.forEach((value, dayIdx) => {
                        if (typeof value === 'number' && isFinite(value)) {
                          const mIdx = dayToMonthIdx[dayIdx];
                          if (mIdx >= 0 && mIdx < monthlyValues.length) {
                            monthlyValues[mIdx].sum += value;
                            monthlyValues[mIdx].count += 1;
                          }
                        }
                      });
                      
                      const originalIdx = dailySeries.findIndex(s => s.label === serie.label);
                      return {
                        data: monthlyValues.map(m => m.count > 0 ? +(m.sum / m.count).toFixed(1) : null),
                        label: serie.label,
                        color: colors[originalIdx % colors.length]
                      };
                    });
                    
                    // 🔥 DEBUG: Log series antes de renderizar
                    if (typeof window !== 'undefined') {
                      console.log('📈 [RENDER] monthlyData.series:', aggregatedSeries.map(s => ({ label: s.label, data: s.data })));
                      console.log('📈 [RENDER] visibleSeries:', [...visibleSeries]);
                    }
                    
                    return { labels: monthKeysInOrder, series: aggregatedSeries };
                  })();
                  
                  // Filtrar solo las series visibles
                  const seriesToRender = monthlyData.series.filter((_, idx) => visibleSeries.has(idx));
                  
                  // 🔥 DEBUG: Log series que se van a renderizar
                  if (typeof window !== 'undefined') {
                    console.log('📈 [RENDER] seriesToRender:', seriesToRender.map(s => ({ label: s.label, data: s.data })));
                  }
                  
                  return (
                    <MultiTrendChart
                      series={seriesToRender}
                      labels={monthlyData.labels}
                      height={288}
                      percentGrid
                      yAxis
                      highlightLastValue
                      yDomain={zoomY ? yDomain : undefined}
                    />
                  );
                })()
              ) : (
                <div className="h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600">
                  <div className="text-center">
                    <svg
                      className="animate-spin h-10 w-10 mx-auto text-blue-500 mb-3"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">
                      {/* 🔥 MEJORA: Mensaje dinámico según el contexto */}
                      {!hasDataAvailable && (filters?.courseId || filters?.sectionId)
                        ? (comparisonType === 'notas' 
                            ? t('noGradesForCourse', 'Sin calificaciones registradas para este curso')
                            : t('noAttendanceForCourse', 'Sin asistencia registrada para este curso'))
                        : hasVisibleSeries && !hasAnyVisibleData
                          ? t('noDataInVisibleSeries', 'Sin datos en el rango seleccionado')
                          : t('noDataAvailable', 'Selecciona al menos una serie para mostrar datos')
                      }
                    </p>
                    {!hasDataAvailable && (filters?.courseId || filters?.sectionId) && (
                      <p className="text-gray-400 dark:text-gray-500 text-xs">
                        {t('tryAnotherCourse', 'Prueba seleccionando otro curso o ajusta los filtros')}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
            
            {/* Leyenda mejorada en la parte inferior - igual que el gráfico de período */}
            <div className="flex items-center justify-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700">
              {dailySeries && dailySeries.length > 0 ? (
                dailySeries.map((s, idx) => {
                  const isVisible = visibleSeries.has(idx);
                  return (
                    <button
                      key={s.label+idx} 
                      type="button"
                      onClick={() => {
                        const newVisible = new Set(visibleSeries);
                        if (isVisible) {
                          newVisible.delete(idx);
                        } else {
                          newVisible.add(idx);
                        }
                        setVisibleSeries(newVisible);
                      }}
                      className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 hover:scale-105 
                        ${isVisible 
                          ? 'bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100' 
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }
                      `}
                      title={isVisible ? `Ocultar ${s.label}` : `Mostrar ${s.label}`}
                    >
                      <div 
                        className="w-3 h-3 rounded-full border-2 border-white dark:border-gray-800 shadow-sm"
                        style={{ backgroundColor: isVisible ? colors[idx % colors.length] : '#d1d5db' }} 
                      />
                      <span>{s.label}</span>
                    </button>
                  );
                })
              ) : (
                // Botones placeholder para mantener la altura cuando no hay datos
                [
                  { label: 'Básica', color: colors[0], index: 0 },
                  { label: 'Media', color: colors[1], index: 1 }
                ].map(({ label, color, index }) => (
                  <button
                    key={index}
                    disabled
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium opacity-50 cursor-not-allowed bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                  >
                    <div 
                      className="w-3 h-3 rounded-full border-2 border-white dark:border-gray-800 shadow-sm bg-gray-300"
                    />
                    <span>{label}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="h-64 flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600">
            <div className="text-center">
              <svg
                className="animate-spin h-10 w-10 mx-auto text-blue-500 mb-3"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              <p className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">
                {t('noDataAvailable', 'Sin datos disponibles')}
              </p>
              <p className="text-gray-400 dark:text-gray-500 text-xs">
                Ajusta los filtros para ver información de {comparisonType === 'notas' ? 'calificaciones' : 'asistencia'}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Componente responsivo que calcula la altura automáticamente
function ResponsiveTrendChart({ 
  data, 
  labels, 
  color, 
  valueFormat, 
  percentGrid, 
  yAxis, 
  highlightLastValue, 
  yDomain, 
  yTicks,
  forceAlignment 
}: {
  data: Array<number | null | undefined>;
  labels?: string[];
  color?: string;
  valueFormat?: (v: number) => string;
  percentGrid?: boolean;
  yAxis?: boolean;
  highlightLastValue?: boolean;
  yDomain?: { min: number; max: number };
  yTicks?: number[];
  forceAlignment?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const containerHeight = containerRef.current.clientHeight;
        // Usar toda la altura disponible del contenedor menos un pequeño margen
        setHeight(Math.max(200, containerHeight - 20));
      }
    };

    updateHeight();
    
    const resizeObserver = new ResizeObserver(updateHeight);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      <TrendChart
        data={data}
        labels={labels}
        color={color}
        height={height}
        valueFormat={valueFormat}
        percentGrid={percentGrid}
        yAxis={yAxis}
        highlightLastValue={highlightLastValue}
        yDomain={yDomain}
        yTicks={yTicks}
        forceAlignment={forceAlignment}
      />
    </div>
  );
}

// AttendanceTrendCard ahora importado de forma lazy desde @/components/statistics/AttendanceTrendCard


type Period = '7d' | '30d' | '90d' | 'all';
type Level = 'basica' | 'media';

type Semester = 'all' | 'S1' | 'S2';

type StatsFilters = {
  // Filtros existentes
  courseSectionId?: string; // id compuesto courseId-sectionId
  level?: Level; // filtra por nivel del curso
  // Nuevos filtros (admin)
  courseId?: string;
  sectionId?: string;
  semester?: Exclude<Semester, 'all'>; // 'S1' | 'S2'
  // Filtro de asignatura (paridad con Calificaciones)
  subject?: string; // nombre/identificador de asignatura normalizado
  // Optimización de rendimiento: omitir procesamiento si gráficos están desactivados
  skipAttendanceProcessing?: boolean;
  skipComparisonProcessing?: boolean;
};

interface TimeWindow {
  from?: number; // epoch ms
}

const now = () => Date.now();
const days = (n: number) => n * 24 * 60 * 60 * 1000;

// Rango alineado a día: incluye hoy hasta 23:59:59.999 y retrocede (look-1) días hasta 00:00:00
function getDayAlignedRange(look: number, endTs?: number): { from: number; to: number } {
  const end = new Date(endTs ?? Date.now());
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(0, look - 1));
  start.setHours(0, 0, 0, 0);
  return { from: start.getTime(), to: end.getTime() };
}

function getTimeWindow(period: Period): TimeWindow {
  switch (period) {
    case '7d': return { from: getDayAlignedRange(7).from };
    case '30d': return { from: getDayAlignedRange(30).from };
    case '90d': return { from: getDayAlignedRange(90).from };
    default: return {}; // all time
  }
}

// KPIs agregados para ADMIN: Estudiantes, Cursos, Profesores, Asistencia
function useAdminKPIs(filters?: { level?: Level; courseId?: string; sectionId?: string; semester?: Exclude<Semester, 'all'>; year?: number; period?: Period }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onStorage = () => setTick(t => t + 1);
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    // 🔧 Reducir frecuencia de refresco de 4s a 10s para evitar parpadeos
    const id = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(id);
  }, []);

  // 🚀 Timeout para no esperar SQL indefinidamente (8 segundos - aumentado para IndexedDB con muchos datos)
  const [sqlTimeout, setSqlTimeout] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      console.log('[AdminKPIs] ⏰ Timeout de 8s alcanzado para SQL');
      setSqlTimeout(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  // SQL: asistencia por año
  const { isConnected: isAttendanceSQLConnected, getAttendanceByYear } = useAttendanceSQL();
  const [sqlAttendanceByYear, setSqlAttendanceByYear] = useState<Record<number, any[]>>({});
  // SQL: calificaciones y actividades por año (para estudiantes/ profesores)
  const { isConnected: isGradesSQLConnected, getActivitiesByYear, getGradesByYear } = useGradesSQL();
  const [sqlActivitiesByYear, setSqlActivitiesByYear] = useState<Record<number, any[]>>({});
  const [sqlGradesByYear, setSqlGradesByYear] = useState<Record<number, any[]>>({});

  // Estado salud Firebase (para que el indicador verde signifique conexión real a Firebase)
  const [firebaseHealthy, setFirebaseHealthy] = useState<boolean | null>(null);

  // Verificar salud de Firebase al montar (solo si está habilitado)
  useEffect(() => {
    const checkHealth = async () => {
      try {
        if (!isFirebaseEnabled()) { setFirebaseHealthy(false); return; }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const res = await fetch('/api/firebase/health', { cache: 'no-store', signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) { setFirebaseHealthy(false); return; }
        const data = await res.json().catch(() => ({}));
        setFirebaseHealthy(Boolean(data?.ok));
      } catch {
        setFirebaseHealthy(false);
      }
    };
    checkHealth();
  }, []);

  useEffect(() => {
    let mounted = true;
    const y = filters?.year ?? new Date().getFullYear();
    console.log(`[AdminKPIs] 🔄 useEffect asistencia ejecutándose para año ${y}, isAttendanceSQLConnected=${isAttendanceSQLConnected}`);
    const load = async () => {
      // Cargar siempre que haya año, sin esperar isConnected (el hook getAttendanceByYear ya maneja la conexión)
      if (!y) return;
      try {
        console.log(`[AdminKPIs] 📡 Llamando getAttendanceByYear(${y})...`);
        const arr = await getAttendanceByYear(y);
        console.log(`[AdminKPIs] getAttendanceByYear(${y}) devolvió:`, Array.isArray(arr) ? arr.length : 'no es array', 'sample:', Array.isArray(arr) ? arr.slice(0, 2) : arr);
        if (mounted) {
          setSqlAttendanceByYear(prev => {
            const newState = { ...prev, [y]: Array.isArray(arr) ? arr : [] };
            console.log(`[AdminKPIs] ✅ Estado sqlAttendanceByYear actualizado:`, Object.keys(newState).map(k => `${k}:${newState[Number(k)]?.length || 0}`));
            return newState;
          });
        }
      } catch (e) {
        console.warn('[AdminKPIs] Error cargando asistencia SQL:', e);
      }
    };
    load();
    const onSQL = () => {
      console.log(`[AdminKPIs] 📢 Evento sqlAttendanceUpdated recibido, recargando...`);
      load();
    };
    window.addEventListener('sqlAttendanceUpdated', onSQL as any);
    return () => { mounted = false; window.removeEventListener('sqlAttendanceUpdated', onSQL as any); };
  }, [getAttendanceByYear, filters?.year, isAttendanceSQLConnected]);
  useEffect(() => {
    let mounted = true;
    const y = filters?.year ?? new Date().getFullYear();
    const load = async () => {
      if (!isGradesSQLConnected || !y) return;
      try {
        const arr = await getActivitiesByYear(y);
        if (mounted) {
          setSqlActivitiesByYear(prev => ({ ...prev, [y]: Array.isArray(arr) ? arr : [] }));
        }
      } catch {}
    };
    load();
    const onSQL = () => load();
    window.addEventListener('sqlActivitiesUpdated', onSQL as any);
    return () => { mounted = false; window.removeEventListener('sqlActivitiesUpdated', onSQL as any); };
  }, [isGradesSQLConnected, getActivitiesByYear, filters?.year]);

  // Cargar calificaciones SQL por año para KPIs (usado para studentsCount)
  useEffect(() => {
    let mounted = true;
    const y = filters?.year ?? new Date().getFullYear();
    const load = async () => {
      if (!isGradesSQLConnected || !y) return;
      try {
        const arr = await getGradesByYear(y);
        if (mounted) {
          setSqlGradesByYear(prev => ({ ...prev, [y]: Array.isArray(arr) ? arr : [] }));
        }
      } catch {}
    };
    load();
    const onSQL = (e: any) => {
      const yEvt = Number(e?.detail?.year || y);
      if (Number.isFinite(yEvt)) load();
    };
    window.addEventListener('sqlGradesUpdated', onSQL as any);
    return () => { mounted = false; window.removeEventListener('sqlGradesUpdated', onSQL as any); };
  }, [isGradesSQLConnected, getGradesByYear, filters?.year]);

  const read = (key: string): any[] => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };

  return useMemo(() => {
    const users: any[] = read('smart-student-users');
  // Si se especifica año, usar claves segmentadas por año (coherente con Gestión Usuarios)
  const y = filters?.year; // Added year to filters
  
  // NOTA: Ya NO bloqueamos todos los KPIs cuando SQL está conectado pero sin datos.
  // Los contadores (estudiantes, cursos, secciones, profesores) se calculan desde localStorage
  // siempre. Solo el porcentaje de asistencia esperará los datos SQL si está conectado.
  // 🔧 NUEVO: Si hay timeout, no esperar más por SQL y usar datos locales
  const yearToCheck = y ?? new Date().getFullYear();
  const sqlAttendanceDataPending = isAttendanceSQLConnected && !sqlAttendanceByYear[yearToCheck] && !sqlTimeout;
  
  const coursesYearKeyAdmin = y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses';
  const coursesYearKeyUser = y ? `smart-student-courses-${y}` : 'smart-student-courses';
  const sectionsYearKeyAdmin = y ? `smart-student-admin-sections-${y}` : 'smart-student-admin-sections';
  const sectionsYearKeyUser = y ? `smart-student-sections-${y}` : 'smart-student-sections';
  const attendanceYearKey = y ? `smart-student-attendance-${y}` : 'smart-student-attendance'; // Added attendance year key
  
  // Debug: Log de diagnóstico para ver qué datos hay en localStorage
  if (typeof window !== 'undefined' && !(window as any).__kpisDebugLogged) {
    (window as any).__kpisDebugLogged = true;
    console.log('[KPIs Debug] Año:', y || yearToCheck);
    console.log('[KPIs Debug] Cursos admin:', read(coursesYearKeyAdmin).length, 'legacy:', read('smart-student-admin-courses').length);
    console.log('[KPIs Debug] Cursos user:', read(coursesYearKeyUser).length, 'legacy:', read('smart-student-courses').length);
    console.log('[KPIs Debug] Secciones admin:', read(sectionsYearKeyAdmin).length, 'legacy:', read('smart-student-admin-sections').length);
    console.log('[KPIs Debug] Secciones user:', read(sectionsYearKeyUser).length, 'legacy:', read('smart-student-sections').length);
    console.log('[KPIs Debug] Usuarios globales:', users.length, 'estudiantes:', users.filter((u:any)=>u?.role==='student'||u?.role==='estudiante').length);
    console.log('[KPIs Debug] SQL Attendance connected:', isAttendanceSQLConnected, 'Grades connected:', isGradesSQLConnected);
    console.log('[KPIs Debug] SQL Attendance data:', sqlAttendanceByYear[yearToCheck]?.length || 0, 'sample:', sqlAttendanceByYear[yearToCheck]?.slice(0, 2));
    console.log('[KPIs Debug] SQL Grades:', sqlGradesByYear[yearToCheck]?.length || 0);
    console.log('[KPIs Debug] sqlTimeout:', sqlTimeout, 'sqlAttendanceDataPending:', sqlAttendanceDataPending);
    console.log('[KPIs Debug] Filtros:', filters);
  }
  
  // Cursos y secciones con fallback múltiple a claves legacy si el año segmentado está vacío
  const allCourses: any[] = (() => {
    // 1. Intentar claves segmentadas por año (admin + user)
    const list = [...read(coursesYearKeyAdmin), ...read(coursesYearKeyUser)];
    if (list.length > 0) return list;
    // 2. Fallback a claves legacy sin año
    const legacy = [...read('smart-student-admin-courses'), ...read('smart-student-courses')];
    if (legacy.length > 0) return legacy;
    // 3. Usar LocalStorageManager como último recurso
    try {
      const fromManager = LocalStorageManager.getCoursesForYear?.(y || new Date().getFullYear()) || [];
      if (Array.isArray(fromManager) && fromManager.length > 0) return fromManager;
      return LocalStorageManager.getCourses?.() || [];
    } catch { return []; }
  })();
  const allSections: any[] = (() => {
    // 1. Intentar claves segmentadas por año (admin + user)
    const list = [...read(sectionsYearKeyAdmin), ...read(sectionsYearKeyUser)];
    if (list.length > 0) return list;
    // 2. Fallback a claves legacy sin año
    const legacy = [...read('smart-student-admin-sections'), ...read('smart-student-sections')];
    if (legacy.length > 0) return legacy;
    // 3. Usar LocalStorageManager como último recurso
    try {
      const fromManager = LocalStorageManager.getSectionsForYear?.(y || new Date().getFullYear()) || [];
      if (Array.isArray(fromManager) && fromManager.length > 0) return fromManager;
      const globalSections = LocalStorageManager.getSections?.() || [];
      if (Array.isArray(globalSections) && globalSections.length > 0) return globalSections;
    } catch {}
    // 4. Generar secciones virtuales basadas en los cursos existentes (si hay cursos pero no secciones)
    // Esto es un fallback de emergencia para mostrar algo mientras los datos se sincronizan
    const courses = [...read(coursesYearKeyAdmin), ...read(coursesYearKeyUser), ...read('smart-student-admin-courses'), ...read('smart-student-courses')];
    if (courses.length > 0) {
      // Generar 2 secciones por curso (A y B) como placeholder
      const virtualSections: any[] = [];
      courses.forEach((c: any) => {
        if (!c?.id) return;
        ['A', 'B'].forEach(letter => {
          virtualSections.push({
            id: `${c.id}-${letter}`,
            sectionId: `${c.id}-${letter}`,
            courseId: c.id,
            name: letter,
            course: { id: c.id, name: c.name }
          });
        });
      });
      return virtualSections;
    }
    return [];
  })();

    // Asignaciones y asistencia segmentadas por año (fallback a legacy si no existen por año)
    const studentAssignments: any[] = (() => {
      if (y) {
        const yearKey = `smart-student-student-assignments-${y}`;
        const list = read(yearKey);
        if (list.length) return list;
      }
      return read('smart-student-student-assignments');
    })();
    const teacherAssignments: any[] = (() => {
      if (y) {
        const yearKey = `smart-student-teacher-assignments-${y}`;
        const list = read(yearKey);
        if (list.length) return list;
      }
      return read('smart-student-teacher-assignments');
    })();
    const attendance: any[] = (() => {
      // 🔧 PRIORIDAD: IndexedDB/SQL primero, localStorage como fallback
      const y2 = filters?.year ?? new Date().getFullYear();
      
      // 1. Intentar primero desde IndexedDB/SQL (fuente principal)
      // 🔧 CORREGIDO: Usar SQL si hay datos, independiente del timeout
      const sqlArr = sqlAttendanceByYear[y2];
      if (Array.isArray(sqlArr) && sqlArr.length > 0) {
        console.log(`[AdminKPIs] ✅ Usando ${sqlArr.length} registros de IndexedDB/SQL para año ${y2}`);
        return sqlArr;
      } else {
        console.log(`[AdminKPIs] ⚠️ No hay registros SQL para año ${y2}. sqlAttendanceByYear keys:`, Object.keys(sqlAttendanceByYear), 'sqlTimeout:', sqlTimeout);
      }
      
      // 2. Fallback a localStorage (solo si SQL no tiene datos)
      let localData: any[] = [];
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { LocalStorageManager } = require('@/lib/education-utils');
        if (y) {
          const expanded = LocalStorageManager.getAttendanceForYear(y) || [];
          if (Array.isArray(expanded) && expanded.length) {
            localData = expanded;
            console.log(`[AdminKPIs] Fallback: Usando ${localData.length} registros de LocalStorage para año ${y}`);
          }
        }
        if (!localData.length) {
          const globalLegacy = LocalStorageManager.getAttendance?.() || [];
          if (Array.isArray(globalLegacy) && globalLegacy.length && y) {
            localData = globalLegacy.filter((r:any)=> {
              const ts = parseWhen(r);
              if (!ts) return false;
              return new Date(ts).getFullYear() === y;
            });
          }
        }
      } catch {}
      
      if (localData.length > 0) return localData;
      
      // 3. Fallbacks adicionales si todo lo anterior falló
      try {
        const rawGlobal = localStorage.getItem('smart-student-attendance');
        if (rawGlobal) {
          const parsed = JSON.parse(rawGlobal);
          if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && y) {
            const yearArr = parsed[String(y)];
            if (Array.isArray(yearArr) && yearArr.length) return yearArr;
          }
        }
      } catch {}
      
      if (y) {
        const raw = localStorage.getItem(`smart-student-attendance-${y}`);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object') {
              if (Array.isArray((parsed as any).data)) return (parsed as any).data;
              if (Array.isArray((parsed as any).records)) return (parsed as any).records;
            }
          } catch {}
        }
      }
      
      return [];
    })();

    const levelByCourseId: Record<string, Level | undefined> = {};
    allCourses.forEach((c: any) => { if (c?.id) levelByCourseId[String(c.id)] = c.level as Level | undefined; });

    const matchSemester = (ts?: number) => {
      if (!filters?.semester) return true;
      if (!ts) return true;
      try {
        const y = filters.year || new Date(ts).getFullYear();
        const rng = __getSemesterRange(y, filters.semester);
        if (rng.start && rng.end) {
          return ts >= rng.start && ts <= rng.end;
        }
      } catch {}
      // Fallback mes-a-mes solo si no hay configuración en Calendario
      const m = new Date(ts).getMonth() + 1;
      return filters.semester === 'S1' ? m >= 3 && m <= 6 : m >= 7 && m <= 12;
    };
    const matchLevelCourse = (courseId?: string) => {
      if (!filters?.level) return true;
      if (!courseId) return false;
      return levelByCourseId[String(courseId)] === filters.level;
    };
    const matchCourse = (courseId?: string) => {
      if (filters?.courseId && String(courseId) !== String(filters.courseId)) return false;
      return true;
    };
    const matchSection = (sectionId?: string) => {
      if (filters?.sectionId && String(sectionId) !== String(filters.sectionId)) return false;
      return true;
    };

    // Cursos (conteo) dinámico considerando filtros de curso, sección o nivel
    let coursesCount = 0;
    if (filters?.courseId) {
      // Curso seleccionado explícitamente
      coursesCount = 1;
    } else if (filters?.sectionId) {
      // Derivar curso desde la sección seleccionada
      const sec = allSections.find((s:any)=> String(s?.id || s?.sectionId) === String(filters.sectionId));
      const parentCourseId = String(sec?.courseId || (sec?.course && (sec.course.id || sec.course.courseId)) || '');
      if (parentCourseId) {
        if (filters?.level) {
          const cMeta = allCourses.find((c:any)=> String(c?.id) === parentCourseId);
            if (cMeta && (cMeta.level as Level|undefined) === filters.level) {
              coursesCount = 1;
            } else {
              coursesCount = 0; // sección no pertenece al nivel filtrado
            }
        } else {
          coursesCount = 1;
        }
      } else {
        coursesCount = 0;
      }
    } else {
      const uniqueCourseIds = new Set<string>();
      allCourses.forEach((c: any) => {
        const id = String(c?.id);
        if (!id) return;
        if (filters?.level && (c?.level as Level | undefined) !== filters.level) return;
        uniqueCourseIds.add(id);
      });
      coursesCount = uniqueCourseIds.size;
    }

    // Estudiantes (ROSTER): contar estudiantes asignados desde Gestión de Usuarios por AÑO y filtros
    // Objetivo: que el KPI de "Estudiantes" refleje el total real del proyecto (por curso/sección/nivel),
    // igual que en la pestaña Gestión de Usuarios, sin depender de calificaciones o asistencia.
    let studentsCount = 0;
    {
      const yRef = filters?.year || new Date().getFullYear();
      // 1) Obtener catálogo de estudiantes por año (preferido)
      let studentsArr: any[] = [];
      try {
        studentsArr = LocalStorageManager.getStudentsForYear?.(yRef) || [];
      } catch {}
      // 2) Fallback: clave legacy específica del año
      if (!Array.isArray(studentsArr) || studentsArr.length === 0) {
        try {
          const legacyYear = JSON.parse(localStorage.getItem(`smart-student-students-${yRef}`) || '[]');
          if (Array.isArray(legacyYear)) studentsArr = legacyYear;
        } catch {}
      }
      // 3) Último recurso: lista global de usuarios (filtrar estudiantes)
      if (!Array.isArray(studentsArr) || studentsArr.length === 0) {
        try {
          const usersGlobal = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
          if (Array.isArray(usersGlobal)) {
            studentsArr = usersGlobal.filter((u: any) => (u?.role === 'student' || u?.role === 'estudiante'));
          }
        } catch {}
      }

      // Considerar solo estudiantes asignados (con courseId y sectionId) para alinear con Gestión de Usuarios
      // y aplicar filtros de nivel/curso/sección. Ignoramos filtros de tiempo (period/semester) pues el roster no depende de fechas.
      try {
        // Primero intentar obtener estudiantes asignados (con courseId y sectionId)
        const assigned = (Array.isArray(studentsArr) ? studentsArr : [])
          .filter((s: any) => s && s.courseId && s.sectionId)
          .filter((s: any) => {
            const cid = String(s.courseId || '');
            const sid = String(s.sectionId || '');
            if (filters?.courseId && cid !== String(filters.courseId)) return false;
            if (filters?.sectionId && sid !== String(filters.sectionId)) return false;
            if (filters?.level && levelByCourseId[cid] !== filters.level) return false;
            return true;
          });
        studentsCount = assigned.length;

        // Si no hay asignados, mostrar el total de estudiantes del array (sin requerir asignación)
        if (studentsCount === 0 && Array.isArray(studentsArr) && studentsArr.length > 0) {
          // Si hay filtros específicos pero no hay asignaciones, mostrar 0 (correcto)
          // Si NO hay filtros, mostrar el total de estudiantes disponibles
          if (!filters?.courseId && !filters?.sectionId && !filters?.level) {
            studentsCount = studentsArr.filter((s: any) => {
              // Filtrar solo registros que parezcan ser estudiantes
              if (s?.role && s.role !== 'student' && s.role !== 'estudiante') return false;
              return true;
            }).length;
          }
        }
        
        // 4) Fallback: extraer estudiantes únicos desde calificaciones SQL si no hay estudiantes
        if (studentsCount === 0 && isGradesSQLConnected && sqlGradesByYear[yRef]) {
          const grades = sqlGradesByYear[yRef] || [];
          const uniqueStudentIds = new Set<string>();
          grades.forEach((g: any) => {
            const studentId = String(g.studentId || g.student_id || g.studentUsername || g.username || '').toLowerCase();
            if (studentId && studentId !== 'undefined') {
              const cid = String(g.courseId || g.course_id || '');
              const sid = String(g.sectionId || g.section_id || '');
              // Aplicar filtros si existen
              if (filters?.courseId && cid !== String(filters.courseId)) return;
              if (filters?.sectionId && sid !== String(filters.sectionId)) return;
              if (filters?.level && levelByCourseId[cid] !== filters.level) return;
              uniqueStudentIds.add(studentId);
            }
          });
          if (uniqueStudentIds.size > 0) {
            studentsCount = uniqueStudentIds.size;
          }
        }
      } catch {}
    }

    // Profesores: contar profesores únicos desde múltiples fuentes
    let teachersCount = 0;
    {
      const yRef = filters?.year || new Date().getFullYear();
      const periodFrom = (filters?.period && filters.period !== 'all') ? (getTimeWindow(filters.period).from) : undefined;
      
      // 1) Intentar desde actividades SQL (assignedById)
      const acts: any[] = (isGradesSQLConnected && Array.isArray(sqlActivitiesByYear[yRef])) ? sqlActivitiesByYear[yRef] : [];
      const set = new Set<string>();
      for (const a of acts) {
        const ts = parseWhen(a?.createdAt || a?.startAt || a?.openAt);
        if (typeof ts === 'number') {
          const d = new Date(ts);
          if (d.getFullYear() !== yRef) continue;
          if (filters?.semester && !matchSemester(ts)) continue;
          if (periodFrom && ts < periodFrom) continue;
        }
        const cid = String(a?.courseId || a?.course || '');
        const sid = String(a?.sectionId || a?.section || '');
        if (filters?.courseId && cid !== String(filters.courseId)) continue;
        if (filters?.sectionId && sid !== String(filters.sectionId)) continue;
        if (filters?.level && !matchLevelCourse(cid)) continue;
        const teacherRaw = String(a?.assignedById || a?.assignedByName || '').trim();
        if (!teacherRaw) continue;
        const lower = teacherRaw.toLowerCase();
        if (lower === 'system' || lower === 'sistema') continue; // excluir generadas por el sistema
        set.add(lower);
      }
      teachersCount = set.size;
      
      // 2) Fallback: usar asignaciones de profesores si existen
      if (teachersCount === 0 && teacherAssignments.length > 0) {
        const uniqueTeachers = new Set<string>();
        teacherAssignments.forEach((ta: any) => {
          const cid = String(ta.courseId || '');
          const sid = String(ta.sectionId || '');
          
          if (filters?.courseId && cid !== String(filters.courseId)) return;
          if (filters?.sectionId && sid !== String(filters.sectionId)) return;
          if (filters?.level && !matchLevelCourse(cid)) return;
          
          if (ta.teacherId) uniqueTeachers.add(String(ta.teacherId));
        });
        teachersCount = uniqueTeachers.size;
      }
      
      // 3) Fallback: usar catálogo de profesores desde localStorage
      if (teachersCount === 0) {
        try {
          // Intentar con LocalStorageManager
          const teachers = LocalStorageManager.getTeachersForYear?.(yRef) || [];
          if (Array.isArray(teachers) && teachers.length > 0) {
            teachersCount = teachers.length;
          } else {
            // Fallback a usuarios globales con rol profesor
            const usersGlobal = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
            if (Array.isArray(usersGlobal)) {
              teachersCount = usersGlobal.filter((u: any) => 
                u?.role === 'teacher' || u?.role === 'profesor' || u?.role === 'admin'
              ).length;
            }
          }
        } catch {}
      }
    }

    // Asistencia (% presente/total), con filtros
    const parseCourseSection = (obj: any): { courseId?: string; sectionId?: string } => {
      const cs = obj?.course || obj?.courseSectionId;
      if (typeof cs === 'string' && cs.includes('-')) {
        const parts = cs.split('-');
        return { courseId: parts.slice(0, parts.length - 1).join('-'), sectionId: parts[parts.length - 1] };
      }
      return { courseId: String(obj?.courseId || obj?.course || ''), sectionId: String(obj?.sectionId || obj?.section || '') };
    };
    // --- Asistencia dinámica robusta ---
    const sectionCourseMapForAttendance: Record<string,string> = {};
    allSections.forEach(s => {
      const sid = String(s?.id || s?.sectionId || '');
      const cid = String(s?.courseId || (s?.course && (s.course.id || s.course.courseId)) || '');
      if (sid && cid) sectionCourseMapForAttendance[sid] = cid;
    });

  const presentTokens = ['present','presente','p','asistio','asistió','asistencia','ok','attended','1','true','t','si','sí','y','tarde','atraso','atrasado','late'];
  const absentTokens  = ['absent','ausente','a','falta','0','no','false','n'];
    const norm = (v:any):string => {
      if (v === true) return 'true';
      if (v === false) return 'false';
      if (v === 1) return '1';
      if (v === 0) return '0';
      if (v == null) return '';
  return String(v).trim().toLowerCase().replace(/[\.]$/,'');
    };
    const extractPresent = (rec:any):boolean|undefined => {
      // booleanos directos
      if (typeof rec.present === 'boolean') return rec.present;
      if (typeof rec.attended === 'boolean') return rec.attended;
      if (typeof rec.isPresent === 'boolean') return rec.isPresent;
      if (rec.present === 1 || rec.attended === 1 || rec.isPresent === 1) return true;
      if (rec.present === 0 || rec.attended === 0 || rec.isPresent === 0) return false;
  const fields = ['status','attendance','state','resultado','mark','value','flag','code','estado','Estado','EstadoAsistencia'];
      for (const f of fields) {
        if (f in rec) {
          const val = norm(rec[f]);
            if (presentTokens.includes(val)) return true;
            if (absentTokens.includes(val)) return false;
        }
      }
      // textual general
      const joined = norm(rec.status || rec.attendance || rec.state || rec.resultado || rec.mark || rec.value || rec.flag || rec.code || rec.estado || rec.descripcion);
      if (presentTokens.includes(joined)) return true;
      if (absentTokens.includes(joined)) return false;
      return undefined;
    };
    const extendedParse = (rec:any):{courseId?:string; sectionId?:string} => {
      let { courseId, sectionId } = parseCourseSection(rec);
      if (!courseId) courseId = String(rec.courseID || rec.cursoId || rec.curso || rec.course_id || rec.courseid || '');
      if (!sectionId) sectionId = String(rec.sectionID || rec.seccionId || rec.seccion || rec.section_id || rec.sectionid || '');
      if ((!courseId || courseId === 'undefined') && sectionId) courseId = sectionCourseMapForAttendance[sectionId];
      // Intento adicional: si viene nombre de curso en español ("1ro Básico") y no id
      if (!courseId) {
        const rawName = rec.Curso || rec.courseName || rec.courseLabel || rec.courseTitle || rec.nombreCurso;
        if (rawName) {
          const normTxt = (s:string)=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
          const target = normTxt(String(rawName));
          const found = allCourses.find((c:any)=>{
            const cand = normTxt(String(c.fullName||c.displayName||c.longName||c.label||c.gradeName||c.name||''));
            return cand === target;
          });
          if (found?.id) courseId = String(found.id);
        }
      }
      // Si la sección viene como letra en campo 'Sección' y no hay ID
      if (!sectionId) {
        const secRaw = rec.Seccion || rec['Sección'] || rec.sectionName || rec.sectionLabel;
        if (secRaw) {
          const letter = String(secRaw).trim();
          // Buscar sección cuyo nombre coincida y curso coincida (si ya lo tenemos)
          const foundSec = allSections.find((s:any)=>{
            const sid = String(s.id||s.sectionId||'');
            const label = String(s.name||s.label||'').trim();
            const matchesLetter = label === letter || sid.endsWith('-'+letter);
            if (!matchesLetter) return false;
            if (courseId) {
              const cid = String(s.courseId || (s.course && (s.course.id || s.course.courseId)) || '');
              return cid === courseId;
            }
            return matchesLetter;
          });
          if (foundSec) {
            sectionId = String(foundSec.id || foundSec.sectionId);
            if (!courseId) courseId = String(foundSec.courseId || (foundSec.course && (foundSec.course.id || foundSec.course.courseId)) || '');
          }
        }
      }
      return { courseId, sectionId };
    };

    // --- Cálculo de asistencia (normalizado por días hábiles transcurridos del semestre/año) ---
  let daysPresent = 0; // días con al menos un presente (para posible uso futuro)
  let daysElapsed = 0;   // días hábiles transcurridos (para porcentaje)
  let daysPeriodTotal = 0; // días hábiles totales del periodo completo

    // Determinar ventana (período, semestre, o año completo)
    const yearRef = filters?.year || new Date().getFullYear();
    const resolveWindow = (): { start: Date; end: Date } => {
      const today = new Date();
      
      // PRIORIDAD 1: Si hay filtro de período (7d, 30d, 90d), usar ese rango
      if (filters?.period && filters.period !== 'all') {
        const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
        const days = daysMap[filters.period];
        if (days) {
          const start = new Date(today);
          start.setDate(start.getDate() - days);
          return { start, end: today };
        }
      }
      
      // PRIORIDAD 2: Si hay filtro de semestre
      if (filters?.semester) {
        try {
          const rng = __getSemesterRange(yearRef, filters.semester);
          if (rng.start && rng.end) {
            return { start: new Date(rng.start), end: new Date(rng.end) };
          }
        } catch {}
        // Fallback mes-a-mes si no hay configuración en Calendario
        return filters.semester === 'S1'
          ? { start: new Date(yearRef,2,1), end: new Date(yearRef,5,30) }
          : { start: new Date(yearRef,6,1), end: new Date(yearRef,11,31) };
      }
      // Año completo si no hay filtros
      return { start: new Date(yearRef,0,1), end: new Date(yearRef,11,31) };
    };
    const windowRange = resolveWindow();
    // Limitar end a hoy para días transcurridos
    const today = new Date();
    const effectiveEnd = windowRange.end > today ? today : windowRange.end;
    // --- Cálculo usando calendario admin (feriados, vacaciones) ---
    type _VacationRange = { start?: string; end?: string };
    type _CalendarCfg = { showWeekends?: boolean; summer?: _VacationRange; winter?: _VacationRange; holidays?: string[] };
    const _keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const _parseYmd = (ymd?: string): Date | null => { if(!ymd) return null; const [Y,M,D]=ymd.split('-').map(Number); if(!Y||!M||!D) return null; const dt=new Date(Y,(M||1)-1,D||1); return isNaN(dt.getTime())?null:dt; };
    const _inRange = (d: Date, r?: _VacationRange): boolean => { if(!r?.start||!r?.end) return false; const a=_parseYmd(r.start); const b=_parseYmd(r.end); if(!a||!b) return false; const t=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); const [min,max]=a.getTime()<=b.getTime()?[a.getTime(),b.getTime()]:[b.getTime(),a.getTime()]; return t>=min && t<=max; };
    const _getCfg = (year:number): _CalendarCfg => { try { const raw = localStorage.getItem(`admin-calendar-${year}`); if(!raw) return {}; const parsed=JSON.parse(raw); if(parsed && typeof parsed==='object') return parsed as _CalendarCfg; } catch{} return {}; };
    const _isInstructional = (d: Date): boolean => {
      const cfg=_getCfg(d.getFullYear());
      const dow=d.getDay();
      const weekday=dow>=1 && dow<=5; // L-V solamente
      if(!weekday) return false;
      const holidays=Array.isArray(cfg.holidays)?cfg.holidays:[];
      if(holidays.includes(_keyOf(d))) return false;
      if(_inRange(d,cfg.summer)) return false;
      if(_inRange(d,cfg.winter)) return false;
      return true;
    };
    for (let d = new Date(windowRange.start); d <= effectiveEnd; d.setDate(d.getDate()+1)) {
      if (_isInstructional(d)) daysElapsed++;
    }
    for (let d = new Date(windowRange.start); d <= windowRange.end; d.setDate(d.getDate()+1)) {
      if (_isInstructional(d)) daysPeriodTotal++;
    }
  // Alias backward compatibility: algunos renders memorizados pueden referirse aún a daysTotal
  // Evita ReferenceError si queda alguna referencia en closures antiguos.
  // @ts-ignore
  const daysTotal = daysElapsed;

    interface DayStat { presentIds: Set<string>; aggregateMax: number; }
    const dayStats: Record<string, DayStat> = {};
    const getDayStat = (t:number): DayStat => {
      const dayKey = new Date(t).toISOString().slice(0,10);
      if (!dayStats[dayKey]) dayStats[dayKey] = { presentIds: new Set<string>(), aggregateMax: 0 };
      return dayStats[dayKey];
    };

    // Recorrer registros aplicando filtros y semestre
    if (Array.isArray(attendance)) {
      attendance.forEach((rec:any) => {
      if (!rec) return;
      const t = parseWhen(rec);
      if (!t) return;
      if (t < windowRange.start.getTime() || t > windowRange.end.getTime()) return; // fuera del rango
      if (filters?.semester && !matchSemester(t)) return;
      const { courseId, sectionId } = extendedParse(rec);
      if (filters?.level && !matchLevelCourse(courseId)) return;
      if (!matchCourse(courseId)) return;
      if (!matchSection(sectionId)) return;
      const ds = getDayStat(t);

      // Caso 1: registro agregado (sin lista individual)
      if (typeof rec.presentCount === 'number' && typeof rec.totalCount === 'number' && rec.totalCount > 0) {
        ds.aggregateMax = Math.max(ds.aggregateMax, Math.min(rec.presentCount, rec.totalCount));
        return;
      }
      // Caso 2: listas de estudiantes
      if (Array.isArray(rec.presentStudents) || Array.isArray(rec.presentStudentUsernames) || Array.isArray(rec.students)) {
        const explicitPresent = new Set<string>((rec.presentStudents || rec.presentStudentUsernames || []).map((x:any)=>String(x?.username||x).toLowerCase()));
        if (Array.isArray(rec.students) && rec.students.length) {
          rec.students.forEach((s:any)=>{
            const flag = extractPresent(s);
            if (flag === true) explicitPresent.add(String(s.username||s.id||'').toLowerCase());
          });
        }
        explicitPresent.forEach(id => ds.presentIds.add(id));
        return;
      }
      // Caso 3: registro individual
      const p = extractPresent(rec);
      if (p === true) {
        const sid = String(rec.studentUsername || rec.studentId || rec.username || rec.user || '').toLowerCase();
        if (sid) ds.presentIds.add(sid);
      }
    });
    }

    // Calcular presentes acumulados únicos por día (max entre individuales y agregado)
    let sumPresentAcrossDays = 0;
    Object.keys(dayStats).forEach(dayKey => {
      const st = dayStats[dayKey];
      const count = Math.max(st.presentIds.size, st.aggregateMax);
      if (count > 0) daysPresent++;
      sumPresentAcrossDays += count;
    });

    // Estudiantes esperados (ya calculado arriba como studentsCount) multiplicado por días hábiles transcurridos
    const expectedStudentsPerDay = studentsCount > 0 ? studentsCount : 0;
    const expectedTotalPresence = expectedStudentsPerDay * daysElapsed;
    let attendancePct = expectedTotalPresence > 0 ? (sumPresentAcrossDays / expectedTotalPresence) * 100 : 0;
    const avgDaysAttendedPerStudent = studentsCount > 0 ? (sumPresentAcrossDays / studentsCount) : 0;

      // Crear mapa de nombre de curso normalizado -> courseId (para CSVs sin IDs)
      const normalizeCourseName = (s: string) => {
        let n = String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        n = n.replace(/\b1ro\b|\bprimero\b|\bprimer\b/g, '1')
             .replace(/\b2do\b|\bsegundo\b/g, '2')
             .replace(/\b3ro\b|\btercero\b|\btercer\b/g, '3')
             .replace(/\b4to\b|\bcuarto\b/g, '4')
             .replace(/\b5to\b|\bquinto\b/g, '5')
             .replace(/\b6to\b|\bsexto\b/g, '6')
             .replace(/\b7mo\b|\bseptimo\b|\bséptimo\b/g, '7')
             .replace(/\b8vo\b|\boctavo\b/g, '8')
             .replace(/°/g, '')
             .replace(/[^a-z0-9]/g, '');
        return n;
      };
      
      // Función para extraer "grado clave" de un nombre de curso (ej: "1ro Básico A" -> "1basico", "2do Medio B" -> "2medio")
      const extractGradeKey = (courseName: string): string | undefined => {
        const n = String(courseName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        // Extraer número de grado
        let gradeNum: string | undefined;
        const numMatch = n.match(/(\d+)/);
        if (numMatch) {
          gradeNum = numMatch[1];
        } else {
          // Intentar con palabras
          if (/primero|primer|1ro/.test(n)) gradeNum = '1';
          else if (/segundo|2do/.test(n)) gradeNum = '2';
          else if (/tercero|tercer|3ro/.test(n)) gradeNum = '3';
          else if (/cuarto|4to/.test(n)) gradeNum = '4';
          else if (/quinto|5to/.test(n)) gradeNum = '5';
          else if (/sexto|6to/.test(n)) gradeNum = '6';
          else if (/septimo|7mo/.test(n)) gradeNum = '7';
          else if (/octavo|8vo/.test(n)) gradeNum = '8';
        }
        // Extraer nivel - NORMALIZADO a 'basica' y 'media' (femenino consistente)
        let level: string | undefined;
        if (/medio|media/.test(n)) level = 'media';
        else if (/basico|basica|bsico/.test(n)) level = 'basica';
        
        if (gradeNum && level) return `${gradeNum}${level}`;
        return undefined;
      };

    // Override ANUAL (sin filtros) solicitado: usar fórmula global
    // % = PresentesTotalesAnuales / RegistrosTotalesAnuales * 100
    // Aplica solo cuando NO hay filtros de nivel/curso/sección/semestre (vista global) para el año seleccionado.
    // Override ANUAL (sin filtros), POR SEMESTRE, POR NIVEL, POR CURSO o POR SECCIÓN solicitado: usar fórmula global
    // % = PresentesTotalesAnuales / RegistrosTotalesAnuales * 100
    // Aplica siempre que no se haya aplicado ya el cálculo progresivo anterior
    
    // 🔧 MOVIDO AFUERA: Variables para tracking de registros procesados
    let totalRecords = 0;
    let presentRecords = 0;
    
    if (true) { // Siempre aplicar el cálculo optimizado
      const filterYear = filters?.year; // si viene definido se usa solo ese año; si no, se abarcan todos los años con datos
      const filterSemester = filters?.semester; // S1 o S2
      const filterLevel = filters?.level; // basica o media
      const filterCourseId = filters?.courseId; // ID específico del curso
      const filterSectionId = filters?.sectionId; // ID específico de la sección
      
      // 🔧 NUEVO: Obtener la letra de la sección del filtro para matching con carga masiva
      let filterSectionLetter: string | undefined;
      let filterSectionName: string | undefined;
      if (filterSectionId) {
        // Buscar en el catálogo de secciones
        const sectionFromCatalog = allSections.find((s: any) => 
          String(s?.id || s?.sectionId || '') === filterSectionId
        );
        if (sectionFromCatalog) {
          filterSectionName = String(sectionFromCatalog?.name || sectionFromCatalog?.fullName || sectionFromCatalog?.label || '').toLowerCase().trim();
          // Extraer letra de sección (A, B, C, etc)
          filterSectionLetter = filterSectionName.length === 1 && /^[a-z]$/i.test(filterSectionName)
            ? filterSectionName 
            : (filterSectionName.match(/[a-z]$/i)?.[0]?.toLowerCase() || undefined);
        }
        console.log('[AdminKPIs] 🔍 Filtro de sección:', { filterSectionId, filterSectionName, filterSectionLetter });
      }

      // Si hay filtro de semestre, obtener rango de fechas del semestre
      let semesterFromTs: number | undefined;
      let semesterToTs: number | undefined;
      
      if (filterSemester) {
        const yearTarget = filterYear || new Date().getFullYear();
        const rng = __getSemesterRange(yearTarget, filterSemester);
        if (rng.start && rng.end) { 
          semesterFromTs = rng.start; 
          semesterToTs = rng.end;
          console.log('[AdminKPIs] Rango de semestre calculado:', {
            semester: filterSemester,
            year: yearTarget,
            from: new Date(rng.start).toISOString().slice(0, 10),
            to: new Date(rng.end).toISOString().slice(0, 10)
          });
        } else {
          console.warn('[AdminKPIs] No se encontró configuración de semestre para:', filterSemester, yearTarget);
        }
      }
      
      // Si hay filtro de nivel, obtener IDs de cursos de ese nivel
      let levelCourseIds: Set<string> | undefined;
      if (filterLevel) {
        levelCourseIds = new Set();
        
        // Función para inferir nivel del nombre del curso si no tiene campo level
        const inferLevelFromName = (courseName: string): 'basica' | 'media' | undefined => {
          const name = String(courseName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          // Detectar "medio" o "media" en el nombre
          if (/medio|media/i.test(name)) return 'media';
          // Detectar patrones de básica: "basico", "básica", o números 1-8 seguidos de "basico"
          if (/basico|basica/i.test(name)) return 'basica';
          // Detectar patrón: 1ro-8vo básico
          if (/^[1-8](ro|do|to|ero|vo|mo)\s*/i.test(name) && !/medio|media/i.test(name)) return 'basica';
          // Detectar patrón: 1ro-4to medio
          if (/^[1-4](ro|do|to|ero)\s*(medio|media)/i.test(name)) return 'media';
          return undefined;
        };
        
        allCourses.forEach((course: any) => {
          if (!course?.id) return;
          
          // Usar campo level si existe, sino inferir del nombre
          let courseLevel = course.level;
          const courseName = course.name || course.fullName || course.displayName || course.gradeName || '';
          if (!courseLevel) {
            courseLevel = inferLevelFromName(courseName);
          }
          
          if (courseLevel === filterLevel) {
            levelCourseIds!.add(String(course.id));
            // 🔧 NUEVO: También agregar el nombre normalizado estilo toId
            // para matching con datos de carga masiva
            const toIdStyleName = courseName ? String(courseName).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, '') : '';
            if (toIdStyleName) {
              levelCourseIds!.add(toIdStyleName);
            }
          }
        });
        
        // Si no encontramos cursos del nivel, mostrar advertencia
        if (levelCourseIds.size === 0) {
          console.warn('[AdminKPIs] No se encontraron cursos para el nivel:', filterLevel, '- Cursos disponibles:', allCourses.map((c:any) => ({ id: c?.id, name: c?.name, level: c?.level })).slice(0, 5));
        }
      }
      
      // Crear mapa de sectionId -> courseId para poder filtrar por nivel/curso usando sectionId
      const sectionToCourseMap: Record<string, string> = {};
      // Mapa de nombre de sección normalizado -> sectionId (para CSVs sin IDs)
      const sectionNameToIdMap: Record<string, string> = {};
      // Mapa de sectionId -> nombre de sección
      const sectionIdToNameMap: Record<string, string> = {};
      // Mapa de sectionId -> gradeKey del curso padre (para matching por grado+nivel)
      const sectionIdToGradeKeyMap: Record<string, string> = {};
      // Mapa de sectionId -> nombre de sección (A, B, etc)
      const sectionIdToSectionNameMap: Record<string, string> = {};
      
      allSections.forEach((sec: any) => {
        const secId = String(sec?.id || sec?.sectionId || '');
        const cId = String(sec?.courseId || (sec?.course && (sec.course.id || sec.course.courseId)) || '');
        const secName = String(sec?.name || sec?.fullName || sec?.displayName || sec?.label || '').toLowerCase().trim();
        // Extraer solo la letra de sección (A, B, C)
        const sectionLetter = secName.match(/[a-z]$/i)?.[0]?.toLowerCase() || secName;
        
        if (secId && cId) {
          sectionToCourseMap[secId] = cId;
          // Obtener gradeKey del curso padre
          const parentCourse = allCourses.find((c: any) => String(c?.id || '') === cId);
          if (parentCourse) {
            const parentCourseName = parentCourse?.name || parentCourse?.fullName || parentCourse?.displayName || '';
            const gradeKey = extractGradeKey(parentCourseName);
            if (gradeKey) {
              sectionIdToGradeKeyMap[secId] = gradeKey;
            }
          }
        }
        if (secId && secName) {
          sectionNameToIdMap[secName] = secId;
          sectionIdToNameMap[secId] = secName;
          sectionIdToSectionNameMap[secId] = sectionLetter;
        }
      });
      
      
      const courseNameToIdMap: Record<string, string> = {};
      const courseIdToLevelMap: Record<string, 'basica' | 'media'> = {};
      // 🔧 NUEVO: Mapa de nombre normalizado estilo toId -> nivel (para matching con datos de carga masiva)
      const normalizedNameToLevelMap: Record<string, 'basica' | 'media'> = {};
      // Mapa de gradeKey -> courseId (para matching flexible por grado+nivel)
      const gradeKeyToCourseIdMap: Record<string, string> = {};
      
      // Función para normalizar nombre estilo toId (como lo hace la carga masiva)
      const toIdStyle = (s: string): string => {
        if (!s) return '';
        return String(s).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, '');
      };
      
      // Función para inferir nivel del nombre del curso
      const inferLevelFromCourseName = (name: string): 'basica' | 'media' | undefined => {
        const n = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (/medio|media/i.test(n)) return 'media';
        if (/basico|basica/i.test(n)) return 'basica';
        // 1ro-8vo sin "medio" => básica
        if (/^[1-8](ro|do|to|ero|vo|mo)/i.test(n) && !/medio|media/i.test(n)) return 'basica';
        // 1ro-4to medio => media
        if (/[1-4](ro|do|to|ero)\s*(medio|media)/i.test(n)) return 'media';
        return undefined;
      };
      
      // Mapa inverso: courseId -> nombre normalizado del curso
      const courseIdToNameMap: Record<string, string> = {};
      
      allCourses.forEach((c: any) => {
        const cId = String(c?.id || '');
        const courseName = c?.name || c?.fullName || c?.displayName || '';
        const cName = normalizeCourseName(courseName);
        if (cId && cName) {
          courseNameToIdMap[cName] = cId;
          courseIdToNameMap[cId] = cName;
        }
        
        // Construir mapa de courseId -> level
        if (cId) {
          const explicitLevel = c?.level as 'basica' | 'media' | undefined;
          const inferredLevel = inferLevelFromCourseName(c?.name || c?.fullName || c?.displayName || c?.gradeName || '');
          const finalLevel = explicitLevel || inferredLevel;
          if (finalLevel) {
            courseIdToLevelMap[cId] = finalLevel;
            
            // 🔧 NUEVO: También mapear el nombre normalizado estilo toId al nivel
            // Esto permite matching con datos de carga masiva que usan toId(curso)
            const nameToIdStyle = toIdStyle(courseName);
            if (nameToIdStyle) {
              normalizedNameToLevelMap[nameToIdStyle] = finalLevel;
            }
          }
          
          // Construir mapa de gradeKey -> courseId
          const gradeKey = extractGradeKey(courseName);
          if (gradeKey && !gradeKeyToCourseIdMap[gradeKey]) {
            gradeKeyToCourseIdMap[gradeKey] = cId;
          }
        }
      });
      
      // Nombre normalizado y gradeKey del curso filtrado (para comparar con campos de nombre en registros)
      const filterCourseNormalizedName = filterCourseId ? courseIdToNameMap[filterCourseId] : undefined;
      // Obtener nombre original del curso filtrado para extraer gradeKey
      const filterCourseOriginalName = filterCourseId ? allCourses.find((c: any) => String(c?.id || '') === filterCourseId)?.name || filterCourseNormalizedName : undefined;
      const filterCourseGradeKey = filterCourseOriginalName ? extractGradeKey(filterCourseOriginalName) : undefined;
      
      // 🔧 NUEVO: Obtener el courseId en formato toId (como se guarda en carga masiva)
      // Ej: "2do Básico" → "2do_basico"
      const filterCourseToIdStyle = filterCourseOriginalName ? toIdStyle(filterCourseOriginalName) : undefined;
      
      if (filterCourseId) {
        console.log('[AdminKPIs] 🎯 Filtro de curso:', { 
          filterCourseId, 
          filterCourseOriginalName, 
          filterCourseNormalizedName, 
          filterCourseGradeKey,
          filterCourseToIdStyle // Este es el formato que usa la carga masiva
        });
      }
      
      // Crear set de sectionIds válidas para el curso filtrado (útil cuando se filtra por curso)
      // IMPORTANTE: También incluir secciones de cursos con el mismo gradeKey
      let validSectionIdsForCourse: Set<string> | undefined;
      let validCourseIdsForGradeKey: Set<string> | undefined; // Todos los courseIds que coinciden con el gradeKey
      
      if (filterCourseId || filterCourseGradeKey) {
        validSectionIdsForCourse = new Set();
        validCourseIdsForGradeKey = new Set();
        
        // Primero, encontrar todos los courseIds que coinciden con el gradeKey del filtro
        if (filterCourseGradeKey) {
          allCourses.forEach((c: any) => {
            const cId = String(c?.id || '');
            const cName = c?.name || c?.fullName || c?.displayName || '';
            const cGradeKey = extractGradeKey(cName);
            if (cGradeKey === filterCourseGradeKey && cId) {
              validCourseIdsForGradeKey!.add(cId);
              // 🔧 NUEVO: También agregar el nombre en formato toId para matching con carga masiva
              const cToIdStyle = toIdStyle(cName);
              if (cToIdStyle) validCourseIdsForGradeKey!.add(cToIdStyle);
            }
          });
        }
        if (filterCourseId) {
          validCourseIdsForGradeKey!.add(filterCourseId);
        }
        // 🔧 NUEVO: Agregar el nombre del curso en formato toId (carga masiva)
        if (filterCourseToIdStyle) {
          validCourseIdsForGradeKey!.add(filterCourseToIdStyle);
        }
        
        // Ahora agregar todas las secciones de esos cursos
        allSections.forEach((sec: any) => {
          const secId = String(sec?.id || sec?.sectionId || '');
          const secCourseId = String(sec?.courseId || (sec?.course && (sec.course.id || sec.course.courseId)) || '');
          
          // Incluir sección si:
          // 1. Pertenece directamente al curso filtrado, O
          // 2. Pertenece a un curso con el mismo gradeKey
          if (secId && (secCourseId === filterCourseId || validCourseIdsForGradeKey!.has(secCourseId))) {
            validSectionIdsForCourse!.add(secId);
          }
        });
        
      }
      
      // Si hay filtro de período, obtener rango de fechas del período
      let periodFromTs: number | undefined;
      let periodToTs: number | undefined;
      
      if (filters?.period) {
        if (filters.period !== 'all') {
          const periodWindow = getTimeWindow(filters.period);
          if (periodWindow.from) {
            periodFromTs = periodWindow.from;
            periodToTs = Date.now(); // hasta ahora
          }
        }
        // Si period === 'all', no aplicamos filtro de tiempo adicional (ya cubierto por semestre/año)
      }
      
      // IMPORTANTE: Construir mapas de equivalencia entre IDs de asistencia e IDs del sistema
      // Estos mapas permiten encontrar coincidencias cuando los UUIDs son diferentes
      const attCourseIdToGradeKeyMap: Record<string, string> = {}; // courseId de asistencia -> gradeKey
      const attSectionIdToGradeKeyMap: Record<string, string> = {}; // sectionId de asistencia -> gradeKey del curso padre
      
      // Analizar los registros de asistencia para extraer información
      if (Array.isArray(attendance) && attendance.length > 0) {
        // Agrupar sectionIds por courseId en los datos de asistencia
        const attSectionsByCourse: Record<string, Set<string>> = {};
        const attCourseNames: Record<string, Set<string>> = {}; // Collect names

        attendance.forEach((rec: any) => {
          const cId = String(rec?.courseId || '');
          const sId = String(rec?.sectionId || '');
          const cName = String(rec?.course || rec?.curso || rec?.Curso || rec?.courseName || '');
          
          if (cId) {
            if (!attSectionsByCourse[cId]) attSectionsByCourse[cId] = new Set();
            if (sId) attSectionsByCourse[cId].add(sId);
            
            if (cName) {
               if (!attCourseNames[cId]) attCourseNames[cId] = new Set();
               attCourseNames[cId].add(cName);
            }
          }
        });
        
        // Para cada courseId de asistencia, intentar encontrar el gradeKey correspondiente
        Object.keys(attSectionsByCourse).forEach(attCourseId => {
          const attSectionCount = attSectionsByCourse[attCourseId].size;
          let matchedGradeKey: string | undefined;

          // 1. Intentar coincidencia por nombre (más preciso)
          const names = attCourseNames[attCourseId];
          if (names && names.size > 0) {
             for (const name of Array.from(names)) {
                const gk = extractGradeKey(name);
                if (gk) {
                   matchedGradeKey = gk;
                   break;
                }
             }
          }

          // 2. Si no hay coincidencia por nombre, intentar por conteo de secciones (fallback)
          if (!matchedGradeKey) {
            // Buscar en cursos del sistema un curso con características similares
            for (const sysCourse of allCourses) {
              const sysCourseId = String(sysCourse?.id || '');
              const sysCourseName = sysCourse?.name || sysCourse?.fullName || sysCourse?.displayName || '';
              const sysGradeKey = extractGradeKey(sysCourseName);
              
              if (!sysGradeKey) continue;
              
              // Contar secciones del curso del sistema
              const sysSectionCount = allSections.filter((s: any) => 
                String(s?.courseId || (s?.course && (s.course.id || s.course.courseId)) || '') === sysCourseId
              ).length;
              
              // Si tienen el mismo número de secciones, asumir correspondencia
              if (sysSectionCount === attSectionCount && sysSectionCount > 0) {
                matchedGradeKey = sysGradeKey;
                break; // Encontrado, pasar al siguiente
              }
            }
          }

          if (matchedGradeKey) {
              attCourseIdToGradeKeyMap[attCourseId] = matchedGradeKey;
              // También mapear las secciones (solo si son IDs únicos, pero aquí mapeamos por ID de asistencia)
              attSectionsByCourse[attCourseId].forEach(attSecId => {
                // Solo mapear si parece un ID único (largo > 5) para evitar colisiones con "A", "B"
                if (attSecId.length > 5) {
                   attSectionIdToGradeKeyMap[attSecId] = matchedGradeKey!;
                }
              });
          }
        });
        
      }
      
      // Asegurar que attendance sea un array
      
      // Log de muestra de IDs en registros de asistencia
      if (Array.isArray(attendance) && attendance.length > 0) {
        const sampleCourseIds = attendance.slice(0, 50).map(r => r?.courseId).filter(Boolean);
        const sampleSectionIds = attendance.slice(0, 50).map(r => r?.sectionId).filter(Boolean);
        const uniqueAttCourseIds = [...new Set(sampleCourseIds)].slice(0, 10);
        const uniqueAttSectionIds = [...new Set(sampleSectionIds)].slice(0, 10);
        
        // DIAGNÓSTICO CRÍTICO: Ver TODAS las secciones únicas en asistencia (campo section, no sectionId)
        const allUniqueSectionNames = [...new Set(attendance.map(r => r?.section || r?.seccion || r?.Seccion || '').filter(Boolean))];
        const allUniqueCourseNames = [...new Set(attendance.map(r => r?.course || r?.curso || r?.Curso || '').filter(Boolean))];
        
        // Contar registros por sección
        const sectionCounts: Record<string, number> = {};
        attendance.forEach(r => {
          const sec = r?.section || r?.seccion || r?.Seccion || 'sin-seccion';
          sectionCounts[sec] = (sectionCounts[sec] || 0) + 1;
        });
        
        // 🔥 DEBUG CRÍTICO: Conteo por sección + curso para entender la distribución
        const sectionCourseCounts: Record<string, Record<string, number>> = {};
        attendance.forEach(r => {
          const sec = String(r?.section || r?.seccion || r?.Seccion || 'sin-seccion').toUpperCase();
          const course = r?.course || r?.curso || r?.Curso || 'sin-curso';
          if (!sectionCourseCounts[sec]) sectionCourseCounts[sec] = {};
          sectionCourseCounts[sec][course] = (sectionCourseCounts[sec][course] || 0) + 1;
        });
        
        // IDs de cursos disponibles en el sistema
        const availableCourseIds = allCourses.map((c: any) => String(c?.id || '')).filter(Boolean).slice(0, 10);
        const availableSectionIds = allSections.map((s: any) => String(s?.id || s?.sectionId || '')).filter(Boolean).slice(0, 10);
        
        
        // Verificar si hay coincidencias
        const courseIdMatches = uniqueAttCourseIds.filter(id => availableCourseIds.includes(id));
        const sectionIdMatches = uniqueAttSectionIds.filter(id => availableSectionIds.includes(id));
        
        if (filterSectionId) {
          // Info del filtro de sección
          const filterSecName = sectionIdToNameMap[filterSectionId] || '';
          const filterSecLetter = sectionIdToSectionNameMap[filterSectionId] || '';
          const filterSecGradeKey = sectionIdToGradeKeyMap[filterSectionId] || filterCourseGradeKey || '';
          
          // Mostrar mapas para diagnóstico
        }
        if (filterCourseId) {
        }
      }
      
      // Log de TODAS las keys presentes en los registros para entender estructura
      if (Array.isArray(attendance) && attendance.length > 0) {
        const sampleRec = attendance[0];
        // Mostrar validSectionIdsForCourse si existe
        if (validSectionIdsForCourse) {
        }
        // Mostrar sectionToCourseMap de ejemplo
        const sectionMapEntries = Object.entries(sectionToCourseMap).slice(0, 5);
      }
      
      // Variables para tracking de registros procesados (definidas fuera del bloque para uso en logs)
      let skippedNoYear = 0;
      let skippedNoSemester = 0;
      let skippedNoLevel = 0;
      let skippedNoPeriod = 0;
      let processedCount = 0;
      
      if (Array.isArray(attendance)) {
        // 🔥 DEBUG: Log inicial de datos de asistencia
        if (typeof window !== 'undefined') {
          const hasFiltersActive = filterLevel || filterCourseId || filterSectionId || filterSemester || (filters?.period && filters.period !== 'all');
          if (hasFiltersActive && attendance.length > 0) {
            const sample = attendance.slice(0, 5);
            console.log('[AdminKPIs][Filtros] 🔍 INICIO FILTRADO - Datos de asistencia disponibles:', {
              total: attendance.length,
              filtrosActivos: { level: filterLevel, courseId: filterCourseId, sectionId: filterSectionId, semester: filterSemester },
              muestra: sample.map(r => ({
                date: r.date,
                status: r.status,
                present: r.present,
                courseId: r.courseId,
                course: r.course || r.curso,
                sectionId: r.sectionId,
                section: r.section || r.seccion,
                studentId: r.studentId?.substring?.(0, 10) || r.studentId
              }))
            });
            
            // Analizar qué cursos únicos hay en los datos de asistencia
            const uniqueCourses = new Set<string>();
            const uniqueSections = new Set<string>();
            attendance.forEach(r => {
              const cId = r.courseId || r.course || r.curso;
              const sId = r.sectionId || r.section || r.seccion;
              if (cId) uniqueCourses.add(String(cId));
              if (sId) uniqueSections.add(String(sId));
            });
            console.log('[AdminKPIs][Filtros] 📊 Cursos únicos en asistencia:', Array.from(uniqueCourses).slice(0, 10));
            console.log('[AdminKPIs][Filtros] 📊 Secciones únicas en asistencia:', Array.from(uniqueSections).slice(0, 10));
            
            // Si hay filtro de curso, mostrar qué esperamos encontrar
            if (filterCourseId) {
              const courseNameFilter = courseIdToNameMap[filterCourseId] || 'no encontrado';
              const gradeKeyFilter = filterCourseGradeKey || 'no hay gradeKey';
              console.log('[AdminKPIs][Filtros] 🎯 Buscando curso:', { filterCourseId, courseNameFilter, gradeKeyFilter });
              console.log('[AdminKPIs][Filtros] 🎯 validSectionIdsForCourse:', validSectionIdsForCourse ? Array.from(validSectionIdsForCourse) : 'undefined');
              console.log('[AdminKPIs][Filtros] 🎯 validCourseIdsForGradeKey:', validCourseIdsForGradeKey ? Array.from(validCourseIdsForGradeKey) : 'undefined');
            }
          } else if (hasFiltersActive && attendance.length === 0) {
            console.warn('[AdminKPIs][Filtros] NO hay datos de asistencia disponibles');
          }
        }
        
        // 🔥 DEBUG: Contadores por sección para diagnóstico
        let passedCourseFilterBySection: Record<string, number> = {};
        let passedSectionFilterBySection: Record<string, number> = {};
        let rejectedSectionFilterBySection: Record<string, number> = {};
        
        attendance.forEach(rec => {
          // Detectar año de la fecha ISO string directamente
          const dateStr = rec?.date;
          let recYear;
          let recTimestamp;
          
          if (typeof dateStr === 'string') {
            if (dateStr.includes('2024')) recYear = 2024;
            else if (dateStr.includes('2025')) recYear = 2025;
            else if (dateStr.includes('2023')) recYear = 2023;
            else { skippedNoYear++; return; } // skip si no detecta año común
            
            // Para filtro de semestre, también necesitamos el timestamp
            if (filterSemester) {
              recTimestamp = new Date(dateStr).getTime();
              if (semesterFromTs && semesterToTs) {
                if (recTimestamp < semesterFromTs || recTimestamp > semesterToTs) { skippedNoSemester++; return; } // fuera del rango del semestre
              }
            }
            
            // Para filtro de período, también necesitamos el timestamp
            if (filters?.period && filters.period !== 'all') {
              if (!recTimestamp) recTimestamp = new Date(dateStr).getTime();
              if (periodFromTs && periodToTs) {
                if (recTimestamp < periodFromTs || recTimestamp > periodToTs) { skippedNoPeriod++; return; } // fuera del rango del período
              }
            }
          } else {
            skippedNoYear++; return; // skip si no hay fecha string
          }
          
          if (filterYear && recYear !== filterYear) { skippedNoYear++; return; } // filtrar por año específico
          
          // Usar extendedParse para obtener IDs normalizados del registro
          const { courseId: parsedCourseId, sectionId: parsedSectionId } = extendedParse(rec);
          
          // Filtrar por sección específica si está especificado (tiene prioridad máxima)
          if (filterSectionId) {
            let recSectionId = parsedSectionId || String(rec?.sectionId || '');
            // Intentar resolver sectionId desde otros campos si no está presente
            if (!recSectionId && rec?.section) {
              // rec.section puede ser el nombre de la sección (ej: "A", "B") o el ID
              const secVal = String(rec.section).toLowerCase().trim();
              // Intentar resolver como ID primero
              if (sectionToCourseMap[secVal]) {
                recSectionId = secVal;
              } else {
                // Intentar resolver por nombre
                recSectionId = sectionNameToIdMap[secVal] || secVal;
              }
            }
            // También intentar desde campo 'seccion'
            if (!recSectionId && (rec?.seccion || rec?.Seccion)) {
              const secVal = String(rec.seccion || rec.Seccion).toLowerCase().trim();
              recSectionId = sectionNameToIdMap[secVal] || secVal;
            }
            
            // Obtener información del curso del registro para verificación
            let recCourseId = parsedCourseId || String(rec?.courseId || '');
            const recCourseName = rec?.curso || rec?.Curso || rec?.course || rec?.courseName || '';
            const recCourseGradeKeyDirect = recCourseName ? extractGradeKey(recCourseName) : undefined;
            
            // 🔥 ESTRATEGIA MEJORADA: Cuando hay filterSectionId, priorizamos la LETRA de sección
            // porque el usuario ya seleccionó una sección específica del catálogo del sistema.
            // Los datos de Firebase pueden tener courseId/course inconsistentes, pero la letra (A, B, etc.) es confiable.
            
            // 🔧 SIMPLIFICADO: Usar filterSectionLetter ya calculado arriba
            const filterSectionLetterForCourseCheck = filterSectionLetter || '';
            
            // Obtener letra de sección del registro - desde múltiples campos posibles
            let recSectionLetterRaw = String(rec?.section || rec?.seccion || rec?.Seccion || '').trim().toLowerCase();
            // Si el campo sectionId es una letra sola (carga masiva), usarlo
            if (!recSectionLetterRaw && recSectionId && recSectionId.length === 1 && /^[a-z]$/i.test(recSectionId)) {
              recSectionLetterRaw = recSectionId.toLowerCase();
            }
            const recSectionLetterForCheck = recSectionLetterRaw.length === 1 ? recSectionLetterRaw : 
              (recSectionLetterRaw.match(/[a-z]$/i)?.[0]?.toLowerCase() || recSectionLetterRaw);
            
            // 🔧 MEJORADO: También necesitamos verificar que el CURSO coincida, no solo la letra
            // porque puede haber sección "A" en múltiples cursos
            let recCourseIdNormalized = recCourseId ? toIdStyle(recCourseId) : '';
            const recCourseNameNormalized = recCourseName ? toIdStyle(recCourseName) : '';
            
            // Obtener el courseId del filtro de sección (del catálogo)
            const filterSectionCourseId = filterSectionId ? sectionToCourseMap[filterSectionId] : undefined;
            const filterSectionCourse = filterSectionCourseId 
              ? allCourses.find((c: any) => String(c?.id || '') === filterSectionCourseId)
              : undefined;
            const filterSectionCourseToIdStyle = filterSectionCourse 
              ? toIdStyle(filterSectionCourse?.name || filterSectionCourse?.fullName || '')
              : undefined;
            const filterSectionCourseGradeKey = filterSectionCourse
              ? extractGradeKey(filterSectionCourse?.name || filterSectionCourse?.fullName || '')
              : undefined;
            
            // Si tenemos letra de sección del filtro, verificar que coincida PRIMERO
            // Esto evita filtrar por curso cuando la letra ya no coincide
            if (filterSectionLetterForCourseCheck && recSectionLetterForCheck) {
              if (filterSectionLetterForCourseCheck !== recSectionLetterForCheck) {
                // La letra de sección no coincide - saltar este registro
                skippedNoLevel++;
                return;
              }
              
              // La letra coincide - ahora verificar también el curso
              // para evitar mezclar sección "A" de 1ro Básico con sección "A" de 2do Básico
              if (filterSectionCourseToIdStyle || filterSectionCourseGradeKey) {
                const matchesCourseByToId = filterSectionCourseToIdStyle && (
                  recCourseId === filterSectionCourseToIdStyle ||
                  recCourseIdNormalized === filterSectionCourseToIdStyle ||
                  recCourseNameNormalized === filterSectionCourseToIdStyle
                );
                const matchesCourseByGradeKey = filterSectionCourseGradeKey && (
                  recCourseGradeKeyDirect === filterSectionCourseGradeKey
                );
                const matchesCourseById = filterSectionCourseId && recCourseId === filterSectionCourseId;
                
                if (!matchesCourseByToId && !matchesCourseByGradeKey && !matchesCourseById) {
                  // La letra coincide pero el curso no - podría ser otra sección "A" de otro curso
                  skippedNoLevel++;
                  return;
                }
              }
              
              // Si la letra Y el curso coinciden, este registro es válido
              const recSectionForDebugEarly = String(rec?.section || rec?.seccion || '').toUpperCase() || recSectionLetterForCheck.toUpperCase();
              passedCourseFilterBySection[recSectionForDebugEarly] = (passedCourseFilterBySection[recSectionForDebugEarly] || 0) + 1;
            } else if (filterCourseId) {
              // Fallback: si no tenemos letra, usar lógica tradicional de curso
              if (!recCourseId && recSectionId) {
                recCourseId = sectionToCourseMap[recSectionId] || '';
              }
              // Verificar pertenencia al curso: comparar courseId o gradeKey
              if (recCourseId) {
                const matchesCourseDirectly = recCourseId === filterCourseId;
                const matchesCourseBySet = validCourseIdsForGradeKey && validCourseIdsForGradeKey.has(recCourseId);
                const matchesCourseByGradeKey = filterCourseGradeKey && recCourseGradeKeyDirect && filterCourseGradeKey === recCourseGradeKeyDirect;
                
                if (!matchesCourseDirectly && !matchesCourseBySet && !matchesCourseByGradeKey) return;
              } else if (recCourseGradeKeyDirect && filterCourseGradeKey) {
                // No tenemos courseId pero tenemos gradeKey del nombre del curso
                if (recCourseGradeKeyDirect !== filterCourseGradeKey) return;
              }
            }
            
            // Ya pasó la verificación de letra de sección arriba, ahora solo verificar matching final
            // Registrar para debug si no se hizo arriba
            const recSectionForDebug = String(rec?.section || rec?.seccion || '').toUpperCase();
            if (!passedCourseFilterBySection[recSectionForDebug]) {
              passedCourseFilterBySection[recSectionForDebug] = 0;
            }
            // Si ya pasó el filtro de letra arriba, incrementar aquí
            if (filterSectionLetterForCourseCheck && recSectionLetterForCheck && 
                filterSectionLetterForCourseCheck === recSectionLetterForCheck) {
              // Ya contabilizado arriba, también registrar como pasó sección
              passedSectionFilterBySection[recSectionForDebug] = (passedSectionFilterBySection[recSectionForDebug] || 0) + 1;
              // Continuar al procesamiento - no hace falta más verificación de sección
            } else if (!filterSectionLetterForCourseCheck) {
              // Fallback: usar lógica tradicional de verificación de sección solo si no se usó letra arriba
            
              // Buscar nombre de sección primero en mapas, luego en catálogo de filtros (allSections)
              let filterSectionName = sectionIdToNameMap[filterSectionId] || '';
              if (!filterSectionName && allSections) {
                // Fallback: buscar en el catálogo de secciones del dropdown
                const filterSecFromCatalog = allSections.find((s: any) => 
                  String(s?.id || s?.sectionId) === String(filterSectionId)
                );
                filterSectionName = filterSecFromCatalog 
                  ? String(filterSecFromCatalog?.name || filterSecFromCatalog?.fullName || filterSecFromCatalog?.displayName || filterSecFromCatalog?.label || '').toLowerCase().trim()
                  : '';
              }
              // Extraer la letra de sección: buscar una sola letra al final o usar el nombre completo si es solo una letra
              let filterSectionLetter = sectionIdToSectionNameMap[filterSectionId] || '';
              if (!filterSectionLetter && filterSectionName) {
                const letterMatch = filterSectionName.match(/[a-z]$/i);
                filterSectionLetter = letterMatch ? letterMatch[0].toLowerCase() : filterSectionName.toLowerCase();
              }
              // Fallback adicional: buscar letra en catálogo de filtros
              if (!filterSectionLetter && allSections) {
                const filterSecFromCatalog = allSections.find((s: any) => 
                  String(s?.id || s?.sectionId) === String(filterSectionId)
                );
                if (filterSecFromCatalog) {
                  const secNameFromCatalog = String(filterSecFromCatalog?.name || filterSecFromCatalog?.shortName || filterSecFromCatalog?.label || '');
                  const letterMatch = secNameFromCatalog.match(/[a-z]$/i);
                  filterSectionLetter = letterMatch ? letterMatch[0].toLowerCase() : secNameFromCatalog.toLowerCase();
                }
              }
              // Usar gradeKey del filtro de curso si no tenemos uno específico para la sección
              const filterSectionGradeKey = sectionIdToGradeKeyMap[filterSectionId] || filterCourseGradeKey || '';
              
              // Obtener nombre/letra de sección del registro desde múltiples fuentes
              const recSectionNameRaw = rec?.seccion || rec?.Seccion || rec?.['Sección'] || rec?.section || rec?.sectionName || '';
              // Para la letra: si es solo una letra, usarla directamente; si no, buscar la última letra
              let recSectionLetter = '';
              const recSectionStr = String(recSectionNameRaw).trim().toLowerCase();
              if (recSectionStr.length === 1 && /[a-z]/i.test(recSectionStr)) {
                recSectionLetter = recSectionStr;
              } else {
                const letterMatch = recSectionStr.match(/[a-z]$/i);
                recSectionLetter = letterMatch ? letterMatch[0].toLowerCase() : recSectionStr;
              }
              
              // Obtener gradeKey del registro - desde sección, curso, o nombre del curso
              const recSectionGradeKey = recSectionId ? (
                sectionIdToGradeKeyMap[recSectionId] || 
                attSectionIdToGradeKeyMap[recSectionId] || 
                undefined
              ) : undefined;
              const recCourseGradeKey = parsedCourseId ? (
                attCourseIdToGradeKeyMap[parsedCourseId] || 
                recCourseGradeKeyDirect ||
                undefined
              ) : recCourseGradeKeyDirect;
              
              // Condiciones de coincidencia
              const matchesSectionId = recSectionId === filterSectionId;
              const matchesSectionName = filterSectionName && recSectionNameRaw && 
                                         String(recSectionNameRaw).toLowerCase().trim() === filterSectionName.toLowerCase();
              // Matching por gradeKey + letra de sección
              const effectiveRecGradeKey = recSectionGradeKey || recCourseGradeKey;
              const matchesByGradeKeyAndLetter = filterSectionGradeKey && filterSectionLetter && 
                                                  effectiveRecGradeKey && recSectionLetter &&
                                                  filterSectionGradeKey === effectiveRecGradeKey && 
                                                  filterSectionLetter === recSectionLetter;
              
              // Log de diagnóstico para las primeras 5 coincidencias encontradas
              if ((matchesSectionId || matchesSectionName || matchesByGradeKeyAndLetter) && processedCount < 3) {
              }
              
              // 🔥 DEBUG: Contador de registros que pasan el filtro de sección
              if (matchesSectionId || matchesSectionName || matchesByGradeKeyAndLetter) {
                passedSectionFilterBySection[recSectionForDebug] = (passedSectionFilterBySection[recSectionForDebug] || 0) + 1;
              }
              
              // Si ninguna condición coincide, log y skip
              if (!matchesSectionId && !matchesSectionName && !matchesByGradeKeyAndLetter) {
                // 🔥 DEBUG: Contador de registros rechazados por sección
                rejectedSectionFilterBySection[recSectionForDebug] = (rejectedSectionFilterBySection[recSectionForDebug] || 0) + 1;
                
                if (skippedNoLevel < 5) {
                  skippedNoLevel++;
                }
                return; // skip si no es la sección especificada
              }
            } // Cierre del else if (!filterSectionLetterForCourseCheck) - fallback de verificación tradicional
          }
          // Filtrar por curso específico si está especificado y no hay filtro de sección
          else if (filterCourseId) {
            // Obtener courseId del registro, o inferirlo desde sectionId o nombre de curso si no está disponible
            let recCourseId = parsedCourseId || String(rec?.courseId || '');
            let recSectionId = parsedSectionId || String(rec?.sectionId || '');
            
            // Si tenemos sectionId, verificar si pertenece al curso filtrado
            if (recSectionId && validSectionIdsForCourse) {
              if (validSectionIdsForCourse.has(recSectionId)) {
                // OK, la sección pertenece al curso - procesado abajo
              } else {
                // Intentar resolver courseId desde sectionId
                recCourseId = sectionToCourseMap[recSectionId] || recCourseId;
              }
            }
            
            if (!recCourseId && recSectionId) {
              recCourseId = sectionToCourseMap[recSectionId] || '';
            }
            // Fallback: resolver desde nombre de curso (para CSVs sin IDs)
            const recCourseName = String(rec?.course || rec?.curso || rec?.Curso || '');
            const recCourseNameNormalized = recCourseName ? normalizeCourseName(recCourseName) : '';
            
            if (!recCourseId && recCourseNameNormalized) {
              recCourseId = courseNameToIdMap[recCourseNameNormalized] || '';
            }
            
            // Extraer gradeKey del registro para matching flexible
            const recGradeKey = recCourseName ? extractGradeKey(recCourseName) : undefined;
            // También intentar obtener gradeKey desde el mapa de asistencia
            const recGradeKeyFromAttMap = recCourseId ? attCourseIdToGradeKeyMap[recCourseId] : undefined;
            const effectiveRecGradeKey = recGradeKey || recGradeKeyFromAttMap;
            
            // 🔧 NUEVO: Convertir el courseId del registro a formato toId para matching
            const recCourseIdToIdStyle = recCourseId ? toIdStyle(recCourseId) : '';
            const recCourseNameToIdStyle = recCourseName ? toIdStyle(recCourseName) : '';
            
            // Verificar: el registro pertenece al curso si:
            // 1. Su courseId coincide exactamente con el filtro, O
            // 2. Su courseId está en el set de cursos válidos (mismo gradeKey + toIdStyle), O
            // 3. Su sectionId está en las secciones válidas del curso, O
            // 4. Su nombre de curso normalizado coincide con el nombre del curso filtrado, O
            // 5. Su gradeKey coincide con el gradeKey del curso filtrado (ej: "1basico" == "1basico"), O
            // 6. Su courseId en formato toId coincide con el filtro en formato toId (carga masiva)
            const matchesCourse = recCourseId === filterCourseId;
            const matchesCourseByGradeKeySet = recCourseId && validCourseIdsForGradeKey && validCourseIdsForGradeKey.has(recCourseId);
            const matchesSection = recSectionId && validSectionIdsForCourse && validSectionIdsForCourse.has(recSectionId);
            const matchesByName = filterCourseNormalizedName && recCourseNameNormalized && 
                                  (recCourseNameNormalized === filterCourseNormalizedName ||
                                   recCourseNameNormalized.includes(filterCourseNormalizedName) ||
                                   filterCourseNormalizedName.includes(recCourseNameNormalized));
            const matchesByGradeKey = filterCourseGradeKey && effectiveRecGradeKey && effectiveRecGradeKey === filterCourseGradeKey;
            // 🔧 NUEVO: Matching por toIdStyle (formato de carga masiva)
            const matchesByToIdStyle = filterCourseToIdStyle && (
              recCourseId === filterCourseToIdStyle ||
              recCourseIdToIdStyle === filterCourseToIdStyle ||
              recCourseNameToIdStyle === filterCourseToIdStyle
            );
            
            if (!matchesCourse && !matchesCourseByGradeKeySet && !matchesSection && !matchesByName && !matchesByGradeKey && !matchesByToIdStyle) {
              // Log de diagnóstico para primeros registros descartados
              if (skippedNoLevel < 3) {
                console.log('[AdminKPIs][Filtros] ❌ Registro rechazado por curso:', {
                  recCourseId,
                  recCourseIdToIdStyle,
                  recCourseNameToIdStyle,
                  filterCourseToIdStyle,
                  matchesCourse,
                  matchesCourseByGradeKeySet,
                  matchesByToIdStyle
                });
              }
              skippedNoLevel++;
              return; // skip si no pertenece al curso
            } else if (processedCount < 3) {
              // Log de diagnóstico para primeros registros ACEPTADOS - ver por qué pasan
              console.log('[AdminKPIs][Filtros] ✅ Registro ACEPTADO por curso:', {
                recCourseId,
                recCourseName,
                filterCourseToIdStyle,
                matchesCourse,
                matchesCourseByGradeKeySet,
                matchesSection,
                matchesByName,
                matchesByGradeKey,
                matchesByToIdStyle,
                filterCourseGradeKey,
                effectiveRecGradeKey
              });
            }
          }
          // Filtrar por nivel si está especificado y no hay filtros de curso/sección
          else if (filterLevel) {
            // Obtener courseId del registro, o inferirlo desde sectionId o nombre de curso si no está disponible
            let recCourseId = parsedCourseId || String(rec?.courseId || '');
            if (!recCourseId && rec?.sectionId) {
              recCourseId = sectionToCourseMap[String(rec.sectionId)] || '';
            }
            // Fallback: resolver desde nombre de curso (para CSVs sin IDs)
            let recCourseName = String(rec?.course || rec?.curso || rec?.Curso || '');
            if (!recCourseId && recCourseName) {
              const normalizedName = normalizeCourseName(recCourseName);
              recCourseId = courseNameToIdMap[normalizedName] || '';
            }
            
            // 🔧 NUEVO: Si tenemos courseId pero no courseName, buscar el nombre en el catálogo
            if (recCourseId && !recCourseName) {
              const courseFromCatalog = allCourses.find((c: any) => String(c?.id || '') === recCourseId);
              if (courseFromCatalog) {
                recCourseName = courseFromCatalog?.name || courseFromCatalog?.fullName || courseFromCatalog?.displayName || '';
              }
            }
            
            // Determinar el nivel del curso del registro
            let recLevel: 'basica' | 'media' | undefined;
            
            // 1. Buscar en el mapa courseId -> level (incluye campo explícito e inferido)
            if (recCourseId && courseIdToLevelMap[recCourseId]) {
              recLevel = courseIdToLevelMap[recCourseId];
            }
            // 2. Si no encontramos, intentar inferir del nombre del curso en el registro
            if (!recLevel && recCourseName) {
              const name = recCourseName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              if (/medio|media/i.test(name)) recLevel = 'media';
              else if (/basico|basica/i.test(name)) recLevel = 'basica';
              else if (/^[1-8](ro|do|to|ero|vo|mo)/i.test(name) && !/medio|media/i.test(name)) recLevel = 'basica';
            }
            // 3. Si aún no encontramos, usar gradeKey para inferir nivel
            if (!recLevel && recCourseName) {
              const recGradeKey = extractGradeKey(recCourseName);
              if (recGradeKey) {
                if (recGradeKey.includes('medio') || recGradeKey.includes('media')) recLevel = 'media';
                else if (recGradeKey.includes('basico') || recGradeKey.includes('basica')) recLevel = 'basica';
              }
            }
            // 4. 🔧 NUEVO: Intentar inferir nivel desde el courseId (puede contener nombre normalizado)
            if (!recLevel && recCourseId) {
              // Primero buscar en el mapa de nombres normalizados estilo toId
              if (normalizedNameToLevelMap[recCourseId]) {
                recLevel = normalizedNameToLevelMap[recCourseId];
              } else {
                // Fallback: inferir del texto del courseId
                const idLower = recCourseId.toLowerCase();
                if (/medio|media/.test(idLower)) recLevel = 'media';
                else if (/basico|basica/.test(idLower)) recLevel = 'basica';
                // Detectar patrón de grado numérico en el ID
                else {
                  const gradeMatch = idLower.match(/(\d+)/);
                  if (gradeMatch) {
                    const gradeNum = parseInt(gradeMatch[1], 10);
                    // 1-8 sin "medio" en el ID probablemente es básica
                    if (gradeNum >= 1 && gradeNum <= 8 && !/medio|media/.test(idLower)) {
                      recLevel = 'basica';
                    }
                    // 1-4 con "medio" en el ID es media
                    else if (gradeNum >= 1 && gradeNum <= 4 && /medio|media/.test(idLower)) {
                      recLevel = 'media';
                    }
                  }
                }
              }
            }
            
            // Verificar si coincide con el filtro
            if (recLevel && recLevel !== filterLevel) {
              skippedNoLevel++; return; // nivel no coincide
            } else if (!recLevel && !recCourseId) {
              // No pudimos determinar ni el courseId ni el nivel
              // Si hay cursos definidos para el nivel, skip; si no, incluir
              if (levelCourseIds && levelCourseIds.size > 0) {
                skippedNoLevel++; return;
              }
            } else if (!recLevel && recCourseId && levelCourseIds && !levelCourseIds.has(recCourseId)) {
              // Tenemos courseId pero no está en los cursos del nivel y no pudimos inferir nivel
              skippedNoLevel++; return;
            }
            // Si recLevel === filterLevel o no tenemos restricciones, incluir
          }
          
          processedCount++;
          // Contar registros individuales con status
          // NOTA: 'present' y 'late' cuentan como presentes (igual que en pestaña Calificaciones)
          const status = String(rec.status || rec.estado || rec.Estado || '').toLowerCase();
          if (status === 'present' || status === 'late' || status === 'presente' || status === 'tardío' || status === 'tardio') {
            presentRecords++;
            totalRecords++;
          } else if (status === 'absent' || status === 'excused' || status === 'ausente' || status === 'justificado') {
            totalRecords++;
          } else if (rec.present === true || rec.present === 'true') {
            // Fallback: campo 'present' boolean
            presentRecords++;
            totalRecords++;
          } else if (rec.present === false || rec.present === 'false') {
            // Fallback: campo 'present' boolean para ausente
            totalRecords++;
          } else {
            // Log para registros sin status válido (solo primeros 3)
            if (processedCount <= 3) {
              console.warn('[AdminKPIs] Registro sin status/present válido:', { 
                status, 
                present: rec.present, 
                date: rec.date, 
                keys: Object.keys(rec).slice(0, 10) 
              });
            }
          }
        });
        
        
        // 🔥 DEBUG: Log de contadores por sección
        if (filterSectionId) {
        }
      }
      
      const recordsPct = totalRecords > 0 ? (presentRecords / totalRecords) * 100 : 0;
      attendancePct = recordsPct;
      
      // 🔥 DEBUG: Log cuando hay filtros activos para verificar que el cálculo está funcionando
      if (typeof window !== 'undefined') {
        const hasFiltersActive = filterLevel || filterCourseId || filterSectionId || filterSemester || (filters?.period && filters.period !== 'all');
        if (hasFiltersActive) {
          console.log('[AdminKPIs][Filtros] Cálculo de asistencia con filtros:', {
            filtros: { level: filterLevel, courseId: filterCourseId, sectionId: filterSectionId, semester: filterSemester, period: filters?.period },
            totalRegistrosOrigen: attendance?.length || 0,
            processedCount,
            presentRecords,
            totalRecords,
            skippedNoYear,
            skippedNoSemester,
            skippedNoLevel,
            skippedNoPeriod,
            attendancePct: recordsPct.toFixed(2) + '%',
            levelCourseIdsCount: levelCourseIds?.size || 0,
            allCoursesCount: allCourses?.length || 0
          });
          
          // Si no hay registros procesados, mostrar info adicional de diagnóstico
          if (processedCount === 0 && attendance?.length > 0) {
            const sample = attendance.slice(0, 3);
            console.warn('[AdminKPIs][Filtros] PROBLEMA: 0 registros procesados. Muestra de datos:', 
              sample.map(r => ({
                date: r.date,
                courseId: r.courseId,
                sectionId: r.sectionId,
                status: r.status,
                present: r.present
              }))
            );
            if (filterLevel && levelCourseIds) {
              console.warn('[AdminKPIs][Filtros] Cursos del nivel', filterLevel + ':', Array.from(levelCourseIds).slice(0, 5));
            }
          }
        }
      }
    }
    if (typeof window !== 'undefined' && !((window as any).__attDbg)) {
      (window as any).__attDbg = true;
      try {
  console.debug('[Asistencia][Diagnóstico] daysElapsed(hábiles transcurridos):', daysElapsed, 'daysPresent:', daysPresent, 'studentsCount:', studentsCount, 'sumPresentAcrossDays:', sumPresentAcrossDays, 'expectedTotalPresence:', expectedTotalPresence, 'attendancePct:', attendancePct.toFixed(2), 'filtros:', filters);
      } catch {}
    }
  if (expectedTotalPresence === 0 && typeof window !== 'undefined') {
      try {
        const sample = attendance.slice(0,5).map(r=>({
          date:r.date,
          status:r.status||r.estado||r.Estado,
          presentCount:r.presentCount,
          totalCount:r.totalCount,
          hasStudents:Array.isArray(r.students),
          courseId:r.courseId||r.course,
          sectionId:r.sectionId||r.section
        }));
        console.warn('[Asistencia][AdminKPIs] attendancePct=0 sin base esperada', { filtros: filters, registros: attendance.length, muestra: sample });
      } catch {}
    }

    // Secciones (conteo filtrado)
    let sectionsCount = 0;
    if (filters?.sectionId) {
      // Validar que la sección corresponda a los otros filtros
      const sec = allSections.find((s:any)=> String(s?.id || s?.sectionId) === String(filters.sectionId));
      if (sec) {
        const parentCourseId = String(sec?.courseId || (sec?.course && (sec.course.id || sec.course.courseId)) || '');
        if (filters?.courseId && parentCourseId !== String(filters.courseId)) {
          sectionsCount = 0;
        } else if (filters?.level) {
          const cMeta = allCourses.find((c:any)=> String(c?.id) === parentCourseId);
          if (!cMeta || (cMeta.level as Level|undefined) !== filters.level) sectionsCount = 0; else sectionsCount = 1;
        } else {
          sectionsCount = 1;
        }
      } else {
        sectionsCount = 0;
      }
    } else {
      const sectionIds = new Set<string>();
      allSections.forEach((s: any) => {
        const sid = String(s?.id || s?.sectionId || '');
        if (!sid) return;
        const cid = String(s?.courseId || (s?.course && (s.course.id || s.courseId)) || '');
        if (filters?.courseId && cid !== String(filters.courseId)) return;
        if (filters?.level) {
          const cMeta = allCourses.find((c:any)=> String(c?.id) === cid);
          if (!cMeta || (cMeta.level as Level|undefined) !== filters.level) return;
        }
        sectionIds.add(sid);
      });
      sectionsCount = sectionIds.size;
    }

    // Si SQL está conectado pero los datos de asistencia aún no llegaron,
    // solo el porcentaje de asistencia queda como undefined (cargando).
    // Los demás contadores se calculan desde localStorage y se muestran inmediatamente.
    // 🔧 MEJORADO: Si el nuevo valor es 0 pero hay un valor válido previo, usar el previo
    const finalAttendancePct = sqlAttendanceDataPending ? undefined : attendancePct;
    
    // 🔧 NUEVO: Flag para indicar si hay datos de asistencia cargados para los filtros actuales
    // Esto se usa para mostrar "Sin datos de asistencia cargados" cuando no hay datos
    const hasAttendanceDataForFilters = !sqlAttendanceDataPending && totalRecords > 0;

    return {
      studentsCount,
      coursesCount,
      sectionsCount,
      teachersCount,
  attendancePct: finalAttendancePct,
  attendanceAvgDaysPerStudent: sqlAttendanceDataPending ? 0 : avgDaysAttendedPerStudent,
  attendanceDaysPresent: sqlAttendanceDataPending ? 0 : daysPresent,
  attendanceDaysTotal: sqlAttendanceDataPending ? 0 : daysElapsed,
  attendanceDaysPeriodTotal: sqlAttendanceDataPending ? 0 : daysPeriodTotal,
      _tick: tick,
      // 🔧 NUEVO: Flag para indicar si los datos vienen de cache local
      _fromLocalCache: !isAttendanceSQLConnected || sqlTimeout || !sqlAttendanceByYear[yearToCheck]?.length,
      // 🔧 NUEVO: Flag para indicar si hay datos de asistencia para los filtros actuales
      _hasAttendanceData: hasAttendanceDataForFilters,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tick, 
    JSON.stringify(filters), 
    isAttendanceSQLConnected, 
    // 🔥 OPTIMIZADO: Solo verificar longitud de arrays en lugar de stringify completo
    sqlAttendanceByYear ? Object.keys(sqlAttendanceByYear).length : 0,
    isGradesSQLConnected, 
    sqlActivitiesByYear ? Object.keys(sqlActivitiesByYear).length : 0,
    filters?.level, 
    filters?.courseId, 
    filters?.sectionId, 
    filters?.semester, 
    filters?.year, 
    filters?.period,
    sqlTimeout, // 🔧 NUEVO: Recalcular cuando haya timeout
  ]);
}

function parseWhen(x: any): number | undefined {
  const tryParseDdMmYyyy = (s: string): number | undefined => {
    const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!m) return undefined;
    const dd = parseInt(m[1],10), mm = parseInt(m[2],10), yy = parseInt(m[3],10);
    if (!dd||!mm||!yy) return undefined;
    const d = new Date(yy, mm-1, dd);
    if (isNaN(d.getTime())) return undefined;
    return d.getTime();
  };
  const candidates = [
    x?.timestamp,
    x?.createdAt,
    x?.updatedAt,
    x?.date,
    x?.dateString,
    x?.day,
    x?.attendanceDate,
    x?.fecha,
    x?.Fecha,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'number' && !Number.isNaN(c)) return c;
    if (typeof c === 'string') {
      const s = c.trim();
      const ddmmyyyy = tryParseDdMmYyyy(s);
      if (ddmmyyyy) return ddmmyyyy;
      const t = Date.parse(s);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
}

function belongsToTeacher(x: any, username?: string): boolean {
  if (!username || !x) return false;
  const fields = [
    x.teacherUsername,
    x.teacher,
    x.createdBy,
    x.createdByUsername,
    x.ownerUsername,
    x.assignedBy,
  ];
  return fields.includes(username);
}

function useTeacherStats(username?: string, period: Period = '30d', filters?: StatsFilters, year?: number, preloadStatsParam?: { year: number; sectionAgg?: Array<{courseId:string|null;sectionId:string|null;present:number;total:number}> } | null) {
  // i18n helper within this hook scope
  const { translate } = useLanguage();
  const t = (key: string, fallback?: string) => {
    const v = translate(key);
    return v === key ? (fallback ?? key) : v;
  };
  const [refreshTick, setRefreshTick] = useState(0);
  const timeWindow = getTimeWindow(period);

  useEffect(() => {
    const onStorage = () => setRefreshTick(t => t + 1);
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }
    return;
  }, []);

  const read = (key: string): any[] => {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
  };

  const value = useMemo(() => {
    if (!username) {
      return {
        tasksCreated: 0,
        evaluationTasks: 0,
        submissions: 0,
        gradedSubmissions: 0,
        avgGrade: undefined as number | undefined,
        attendance: { present: 0, total: 0 },
      };
    }

    const inWindow = (x: any) => {
      const t = parseWhen(x);
      if (timeWindow.from && t) return t >= timeWindow.from;
      // Filtro por semestre: usar calendario configurado si existe
      if (filters?.semester && t) {
        const year = new Date(t).getFullYear();
        const rng = __getSemesterRange(year, filters.semester);
        if (rng.start && rng.end) {
          return t >= rng.start && t <= rng.end;
        }
        // Fallback por meses si no hay configuración
        const d = new Date(t);
        const m = d.getMonth() + 1; // 1..12
        if (filters.semester === 'S1') return m >= 3 && m <= 6;
        if (filters.semester === 'S2') return m >= 7 && m <= 12;
      }
      return true;
    };

    // Helpers para filtrar por curso/nivel
    const readRaw = (key: string): any[] => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
    const coursesAll = [...readRaw('smart-student-admin-courses'), ...readRaw('smart-student-courses')];
    const sectionsAll = [...readRaw('smart-student-admin-sections'), ...readRaw('smart-student-sections')];
    const levelByCourseId: Record<string, Level | undefined> = {};
    coursesAll.forEach((c: any) => { 
      if (c?.id) {
        let lvl = (c.level as Level) || undefined;
        // Heurística de corrección/inferencia basada en nombre/ID para corregir cursos sin nivel o mal clasificados
        const s = (c.name || c.id || '').toLowerCase();
        if (s.includes('media') || s.includes('medio') || s.includes('secundaria') || s.includes('high')) lvl = 'media';
        else if (s.includes('basica') || s.includes('basico') || s.includes('primaria') || s.includes('basic')) lvl = 'basica';
        levelByCourseId[c.id] = lvl;
      }
    });

    const extractCourseSectionId = (obj: any): string | undefined => {
      // intenta obtiene id compuesto desde varios campos comunes
      const cs = obj?.courseSectionId || obj?.course || obj?.courseIdSectionId;
      if (cs && typeof cs === 'string' && cs.includes('-')) return cs;
      const courseId = obj?.courseId || obj?.course?.id || obj?.course;
      const sectionId = obj?.sectionId || obj?.section?.id || obj?.section;
      if (courseId && sectionId) return `${courseId}-${sectionId}`;
      // A veces solo viene sectionId: derivar courseId
      if (!courseId && sectionId) {
        const s = sectionsAll.find((s: any) => s && (s.id === sectionId || s.sectionId === sectionId));
        const cId = s?.courseId || (s?.course && (s.course.id || s.courseId));
        if (cId) return `${cId}-${sectionId}`;
      }
      return undefined;
    };

    const extractCourseId = (obj: any): string | undefined => {
      const course = obj?.courseId || obj?.course?.id || obj?.course;
      if (typeof course === 'string') return course;
      return undefined;
    };
    const extractSectionId = (obj: any): string | undefined => {
      const section = obj?.sectionId || obj?.section?.id || obj?.section;
      if (typeof section === 'string') return section;
      return undefined;
    };

    const extractCourseLevel = (obj: any): Level | undefined => {
      const csId = extractCourseSectionId(obj);
      if (!csId) return undefined;
      const parts = csId.split('-');
      const cId = parts.length >= 2 ? parts.slice(0, parts.length - 1).join('-') : parts[0];
      return levelByCourseId[cId];
    };

    const matchFilters = (obj: any): boolean => {
      if (!filters) return true;
      const { courseSectionId, level, courseId, sectionId } = filters;
      if (courseSectionId) {
        const csId = extractCourseSectionId(obj);
        if (csId !== courseSectionId) return false;
      }
      if (courseId) {
        const cId = extractCourseId(obj) || extractCourseSectionId(obj)?.split('-').slice(0, -1).join('-');
        if (cId !== courseId) return false;
      }
      if (sectionId) {
        const sId = extractSectionId(obj) || extractCourseSectionId(obj)?.split('-').slice(-1)[0];
        if (sId !== sectionId) return false;
      }
      if (level) {
        const lvl = extractCourseLevel(obj);
        if (lvl !== level) return false;
      }
      return true;
    };

    // TAREAS
    const tasks: any[] = read('smart-student-tasks');
  const teacherTasks = tasks.filter(t => belongsToTeacher(t, username));
  const teacherTasksInWindow = teacherTasks.filter(inWindow).filter(matchFilters);
    const tasksCreated = teacherTasksInWindow.length;
    const evaluationTasks = teacherTasksInWindow.filter(t => (t.type === 'evaluation' || t.taskType === 'evaluation')).length;

    // ENTREGAS (SUBMISSIONS) - Cargar por año específico
    let submissions: any[] = [];
    const targetYear = year ?? new Date().getFullYear();
    try { 
      const { LocalStorageManager } = require('@/lib/education-utils'); 
      submissions = LocalStorageManager.getSubmissionsForYear(targetYear) || []; 
    } catch { 
      submissions = JSON.parse(localStorage.getItem(`smart-student-submissions-${targetYear}`) || '[]'); 
    }
    
    // Si no hay datos específicos del año, usar la carga global como fallback
    if (!Array.isArray(submissions) || submissions.length === 0) {
      submissions = read('smart-student-submissions');
    }
    // Preferimos enlazar por taskId si existe y el task es del profesor
    const taskIdsOfTeacher = new Set((teacherTasks as any[]).map(t => t.id || t.taskId));
  const teacherSubs = submissions.filter(s => {
      const byLink = s.taskId && taskIdsOfTeacher.has(s.taskId);
      const byOwner = belongsToTeacher(s, username);
      return byLink || byOwner;
  }).filter(inWindow).filter(matchFilters);
    const gradedSubs = teacherSubs.filter(s => typeof s.grade === 'number' || s.isGraded === true);
    const allGradedSubs = submissions
      .filter(inWindow)
      .filter(matchFilters)
      .filter(s => typeof s.grade === 'number' || s.isGraded === true);
    const rawVal = (s: any) => (typeof s.grade === 'number' ? s.grade : (s.score ?? 0));
    const norm100 = (s: any) => {
      const v = rawVal(s);
      return v <= 1 ? v * 100 : v; // normalizamos a 0-100 si vino en 0-1
    };
    const avgGrade = gradedSubs.length > 0
      ? (gradedSubs.reduce((acc, s) => acc + rawVal(s), 0) / gradedSubs.length)
      : undefined;
    const avgScore100 = gradedSubs.length > 0
      ? (gradedSubs.reduce((acc, s) => acc + norm100(s), 0) / gradedSubs.length)
      : undefined;
  const avgScore20 = typeof avgScore100 === 'number' ? avgScore100 / 5 : undefined;

    // ASISTENCIA - Omitir procesamiento si el gráfico está desactivado
    let present = 0;
    let total = 0;
    if (!filters?.skipAttendanceProcessing) {
      const attendance: any[] = read('smart-student-attendance');
      const teacherAtt = attendance.filter(a => a.teacherUsername === username).filter(inWindow).filter(matchFilters);
      present = teacherAtt.filter(a => a.status === 'present').length;
      total = teacherAtt.length;
    }

    // Tendencia por día
    const bucketSize = 1; // días
  const fromTs = timeWindow.from ?? (teacherSubs.reduce((min, s) => Math.min(min, parseWhen(s) ?? now()), now()));
    const toTs = now();
    const daysCount = Math.max(1, Math.ceil((toTs - fromTs) / days(bucketSize)));
    const series = new Array(daysCount).fill(0) as number[];
    teacherSubs.forEach(s => {
      const t = parseWhen(s);
      if (!t) return;
      const idx = Math.min(daysCount - 1, Math.floor((t - fromTs) / days(bucketSize)));
      if (idx >= 0) series[idx] += 1;
    });

    // Cursos/secciones top por entregas
    const courseCounts: Record<string, number> = {};
    teacherSubs.forEach(s => {
      const course = s.course || s.courseId || s.sectionId || '—';
      courseCounts[course] = (courseCounts[course] || 0) + 1;
    });
    const topCourses = Object.entries(courseCounts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Distribución de notas (asumiendo 0-100 si viene score, o número libre en grade)
    const bins = { low: 0, mid: 0, high: 0, top: 0 };
    let approvedCount = 0;
    let failedCount = 0;
    gradedSubs.forEach(s => {
      const score = norm100(s); // 0-100
      if (score <= 40) bins.low++; else if (score <= 60) bins.mid++; else if (score <= 80) bins.high++; else bins.top++;
      if (isApprovedByPercent(score)) approvedCount++; else failedCount++;
    });

    // Promedio destacado por estudiante (0-20)
    const byStudent: Record<string, { sum: number; n: number }> = {};
    gradedSubs.forEach(s => {
      const key = s.studentUsername || s.studentId || s.userId || '—';
      const sc = norm100(s);
      if (!byStudent[key]) byStudent[key] = { sum: 0, n: 0 };
      byStudent[key].sum += sc; byStudent[key].n += 1;
    });
    const topStudentAvg20 = Object.values(byStudent).length
      ? Math.max(...Object.values(byStudent).map(x => (x.sum / x.n) / 5))
      : undefined;

  // Dataset de comparación en % según filtros (nivel/curso/sección)

    type CompItem = { label: string; avgPct: number; attendancePct?: number };

  const ordinalBasica = (n: number) => ({ 1: '1ero', 2: '2do', 3: '3ro', 4: '4to', 5: '5to', 6: '6to', 7: '7mo', 8: '8vo' } as Record<number,string>)[n] || `${n}º`;
  const ordinalMedia = (n: number) => ({ 1: '1ro', 2: '2do', 3: '3ro', 4: '4to' } as Record<number,string>)[n] || `${n}º`;
  const labelForBasica = (n: number, short = false) => short ? ordinalBasica(n) : `${ordinalBasica(n)} Básico`;
  const labelForMedia = (n: number, short = false) => short ? ordinalMedia(n) : `${ordinalMedia(n)} Medio`;
    const getCourseMeta = (courseId?: string) => coursesAll.find((c: any) => String(c?.id) === String(courseId));
    const getSectionMeta = (sectionId?: string) => sectionsAll.find((s: any) => String(s?.id || s?.sectionId) === String(sectionId));
    const getCourseLevel = (courseId?: string): Level | undefined => {
      const c = getCourseMeta(courseId);
      return (c?.level as Level) || undefined;
    };
    const getCourseGradeNum = (courseId?: string): number | undefined => {
      const c = getCourseMeta(courseId);
      const name: string = c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || '';
      const m = name.match(/(\d{1,2})/);
      const n = m ? parseInt(m[1], 10) : undefined;
      if (!n) return undefined;
      // limitar por nivel
      const lvl = getCourseLevel(courseId);
      if (lvl === 'basica' && (n < 1 || n > 8)) return undefined;
      if (lvl === 'media' && (n < 1 || n > 4)) return undefined;
      return n;
    };
    const csOf = (s: any): { courseId?: string; sectionId?: string } => {
      const cs = s?.courseSectionId || s?.course;
      if (typeof cs === 'string' && cs.includes('-')) {
        const parts = cs.split('-');
        return { courseId: parts.slice(0, parts.length - 1).join('-'), sectionId: parts[parts.length - 1] };
      }
      return { courseId: s?.courseId || s?.course, sectionId: s?.sectionId || s?.section };
    };
    const avgPctOfSubs = (subs: any[]): number => {
      if (!subs.length) return 0;
      const arr = subs.map(norm100);
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    };

    let comparisonDataPct: CompItem[] = [];
    // Fallback instantáneo desde snapshot si no hay filtros específicos
    if (!filters?.courseId && !filters?.sectionId && (preloadStatsParam?.year === year) && (preloadStatsParam?.sectionAgg && preloadStatsParam.sectionAgg.length)) {
      const items: CompItem[] = (preloadStatsParam.sectionAgg as Array<{courseId:string|null;sectionId:string|null;present:number;total:number}>).map((it) => {
        const label = (() => {
          const cid = String(it.courseId || '');
          const sid = String(it.sectionId || '');
          if (cid && sid) return `${cid.split('-').slice(-1)[0]}${sid}`;
          if (sid) return sid;
          return cid || '—';
        })();
        const avgPct = it.total > 0 ? (it.present / it.total) * 100 : 0;
        return { label, avgPct } as CompItem;
      });
      // Ordenar por etiqueta
      items.sort((a: CompItem, b: CompItem)=> String(a.label).localeCompare(String(b.label), 'es'));
      comparisonDataPct = items;
    }

    // Base de datos para comparación: si no hay datos del profesor, usar todos
    const baseSubs = gradedSubs.length > 0 ? gradedSubs : allGradedSubs;

    // DATOS DE COMPARACIÓN - Omitir procesamiento si el gráfico está desactivado
    if (!filters?.skipComparisonProcessing) {
      if (filters?.sectionId) {
        // Caso 5 y 6: una sección -> solo ese curso-sección
        const sec = getSectionMeta(filters.sectionId);
        const courseId = sec?.courseId || (sec?.course && (sec.course.id || sec.courseId));
        const course = getCourseMeta(courseId);
        const courseLabel = (course?.gradeName || course?.name || t('course','Curso'));
        const secName = (sec?.fullName || sec?.displayName || sec?.longName || sec?.label || sec?.name || '').replace(/.*\bSecci[óo]n\s*/i, '') || '—';
        const label = `${courseLabel} ${secName}`.trim();
        const subs = baseSubs.filter(s => (csOf(s).sectionId || '') === String(filters.sectionId));
        const avgPct = avgPctOfSubs(subs);
        comparisonDataPct = [{ label, avgPct }];
      } else if (filters?.courseId) {
        // Caso 4: curso seleccionado -> todas las secciones disponibles
        const secs = sectionsAll.filter((s: any) => String(s?.courseId || s?.course?.id || s?.courseId) === String(filters.courseId));
        comparisonDataPct = secs.map((sec: any) => {
          const secId = String(sec?.id || sec?.sectionId);
          const secName = (sec?.fullName || sec?.displayName || sec?.longName || sec?.label || sec?.name || '').replace(/.*\bSecci[óo]n\s*/i, '') || '—';
          const course = getCourseMeta(filters.courseId);
          const courseLabel = (course?.gradeName || course?.name || t('course','Curso'));
          const fullLabel = `${courseLabel} ${secName}`.trim();
          const subs = baseSubs.filter(s => String(csOf(s).sectionId || '') === secId);
          return { label: fullLabel, avgPct: avgPctOfSubs(subs) };
        });
        // Ordenar por nombre de sección
        comparisonDataPct.sort((a, b) => a.label.localeCompare(b.label, 'es'));
        if (comparisonDataPct.length === 0) {
          // fallback simple
          comparisonDataPct = [{ label: 'A', avgPct: 82 }, { label: 'B', avgPct: 78 }];
        }
      } else if (filters?.level) {
        // Caso 3: nivel seleccionado -> todos los cursos del nivel (1..8 o 1..4)
        const range = filters.level === 'basica' ? [...Array(8)].map((_, i) => i + 1) : [...Array(4)].map((_, i) => i + 1);
        const items: CompItem[] = [];
        range.forEach(n => {
          // Leyenda corta: 1ero, 2do, 3ro… (requisito 1)
          const label = filters.level === 'basica' ? labelForBasica(n, true) : labelForMedia(n, true);
          // cursos que pertenecen a ese grado
          const courseIds = coursesAll
            .filter((c: any) => (c?.level === filters.level) && getCourseGradeNum(c?.id) === n)
            .map((c: any) => String(c.id));
          const subs = baseSubs.filter(s => courseIds.includes(String(csOf(s).courseId || '')));
          const avgPct = avgPctOfSubs(subs);
          items.push({ label, avgPct });
        });
        comparisonDataPct = items;
      } else {
        // Caso 2: sin selección -> promedio por nivel (básica vs media)
        const basicCourseIds = coursesAll.filter((c: any) => c?.level === 'basica').map((c: any) => String(c.id));
        const highCourseIds = coursesAll.filter((c: any) => c?.level === 'media').map((c: any) => String(c.id));
        const subsBasica = baseSubs.filter(s => basicCourseIds.includes(String(csOf(s).courseId || '')));
        const subsMedia = baseSubs.filter(s => highCourseIds.includes(String(csOf(s).courseId || '')));
        comparisonDataPct = [
          { label: t('levelBasic','Básica'), avgPct: avgPctOfSubs(subsBasica) },
          { label: t('levelHigh','Media'), avgPct: avgPctOfSubs(subsMedia) },
        ];
        // si ambas están en 0, fallback suave
        if (comparisonDataPct.every(x => !x.avgPct)) {
          comparisonDataPct = [
            { label: 'Básica', avgPct: 84 },
            { label: 'Media', avgPct: 78 },
          ];
        }
      }
    }

    // Promedio mensual (últimos 5 meses) 0-20 para "Notas por Fecha" (legacy para insights)
    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const labelsES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const nowD = new Date();
    const months: { key: string; label: string }[] = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
      months.push({ key: monthKey(d), label: labelsES[d.getMonth()] });
    }
    const monthlyAgg: Record<string, { sum: number; n: number }> = {};
    months.forEach(m => (monthlyAgg[m.key] = { sum: 0, n: 0 }));
  // Usar baseSubs (entregas filtradas globales) para que admin vea datos
  (baseSubs as any[]).forEach(s => {
      const t = parseWhen(s);
      if (!t) return;
      const d = new Date(t);
      const key = monthKey(d);
      if (!(key in monthlyAgg)) return;
      monthlyAgg[key].sum += norm100(s);
      monthlyAgg[key].n += 1;
    });
    let monthlyAvg20 = months.map(m => (
      monthlyAgg[m.key].n > 0 ? (monthlyAgg[m.key].sum / monthlyAgg[m.key].n) / 5 : 0
    ));
    // Fallback: si todo es 0, generar serie sintética estable (escala 0-20)
    if (monthlyAvg20.every(v => v === 0)) {
      const seedStr = JSON.stringify({ lvl: filters?.level, c: filters?.courseId, s: filters?.sectionId, sem: filters?.semester, p: period });
      let h = 2166136261; for (let i=0;i<seedStr.length;i++){ h ^= seedStr.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
      const r = () => { h^=h<<13; h^=h>>>17; h^=h<<5; return ((h>>>0)%1000)/1000; };
      monthlyAvg20 = months.map((_, idx) => 12 + Math.round((r()*6 + idx*0.6)*10)/10 );
    }
    const monthlyLabels = months.map(m => m.label);

    // Mapa mensual en porcentaje (0-100) para navegación por año en "Notas por Fecha"
    const monthlyAggAll: Record<string, { sum: number; n: number }> = {};
    // Notas por Fecha: transversal (sin filtro por período). Sí aplica filtros superiores.
    (submissions as any[])
      .filter(s => (typeof s.grade === 'number' || s.isGraded === true))
      .filter(matchFilters)
      .forEach(s => {
        const t = parseWhen(s);
        if (!t) return;
        const d = new Date(t);
        const key = monthKey(d);
        if (!monthlyAggAll[key]) monthlyAggAll[key] = { sum: 0, n: 0 };
        monthlyAggAll[key].sum += norm100(s);
        monthlyAggAll[key].n += 1;
      });
    const monthlyPctByKey: Record<string, number> = {};
    Object.keys(monthlyAggAll).forEach(k => {
      const a = monthlyAggAll[k];
      if (a.n > 0) monthlyPctByKey[k] = a.sum / a.n; // 0-100
    });

    return {
      tasksCreated,
      evaluationTasks,
      submissions: teacherSubs.length,
      gradedSubmissions: gradedSubs.length,
      avgGrade,
  avgScore20: avgScore20,
      attendance: { present, total },
      trendSeries: series,
      topCourses,
      gradeBins: bins,
  approvedCount,
  failedCount,
  topStudentAvg20,
  comparisonDataPct,
  monthlyAvg20,
  monthlyLabels,
  monthlyPctByKey,
      _debug: refreshTick,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, period, timeWindow.from, refreshTick, JSON.stringify(filters)]);

  return value;
}

export default function TeacherStatisticsPage() {
  // SQL: leer calificaciones desde backend (Supabase/IDB) si está conectado
  const { isConnected: isSQLConnected, getGradesByYear } = useGradesSQL();
  // SQL: leer asistencia desde backend (Supabase/IDB) si está conectado
  const { isConnected: isAttendanceSQLConnected, getAttendanceByYear } = useAttendanceSQL();
  const [sqlGradesByYear, setSqlGradesByYear] = useState<Record<number, any[]>>({});
  const [sqlAttendanceByYear, setSqlAttendanceByYear] = useState<Record<number, any[]>>({});

  // Estado salud Firebase (para que el indicador verde signifique conexión real a Firebase)
  const [firebaseHealthy, setFirebaseHealthy] = useState<boolean | null>(null);
  // Estado para indicar si Firebase tuvo timeout (para forzar uso de datos locales)
  const [firebaseTimedOut, setFirebaseTimedOut] = useState<boolean>(false);

  // Verificar salud de Firebase al montar (solo si está habilitado)
  // Usa timeout de 3 segundos - si no responde, marca como no saludable
  useEffect(() => {
    const checkHealth = async () => {
      try {
        if (!isFirebaseEnabled()) { setFirebaseHealthy(false); return; }
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
          console.warn('⚠️ Firebase health check: timeout después de 3s');
          setFirebaseTimedOut(true);
        }, 3000);
        const res = await fetch('/api/firebase/health', { cache: 'no-store', signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) { setFirebaseHealthy(false); setFirebaseTimedOut(true); return; }
        const data = await res.json().catch(() => ({}));
        const healthy = Boolean(data?.ok);
        setFirebaseHealthy(healthy);
        if (!healthy) setFirebaseTimedOut(true);
      } catch {
        setFirebaseHealthy(false);
        setFirebaseTimedOut(true);
        console.warn('⚠️ Firebase no disponible, usando datos locales');
      }
    };
    checkHealth();
  }, []);

  const { user } = useAuth();
  // Loader inicial para mejorar UX en cargas pesadas
  const hasShownLoaderRef = useRef(false);
  const [showLoader, setShowLoader] = useState<boolean>(false);
  const [loadProgress, setLoadProgress] = useState<number>(0);
  // 🔧 NUEVO: Sistema de carga progresiva con etapas específicas
  const [loadingStage, setLoadingStage] = useState<number>(0);
  const [loadingStageReady, setLoadingStageReady] = useState<Record<number, boolean>>({});
  // Etapas de carga:
  // 0 = Inicializando
  // 1 = Tarjetas de datos simples
  // 2 = Tarjetas de promedios (aprobados/reprobados)
  // 3 = Gráfico Asistencia
  // 4 = Gráfico Comparación de Cursos
  // 5 = Gráfico Calificaciones/Asistencia - Periodo
  // 6 = Insights Rápidos (análisis IA)
  const loadingStageMessages: Record<number, string> = {
    0: 'Inicializando conexión...',
    1: 'Cargando tarjetas de datos...',
    2: 'Calculando promedios y métricas...',
    3: 'Preparando gráfico de Asistencia...',
    4: 'Generando Comparación de Cursos...',
    5: 'Procesando datos por Periodo...',
    6: 'Analizando datos con IA...',
  };
  // Cambio de año con precarga (para evitar vacíos en tarjetas/gráficos)
  const [yearChanging, setYearChanging] = useState<boolean>(false);
  const [pendingYear, setPendingYear] = useState<number | null>(null);
  const [yearChangeProgress, setYearChangeProgress] = useState<number>(0);
  const yearChangeIntervalRef = useRef<number | null>(null);
  const loaderIntervalRef = useRef<number | null>(null);
  const loaderTimeoutRef = useRef<number | null>(null);
  // Priming/caching de datos pesados por año (para evitar recalcular en cada filtro)
  const [primedYears, setPrimedYears] = useState<Record<number, boolean>>({});
  const [isPriming, setIsPriming] = useState<boolean>(false);
  // Catálogo de asignaturas para badges consistentes con Gestión de Usuarios
  const subjectsCatalog = useMemo(() => {
    try { return getAllAvailableSubjects(); } catch { return []; }
  }, []);
  const { translate, language } = useLanguage();
  // Por defecto mostrar todos los datos (sin filtro de período) para consistencia
  // Cuando el usuario quita filtros, volverá a 'all' y el porcentaje será consistente
  
  // Estados y variables iniciales
  const [period, setPeriod] = useState<Period>(() => 'all');
  const [selectedCourse, setSelectedCourse] = useState<string | 'all'>('all');
  const [selectedLevel, setSelectedLevel] = useState<'all' | Level>('all');
  const [adminCourse, setAdminCourse] = useState<string | 'all'>('all');
  const [adminSection, setAdminSection] = useState<string | 'all'>('all');
  // 🔧 NUEVO: Estado para la letra de sección (A, B, etc.) - se usa cuando IDs están duplicados
  const [adminSectionLetter, setAdminSectionLetter] = useState<string>('');
  // 🔥 NUEVO: Calcular semestre por defecto según fecha actual
  // S1 = Marzo a Junio (meses 3-6), S2 = Julio a Diciembre (meses 7-12)
  const [semester, setSemester] = useState<Semester>(() => {
    const currentMonth = new Date().getMonth() + 1; // 1-12
    // Si estamos entre julio y diciembre, es 2do semestre
    // Si estamos entre marzo y junio, es 1er semestre
    // Si estamos en enero/febrero (vacaciones de verano), mostrar 2do semestre del año anterior
    if (currentMonth >= 7 && currentMonth <= 12) return 'S2';
    if (currentMonth >= 3 && currentMonth <= 6) return 'S1';
    return 'S2'; // Enero/febrero: mostrar último semestre
  });
  // Filtro de asignatura (paridad con pestaña Calificaciones)
  const [subjectFilter, setSubjectFilter] = useState<string>('all');
  // Priorizar que los gráficos y tarjetas pesadas se revelen SOLO cuando el loader desaparece
  // Así, toda la información aparece de una sola vez.
  const [prioritizeCharts, setPrioritizeCharts] = useState<boolean>(true);
  
  // 🚀 OPTIMIZACIÓN: Cargar gráficos de manera escalonada después del loader
  const [chartsLoadPhase, setChartsLoadPhase] = useState<number>(0);
  // Fase 0: Solo KPIs visibles
  // Fase 1: Gráfico de asistencia visible
  // Fase 2: Insights visible
  // Fase 3: Comparación de cursos visible
  // Fase 4: Gráfico de período visible
  // Fase 5: Todo listo
  
  // 🔧 MODIFICADO: Ahora chartsLoadPhase avanza basándose en datos disponibles
  // Esto permite que los gráficos se pre-rendericen detrás del overlay
  // NOTA: No usamos statsAPI aquí porque se define más adelante en el componente
  useEffect(() => {
    // Solo procesar si hay datos SQL disponibles (statsAPI no está disponible aquí aún)
    const hasAnyData = (Object.keys(sqlGradesByYear).length > 0) || (Object.keys(sqlAttendanceByYear).length > 0);
    
    if (!hasAnyData && chartsLoadPhase === 0) {
      // Aún no hay datos, mantener en fase 0
      return;
    }
    
    // Una vez que hay datos, avanzar las fases progresivamente
    if (chartsLoadPhase === 0) {
      // Fase 1: Inmediato - mostrar KPIs
      setChartsLoadPhase(1);
      setPrioritizeCharts(false);
    }
    
    if (chartsLoadPhase === 1) {
      // Fase 2: Después de 100ms - mostrar gráfico de asistencia
      const t1 = setTimeout(() => setChartsLoadPhase(2), 100);
      return () => clearTimeout(t1);
    }
    
    if (chartsLoadPhase === 2) {
      // Fase 3: Después de 150ms - mostrar insights
      const t2 = setTimeout(() => setChartsLoadPhase(3), 150);
      return () => clearTimeout(t2);
    }
    
    if (chartsLoadPhase === 3) {
      // Fase 4: Después de 200ms - mostrar comparación de cursos
      const t3 = setTimeout(() => setChartsLoadPhase(4), 200);
      return () => clearTimeout(t3);
    }
    
    if (chartsLoadPhase === 4) {
      // Fase 5: Después de 250ms - mostrar gráfico de período
      const t4 = setTimeout(() => setChartsLoadPhase(5), 250);
      return () => clearTimeout(t4);
    }
  }, [chartsLoadPhase, sqlGradesByYear, sqlAttendanceByYear]);
  
  // Estados para controlar visibilidad de gráficos
  const [showAttendanceChart, setShowAttendanceChart] = useState<boolean>(true);
  const [showComparisonChart, setShowComparisonChart] = useState<boolean>(true);
  const [showPeriodChart, setShowPeriodChart] = useState<boolean>(true);
  const [showQuickInsights, setShowQuickInsights] = useState<boolean>(true);
  
  // Estado para el tipo de comparación (notas o asistencia) - iniciar en asistencia para mostrar período académico
  const [comparisonType, setComparisonType] = useState<'notas' | 'asistencia'>('asistencia');
  
  // Estado para el zoom del gráfico de período - iniciar en true para mostrar zoom por defecto
  const [periodZoomY, setPeriodZoomY] = useState<boolean>(true);
  
  // Estado para sincronización de insights IA
  const [insightsSync, setInsightsSync] = useState<boolean>(false); // Iniciar como false para indicar que no hay insights
  const [aiInsights, setAiInsights] = useState<string[]>([]);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState<boolean>(false);
  
  // Valores debouncados para optimizar rendimiento - reducidos para mejor respuesta
  const debouncedSelectedLevel = useDebounce(selectedLevel, 150);
  const debouncedAdminCourse = useDebounce(adminCourse, 150);
  const debouncedAdminSection = useDebounce(adminSection, 150);
  const debouncedAdminSectionLetter = useDebounce(adminSectionLetter, 150);
  const debouncedSemester = useDebounce(semester, 100);
  const debouncedSubjectFilter = useDebounce(subjectFilter, 150);
  
  // Año seleccionado - Siempre inicia con el año actual
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const currentYear = new Date().getFullYear();
  const isPastYear = selectedYear < currentYear;

  // 🚀 OPTIMIZACIÓN SQL: Usar estadísticas precomputadas desde la API como fuente principal
  const statsAPI = useStatsLegacyFormat(selectedYear);

  // Fallback a snapshots locales solo si la API no tiene datos (migración gradual)
  const [fallbackKPIs, setFallbackKPIs] = useState<{ year: number; attendancePct?: number; studentsCount?: number; approvedCount?: number; failedCount?: number; overallAvgPct?: number } | null>(null);
  const [fallbackStats, setFallbackStats] = useState<{ year: number; attendanceMonthly?: Record<string,{present:number;total:number}>; sectionAgg?: Array<{courseId:string|null;sectionId:string|null;present:number;total:number}> } | null>(null);
  
  // Datos finales: priorizar API, usar snapshots como fallback
  const preloadKPIs = statsAPI.kpis || fallbackKPIs;
  const preloadStats = {
    year: selectedYear,
    attendanceMonthly: Object.keys(statsAPI.attendanceMonthly || {}).length > 0 ? statsAPI.attendanceMonthly : fallbackStats?.attendanceMonthly,
    sectionAgg: (statsAPI.sectionAgg || []).length > 0 ? statsAPI.sectionAgg : fallbackStats?.sectionAgg
  };
  
  // Exponer snapshot stats para hooks internos (lectura solamente)  
  const preloadStatsGlobal = preloadStats;

  // Cargar snapshots locales como fallback SOLO al cambiar año (evitar bucles infinitos)
  useEffect(() => {
    try {
      const y = selectedYear;
      
      // Cargar snapshots locales inmediatamente (sin esperar API)
      const snap = readKPIsSnapshot(y);
      if (snap) setFallbackKPIs({
        year: y,
        attendancePct: snap.attendancePct,
        studentsCount: snap.studentsCount,
        approvedCount: snap.approvedCount,
        failedCount: snap.failedCount,
        overallAvgPct: snap.overallAvgPct
      });
      
      // SIEMPRE calcular KPIs básicos desde localStorage al inicio
      // Esto asegura que haya datos inmediatos sin depender de Firebase/SQL
      const ensureBasicKPIs = () => {
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          let studentsCount = 0;
          let coursesCount = 0;
          let sectionsCount = 0;
          let teachersCount = 0;
          
          // Contar estudiantes
          try {
            const students = LocalStorageManager.getStudentsForYear?.(y) || [];
            if (Array.isArray(students)) studentsCount = students.length;
          } catch {}
          if (studentsCount === 0) {
            try {
              const globalUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
              if (Array.isArray(globalUsers)) {
                studentsCount = globalUsers.filter((u: any) => (u?.role === 'student' || u?.role === 'estudiante')).length;
              }
            } catch {}
          }
          
          // Contar cursos
          try {
            const courses = LocalStorageManager.getCoursesForYear?.(y) || [];
            if (Array.isArray(courses)) coursesCount = courses.length;
          } catch {}
          if (coursesCount === 0) {
            try {
              const adminCourses = JSON.parse(localStorage.getItem(`smart-student-admin-courses-${y}`) || localStorage.getItem('smart-student-admin-courses') || '[]');
              const userCourses = JSON.parse(localStorage.getItem(`smart-student-courses-${y}`) || localStorage.getItem('smart-student-courses') || '[]');
              coursesCount = [...(Array.isArray(adminCourses) ? adminCourses : []), ...(Array.isArray(userCourses) ? userCourses : [])].length;
            } catch {}
          }
          
          // Contar secciones
          try {
            const sections = LocalStorageManager.getSectionsForYear?.(y) || [];
            if (Array.isArray(sections)) sectionsCount = sections.length;
          } catch {}
          if (sectionsCount === 0) {
            try {
              const adminSections = JSON.parse(localStorage.getItem(`smart-student-admin-sections-${y}`) || localStorage.getItem('smart-student-admin-sections') || '[]');
              const userSections = JSON.parse(localStorage.getItem(`smart-student-sections-${y}`) || localStorage.getItem('smart-student-sections') || '[]');
              sectionsCount = [...(Array.isArray(adminSections) ? adminSections : []), ...(Array.isArray(userSections) ? userSections : [])].length;
            } catch {}
          }
          // Si no hay secciones pero hay cursos, generar virtuales (2 por curso)
          if (sectionsCount === 0 && coursesCount > 0) {
            sectionsCount = coursesCount * 2;
          }
          
          // Contar profesores
          try {
            const teachers = LocalStorageManager.getTeachersForYear?.(y) || [];
            if (Array.isArray(teachers)) teachersCount = teachers.length;
          } catch {}
          if (teachersCount === 0) {
            try {
              const globalUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
              if (Array.isArray(globalUsers)) {
                teachersCount = globalUsers.filter((u: any) => (u?.role === 'teacher' || u?.role === 'profesor' || u?.role === 'admin')).length;
              }
            } catch {}
          }
          
          // Calcular estadísticas de calificaciones desde localStorage
          let approvedCount = 0;
          let failedCount = 0;
          let overallAvgPct: number | undefined = undefined;
          
          try {
            // Obtener calificaciones de localStorage
            const sourceGrades = LocalStorageManager.getTestGradesForYear?.(y) || [];
            
            if (Array.isArray(sourceGrades) && sourceGrades.length > 0) {
              // Agrupar calificaciones por estudiante
              const byStudent: Record<string, { sum: number; n: number }> = {};
              sourceGrades.forEach((grade: any) => {
                const studentKey = String(grade.studentId || grade.student_id || grade.studentUsername || '');
                const score = typeof grade.score === 'number' ? grade.score : undefined;
                
                if (!studentKey || typeof score !== 'number' || !isFinite(score)) return;
                
                if (!byStudent[studentKey]) byStudent[studentKey] = { sum: 0, n: 0 };
                byStudent[studentKey].sum += score;
                byStudent[studentKey].n += 1;
              });
              
              // Calcular promedios finales por estudiante
              const finalAvgs = Object.values(byStudent).map(x => x.sum / x.n).filter(v => typeof v === 'number' && isFinite(v)) as number[];
              
              if (finalAvgs.length > 0) {
                overallAvgPct = finalAvgs.reduce((a,b) => a+b, 0) / finalAvgs.length;
                const passPercent = 60; // Porcentaje mínimo para aprobar
                approvedCount = finalAvgs.filter(v => v >= passPercent).length;
                failedCount = finalAvgs.filter(v => v < passPercent).length;
                
                // Actualizar studentsCount desde calificaciones si no tenemos dato
                if (studentsCount === 0 && finalAvgs.length > 0) {
                  studentsCount = finalAvgs.length;
                }
              }
            }
          } catch (e) {
            console.warn('[Stats] Error calculando estadísticas de calificaciones:', e);
          }
          
          // Calcular estadísticas de asistencia mensual desde localStorage
          let attendanceMonthly: Record<string, {present: number; total: number}> = {};
          try {
            const attendance = LocalStorageManager.getAttendanceForYear?.(y) || [];
            if (Array.isArray(attendance) && attendance.length > 0) {
              // Agrupar por mes (YYYY-MM)
              attendance.forEach((r: any) => {
                const dateVal = r.date || r.timestamp || r.when;
                let ts = 0;
                if (typeof dateVal === 'number') ts = dateVal;
                else if (typeof dateVal === 'string') {
                  if (/^\d{4}-\d{2}-\d{2}/.test(dateVal)) ts = new Date(dateVal.slice(0, 10) + 'T00:00:00').getTime();
                  else if (/^\d{2}-\d{2}-\d{4}$/.test(dateVal)) {
                    const [dd, mm, yyyy] = dateVal.split('-').map(Number);
                    ts = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
                  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateVal)) {
                    const [dd, mm, yyyy] = dateVal.split('/').map(Number);
                    ts = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
                  } else {
                    const t = Date.parse(dateVal);
                    if (!isNaN(t)) ts = t;
                  }
                }
                if (!ts || new Date(ts).getFullYear() !== y) return;
                
                const d = new Date(ts);
                const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                
                if (!attendanceMonthly[monthKey]) {
                  attendanceMonthly[monthKey] = { present: 0, total: 0 };
                }
                
                // Contar presentes y total
                if (r.status === 'present' || r.present === true) {
                  attendanceMonthly[monthKey].present += 1;
                  attendanceMonthly[monthKey].total += 1;
                } else if (r.status === 'absent' || r.present === false || r.status === 'late') {
                  attendanceMonthly[monthKey].total += 1;
                  if (r.status === 'late') attendanceMonthly[monthKey].present += 1; // late cuenta como presente
                } else if (Array.isArray(r.presentStudents)) {
                  // Formato batch: array de estudiantes presentes
                  attendanceMonthly[monthKey].present += r.presentStudents.length;
                  attendanceMonthly[monthKey].total += r.presentStudents.length + (r.absentStudents?.length || 0);
                }
              });
            }
          } catch (e) {
            console.warn('[Stats] Error calculando asistencia mensual:', e);
          }
          
          // Actualizar fallbackStats con asistencia mensual
          if (Object.keys(attendanceMonthly).length > 0) {
            setFallbackStats(prev => ({
              ...(prev || { year: y }),
              attendanceMonthly: attendanceMonthly,
            }));
          }
          
          // Actualizar fallbackKPIs si encontramos datos
          if (studentsCount > 0 || coursesCount > 0 || sectionsCount > 0 || teachersCount > 0 || approvedCount > 0) {
            setFallbackKPIs(prev => ({
              ...(prev || { year: y }),
              studentsCount: studentsCount || prev?.studentsCount,
              approvedCount: approvedCount > 0 ? approvedCount : prev?.approvedCount,
              failedCount: failedCount > 0 ? failedCount : prev?.failedCount,
              overallAvgPct: typeof overallAvgPct === 'number' ? overallAvgPct : prev?.overallAvgPct,
            }));
            // Persistir en snapshot para futuras cargas instantáneas
            writeKPIsSnapshot(y, { 
              studentsCount: studentsCount || undefined,
              approvedCount: approvedCount > 0 ? approvedCount : undefined,
              failedCount: failedCount > 0 ? failedCount : undefined,
              overallAvgPct: typeof overallAvgPct === 'number' ? overallAvgPct : undefined,
            });
          }
        } catch (e) {
          console.warn('[Stats] Error calculando KPIs básicos:', e);
        }
      };
      
      // Siempre intentar calcular KPIs básicos
      ensureBasicKPIs();

      const s = readStatsSnapshot(y);
      if (s && s.attendanceMonthly && Object.keys(s.attendanceMonthly).length > 0) {
        setFallbackStats({ year: y, attendanceMonthly: s.attendanceMonthly, sectionAgg: s.sectionAgg });
      } else {
        // 🚀 OPTIMIZACIÓN: Si no hay snapshot, calcular datos mensuales desde localStorage inmediatamente
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          const rawAttendance = LocalStorageManager.getAttendanceForYear?.(y) || [];
          
          if (Array.isArray(rawAttendance) && rawAttendance.length > 0) {
            const attendanceMonthly: Record<string, { present: number; total: number }> = {};
            
            rawAttendance.forEach((r: any) => {
              const dateVal = r.date || r.timestamp || r.when;
              let ts = 0;
              if (typeof dateVal === 'number') ts = dateVal;
              else if (typeof dateVal === 'string') {
                if (/^\d{4}-\d{2}-\d{2}/.test(dateVal)) ts = new Date(dateVal.slice(0, 10) + 'T00:00:00').getTime();
                else if (/^\d{2}-\d{2}-\d{4}$/.test(dateVal)) {
                  const [dd, mm, yyyy] = dateVal.split('-').map(Number);
                  ts = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
                } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateVal)) {
                  const [dd, mm, yyyy] = dateVal.split('/').map(Number);
                  ts = new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
                } else {
                  const t = Date.parse(dateVal);
                  if (!isNaN(t)) ts = t;
                }
              }
              if (!ts || new Date(ts).getFullYear() !== y) return;
              
              const d = new Date(ts);
              const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              
              if (!attendanceMonthly[monthKey]) {
                attendanceMonthly[monthKey] = { present: 0, total: 0 };
              }
              
              // Contar presentes y total
              if (r.status === 'present' || r.present === true) {
                attendanceMonthly[monthKey].present += 1;
                attendanceMonthly[monthKey].total += 1;
              } else if (r.status === 'absent' || r.present === false || r.status === 'late') {
                attendanceMonthly[monthKey].total += 1;
                if (r.status === 'late') attendanceMonthly[monthKey].present += 1;
              } else if (Array.isArray(r.presentStudents)) {
                attendanceMonthly[monthKey].present += r.presentStudents.length;
                attendanceMonthly[monthKey].total += r.presentStudents.length + (r.absentStudents?.length || 0);
              }
            });
            
            if (Object.keys(attendanceMonthly).length > 0) {
              setFallbackStats({ year: y, attendanceMonthly, sectionAgg: s?.sectionAgg });
              // Guardar en snapshot para próximas cargas
              writeStatsSnapshot(y, { attendanceMonthly });
            }
          }
        } catch (e) {
          console.warn('[Stats] Error calculando asistencia mensual inicial:', e);
        }
      }

    } catch {}
  }, [selectedYear]);

  // Listeners para eventos de cambio de usuarios (efecto separado para evitar re-renders)
  useEffect(() => {
    const y = selectedYear;
    
    // Refrescar studentsCount cuando cambien usuarios/asignaciones
    const onUsersChanged = () => {
      try {
        const { LocalStorageManager } = require('@/lib/education-utils');
        const arr = LocalStorageManager.getStudentsForYear?.(y) || [];
        const count = Array.isArray(arr) && arr.length ? arr.length : (JSON.parse(localStorage.getItem('smart-student-users')||'[]').filter((u:any)=>u?.role==='student' || u?.role==='estudiante').length || 0);
        if (count > 0) {
          setFallbackKPIs(prev => ({ ...(prev || { year: y }), studentsCount: count }));
          writeKPIsSnapshot(y, { studentsCount: count });
        }
      } catch {}
    };
    
    window.addEventListener('usersUpdated', onUsersChanged as any);
    window.addEventListener('studentAssignmentsChanged', onUsersChanged as any);
    
    return () => {
      try { window.removeEventListener('usersUpdated', onUsersChanged as any); } catch {}
      try { window.removeEventListener('studentAssignmentsChanged', onUsersChanged as any); } catch {}
    };
  }, [selectedYear]);

  // Cargar calificaciones SQL para el año seleccionado cuando haya conexión
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!isSQLConnected) {
        return;
      }
      try {
        const arr = await getGradesByYear(selectedYear);
        if (Array.isArray(arr) && arr.length > 0) {
        }
        if (mounted) {
          setSqlGradesByYear(prev => ({ ...prev, [selectedYear]: Array.isArray(arr) ? arr : [] }));
        }
      } catch (e) {
        console.error(`❌ Error cargando calificaciones SQL para ${selectedYear}:`, e);
      }
    };
    load();
    const onSQL = () => load();
    window.addEventListener('sqlGradesUpdated', onSQL as any);
    return () => { mounted = false; window.removeEventListener('sqlGradesUpdated', onSQL as any); };
  }, [isSQLConnected, getGradesByYear, selectedYear]);

  // 🚀 OPTIMIZACIÓN: Recalcular KPIs cuando los datos SQL estén disponibles
  // Este efecto se ejecuta después de que los datos SQL se carguen y actualiza los KPIs de calificaciones
  useEffect(() => {
    const y = selectedYear;
    
    // Si hay datos de calificaciones SQL disponibles, recalcular KPIs
    if (isSQLConnected && Array.isArray(sqlGradesByYear[y]) && sqlGradesByYear[y].length > 0) {
      try {
        const sourceGrades = sqlGradesByYear[y];
        
        // Agrupar calificaciones por estudiante
        const byStudent: Record<string, { sum: number; n: number }> = {};
        sourceGrades.forEach((grade: any) => {
          const studentKey = String(grade.studentId || grade.student_id || grade.studentUsername || '');
          const score = typeof grade.score === 'number' ? grade.score : undefined;
          
          if (!studentKey || typeof score !== 'number' || !isFinite(score)) return;
          
          if (!byStudent[studentKey]) byStudent[studentKey] = { sum: 0, n: 0 };
          byStudent[studentKey].sum += score;
          byStudent[studentKey].n += 1;
        });
        
        // Calcular promedios finales por estudiante
        const finalAvgs = Object.values(byStudent).map(x => x.sum / x.n).filter(v => typeof v === 'number' && isFinite(v)) as number[];
        
        if (finalAvgs.length > 0) {
          const overallAvgPct = finalAvgs.reduce((a,b) => a+b, 0) / finalAvgs.length;
          const passPercent = 60;
          const approvedCount = finalAvgs.filter(v => v >= passPercent).length;
          const failedCount = finalAvgs.filter(v => v < passPercent).length;
          
          // Actualizar fallbackKPIs con datos SQL
          setFallbackKPIs(prev => ({
            ...(prev || { year: y }),
            approvedCount,
            failedCount,
            overallAvgPct,
            studentsCount: finalAvgs.length > (prev?.studentsCount || 0) ? finalAvgs.length : prev?.studentsCount,
          }));
          
          // Persistir en snapshot
          writeKPIsSnapshot(y, { 
            approvedCount,
            failedCount,
            overallAvgPct,
          });
        }
      } catch (e) {
        console.warn('[Stats] Error recalculando KPIs desde datos SQL:', e);
      }
    }
    
    // Si hay datos de asistencia SQL disponibles, recalcular porcentaje de asistencia
    if (isAttendanceSQLConnected && Array.isArray(sqlAttendanceByYear[y]) && sqlAttendanceByYear[y].length > 0) {
      try {
        const attendance = sqlAttendanceByYear[y];
        let totalPresent = 0;
        let totalRecords = 0;
        
        attendance.forEach((r: any) => {
          const status = r.status || (r.present === true ? 'present' : r.present === false ? 'absent' : null);
          if (status === 'present' || status === 'late') {
            totalPresent++;
            totalRecords++;
          } else if (status === 'absent') {
            totalRecords++;
          } else if (Array.isArray(r.presentStudents)) {
            totalPresent += r.presentStudents.length;
            totalRecords += r.presentStudents.length + (r.absentStudents?.length || 0);
          }
        });
        
        if (totalRecords > 0) {
          const attendancePct = (totalPresent / totalRecords) * 100;
          
          // Actualizar fallbackKPIs con porcentaje de asistencia SQL
          setFallbackKPIs(prev => ({
            ...(prev || { year: y }),
            attendancePct,
          }));
          
          // Persistir en snapshot
          writeKPIsSnapshot(y, { attendancePct });
        }
      } catch (e) {
        console.warn('[Stats] Error recalculando asistencia desde datos SQL:', e);
      }
    }
  }, [selectedYear, isSQLConnected, sqlGradesByYear, isAttendanceSQLConnected, sqlAttendanceByYear]);

  // Estado para el año del gráfico de período - iniciar en año anterior (el gráfico solo muestra hasta currentYear - 1)
  const [periodYear, setPeriodYear] = useState<number>(() => {
    // El gráfico GradesOverTimeChart tiene maxYear = currentYear - 1, entonces iniciar ahí
    return new Date().getFullYear() - 1;
  });

  // 🚀 TIMEOUT: No esperar SQL indefinidamente (máx 3 segundos)
  const [sqlLoadTimeout, setSqlLoadTimeout] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSqlLoadTimeout(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Condición de preparación de datos para cerrar loader
  // 🚀 OPTIMIZACIÓN: Si hay stats cacheados, cerrar loader inmediatamente sin esperar SQL
  // SQL puede cargar en background para filtros detallados
  // IMPORTANTE: También verificar periodYear para el gráfico "Asistencia - Periodo"
  // 🔧 NUEVO: Si Firebase hizo timeout, no esperar por SQL (usará datos locales)
  const sqlGradesReady = !isSQLConnected || sqlGradesByYear[selectedYear] !== undefined || sqlLoadTimeout || firebaseTimedOut;
  const sqlAttendanceReadyForSelectedYear = !isAttendanceSQLConnected || sqlAttendanceByYear[selectedYear] !== undefined || sqlLoadTimeout || firebaseTimedOut;
  const sqlAttendanceReadyForPeriodYear = !isAttendanceSQLConnected || sqlAttendanceByYear[periodYear] !== undefined || sqlLoadTimeout || firebaseTimedOut;
  const sqlAttendanceReady = sqlAttendanceReadyForSelectedYear; // Solo bloquear por año seleccionado, periodYear carga en background
  
  // API lista si dejó de cargar (independiente de si tiene datos o no)
  const apiReady = !statsAPI.loading;
  
  // 🚀 NUEVO: Datos cacheados disponibles = podemos mostrar KPIs inmediatamente
  const hasCachedStats = statsAPI.hasData && statsAPI.cached;
  
  // El loader puede cerrarse cuando:
  // 1. Hay stats cacheados disponibles (prioridad máxima - carga instantánea), O
  // 2. SQL está listo (o no hay conexión o timeout) Y la API terminó de cargar
  const initialDataReady = hasCachedStats || sqlLoadTimeout || (sqlGradesReady && sqlAttendanceReady && apiReady);

  // Inicializar loader solo al montar por primera vez
  useEffect(() => {
    if (hasShownLoaderRef.current) return;
    hasShownLoaderRef.current = true;
    setShowLoader(true);
    setLoadProgress(5); // Empezar en 5% para indicar que está funcionando
    setLoadingStage(0); // Iniciar en etapa 0
    
    // 🔧 NUEVO: No usar intervalo automático - el progreso se controla por etapas
    // Fallback de seguridad: auto-cerrar después de 15 segundos máximo para evitar loader infinito
    loaderTimeoutRef.current = window.setTimeout(() => {
      if (loaderIntervalRef.current) { window.clearInterval(loaderIntervalRef.current); loaderIntervalRef.current = null; }
      setLoadProgress(100);
      setLoadingStage(6);
      setLoadingStageReady({ 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });
      setTimeout(() => setShowLoader(false), 300);
    }, 15000); // 15 segundos máximo
    
    return () => {
      if (loaderIntervalRef.current) { window.clearInterval(loaderIntervalRef.current); loaderIntervalRef.current = null; }
      if (loaderTimeoutRef.current) { window.clearTimeout(loaderTimeoutRef.current); loaderTimeoutRef.current = null; }
    };
  }, []);

  // 🔧 ELIMINADO: El viejo efecto que cerraba el loader prematuramente
  // Ahora el loader se cierra desde el nuevo efecto de etapas cuando loadingStage llega a 6
  
  // 🔧 NUEVO: Efecto para avanzar etapas de carga basado en datos reales
  // NO cierra el loader hasta que los datos estén realmente disponibles
  useEffect(() => {
    if (!showLoader) return;
    
    // Función para verificar si una etapa está lista
    const checkStageReady = () => {
      // Etapa 1: Datos iniciales y tarjetas simples
      if (loadingStage === 0 && initialDataReady) {
        setLoadingStage(1);
        setLoadProgress(15);
        setLoadingStageReady(prev => ({ ...prev, 0: true }));
        return;
      }
      
      // Etapa 2: Promedios (KPIs calculados)
      if (loadingStage === 1) {
        // Verificar si hay KPIs disponibles (de API o cache)
        const hasKPIs = statsAPI.hasData || hasCachedStats || sqlLoadTimeout;
        if (hasKPIs) {
          setLoadingStage(2);
          setLoadProgress(30);
          setLoadingStageReady(prev => ({ ...prev, 1: true }));
          return;
        }
      }
      
      // Etapa 3: Gráfico Asistencia (datos de asistencia cargados)
      if (loadingStage === 2) {
        const hasAttendance = sqlAttendanceReady || (sqlAttendanceByYear[selectedYear]?.length ?? 0) > 0 || sqlLoadTimeout;
        if (hasAttendance) {
          setLoadingStage(3);
          setLoadProgress(45);
          setLoadingStageReady(prev => ({ ...prev, 2: true }));
          return;
        }
      }
      
      // Etapa 4: Comparación de Cursos (datos de calificaciones cargados)
      if (loadingStage === 3) {
        const hasGrades = sqlGradesReady || (sqlGradesByYear[selectedYear]?.length ?? 0) > 0 || sqlLoadTimeout;
        if (hasGrades) {
          setLoadingStage(4);
          setLoadProgress(60);
          setLoadingStageReady(prev => ({ ...prev, 3: true }));
          return;
        }
      }
      
      // Etapa 5: Gráfico de Periodo (priming completado)
      if (loadingStage === 4) {
        const hasPeriodData = primedYears[selectedYear] || primedYears[periodYear] || sqlLoadTimeout;
        if (hasPeriodData) {
          setLoadingStage(5);
          setLoadProgress(75);
          setLoadingStageReady(prev => ({ ...prev, 4: true }));
          return;
        }
      }
      
      // Etapa 6: Insights IA (todo listo para análisis)
      if (loadingStage === 5) {
        // Verificar que todos los datos base estén disponibles para generar insights
        const allDataReady = initialDataReady && (hasCachedStats || statsAPI.hasData);
        if (allDataReady || sqlLoadTimeout) {
          setLoadingStage(6);
          setLoadProgress(90);
          setLoadingStageReady(prev => ({ ...prev, 5: true }));
          return;
        }
      }
      
      // Etapa final: 100% y cerrar SOLO cuando chartsLoadPhase >= 5 (todos los gráficos renderizados)
      if (loadingStage === 6 && chartsLoadPhase >= 5) {
        setLoadProgress(100);
        setLoadingStageReady(prev => ({ ...prev, 6: true }));
        // Cerrar loader después de mostrar 100% un momento
        setTimeout(() => {
          if (loaderTimeoutRef.current) {
            clearTimeout(loaderTimeoutRef.current);
            loaderTimeoutRef.current = null;
          }
          setShowLoader(false);
        }, 400);
      }
    };
    
    // Verificar cada 100ms si podemos avanzar de etapa
    const interval = setInterval(checkStageReady, 100);
    
    // También verificar inmediatamente
    checkStageReady();
    
    return () => clearInterval(interval);
  }, [showLoader, loadingStage, initialDataReady, statsAPI.hasData, hasCachedStats, sqlAttendanceReady, sqlAttendanceByYear, selectedYear, sqlGradesReady, sqlGradesByYear, primedYears, periodYear, sqlLoadTimeout, chartsLoadPhase]);

  // Priming: construir índices y caches por año mientras el loader está activo para acelerar cambios de filtros
  useEffect(() => {
    if (!showLoader || !initialDataReady) return;
    // Evitar repetir si ya existe
    const yearsToPrime = [selectedYear, periodYear].filter((y, idx, arr) => Number.isFinite(y) && (idx === arr.indexOf(y)) && !primedYears[y]);
    if (yearsToPrime.length === 0) return;
    let cancelled = false;
    const prime = async () => {
      try {
        setIsPriming(true);
        for (const y of yearsToPrime) {
          if (cancelled) break;
          // 1) Asistencia: preferir SQL; fallback a LocalStorageManager o claves locales
          let attendance: any[] = [];
          try {
            if (isAttendanceSQLConnected && Array.isArray(sqlAttendanceByYear[y])) {
              attendance = sqlAttendanceByYear[y] || [];
            } else {
              try {
                const { LocalStorageManager } = require('@/lib/education-utils');
                attendance = LocalStorageManager.getAttendanceForYear?.(y) || [];
              } catch {
                attendance = JSON.parse(localStorage.getItem(`smart-student-attendance-${y}`) || '[]');
              }
            }
          } catch {
            attendance = [];
          }
          // Construir índice por día (usa cache interna si no cambió el origen)
          try {
            const res = buildAttendanceYearIndex(y, attendance);
            if (res?.dayIndex) {
              // Actualizar progreso intermedio
              setLoadProgress(p => Math.max(p, 90));
            }
          } catch {}

          // 2) Calificaciones: preferir SQL; fallback a LocalStorage/Manager
          let grades: any[] = [];
          try {
            if (isSQLConnected && Array.isArray(sqlGradesByYear[y])) {
              grades = sqlGradesByYear[y] || [];
            } else {
              try { const { LocalStorageManager } = require('@/lib/education-utils'); grades = LocalStorageManager.getTestGradesForYear?.(y) || []; } catch { grades = []; }
              if (!Array.isArray(grades) || grades.length === 0) {
                try { grades = JSON.parse(localStorage.getItem(`smart-student-submissions-${y}`) || '[]'); } catch { grades = []; }
              }
            }
          } catch { grades = []; }
          try {
            const resG = buildGradesYearIndex(y, grades);
            if (resG?.monthIndex) {
              setLoadProgress(p => Math.max(p, 95));
            }
          } catch {}
          // Marcar año como primed
          setPrimedYears(prev => ({ ...prev, [y]: true }));
        }
      } finally {
        if (!cancelled) setIsPriming(false);
      }
    };
    prime();
    return () => { cancelled = true; };
  }, [showLoader, initialDataReady, selectedYear, periodYear, isAttendanceSQLConnected, sqlAttendanceByYear, isSQLConnected, sqlGradesByYear, primedYears]);

  // Cargar asistencia desde Firebase/SQL para años relevantes (selectedYear y periodYear)
  useEffect(() => {
    let mounted = true;
    const firebaseEnabled = isFirebaseEnabled();
    if (!isAttendanceSQLConnected && !firebaseEnabled) {
      return;
    }

    const loadAttendance = async (y: number) => {
      try {
        const arr = await getAttendanceByYear(y);
        if (mounted) {
          setSqlAttendanceByYear(prev => ({ ...prev, [y]: Array.isArray(arr) ? arr : [] }));
        }
      } catch (error) {
        console.error(`❌ Error cargando asistencia para el año ${y}:`, error);
      }
    };

    const yearsToLoad = new Set([selectedYear, periodYear]);
    yearsToLoad.forEach(yearToLoad => {
      if (Number.isFinite(yearToLoad)) {
        loadAttendance(yearToLoad);
      }
    });

    const onSQL = (e: any) => {
      const y = Number(e?.detail?.year || selectedYear);
      if (Number.isFinite(y)) loadAttendance(y);
    };
    window.addEventListener('sqlAttendanceUpdated', onSQL as any);
    return () => { mounted = false; window.removeEventListener('sqlAttendanceUpdated', onSQL as any); };
  }, [isAttendanceSQLConnected, getAttendanceByYear, selectedYear, periodYear]);

  // Cargar calificaciones SQL también para el año de Periodo cuando se muestre "Calificaciones - Periodo"
  useEffect(() => {
    let mounted = true;
    const loadGradesForPeriod = async (y: number) => {
      // 🔧 CORREGIDO: Usar localStorage primero, Firestore solo como último recurso
      try {
        let arr: any[] = [];
        if (isSQLConnected) {
          arr = await getGradesByYear(y);
        } else {
          // 1. Intentar LocalStorageManager primero (sin async)
          try {
            const { LocalStorageManager } = await import('@/lib/education-utils');
            arr = LocalStorageManager.getTestGradesForYear?.(y) || [];
            if (arr.length > 0) {
              console.log(`[Estadisticas] Usando LocalStorageManager para año ${y}:`, arr.length, 'registros');
            }
          } catch { arr = []; }
          
          // 2. Fallback a localStorage directo
          if (arr.length === 0) {
            try {
              arr = JSON.parse(localStorage.getItem(`smart-student-submissions-${y}`) || '[]');
              if (arr.length > 0) {
                console.log(`[Estadisticas] Usando localStorage directo para año ${y}:`, arr.length, 'registros');
              }
            } catch { arr = []; }
          }
          
          // 3. Último recurso: Firestore (solo si hay datos vacíos Y Firebase está habilitado)
          if (arr.length === 0 && process.env.NEXT_PUBLIC_USE_FIREBASE === 'true') {
            try {
              const { firestoreDB } = await import('@/lib/firestore-database');
              const firestoreData = await firestoreDB.getGradesByYear(y);
              if (Array.isArray(firestoreData) && firestoreData.length > 0) {
                arr = firestoreData;
                console.log(`[Estadisticas] Usando Firestore para año ${y}:`, arr.length, 'registros');
              }
            } catch (e) {
              // Silenciar error si Firestore no está disponible
              console.debug(`[Estadisticas] Firestore no disponible para año ${y}`);
            }
          }
        }
        if (mounted) {
          setSqlGradesByYear(prev => ({ ...prev, [y]: Array.isArray(arr) ? arr : [] }));
          console.log(`[Estadisticas] Calificaciones cargadas para año ${y}:`, Array.isArray(arr) ? arr.length : 0, 'registros');
        }
      } catch (e) {
        console.warn(`[Estadisticas] Error cargando calificaciones para año ${y}:`, e);
      }
    };
    
    // 🔧 CORREGIDO: Cargar calificaciones para AMBOS años siempre
    // No solo cuando comparisonType === 'notas'
    const yearsToLoad = new Set([selectedYear, periodYear]);
    yearsToLoad.forEach(y => {
      if (Number.isFinite(y) && !sqlGradesByYear[y]) {
        loadGradesForPeriod(y);
      }
    });
    
    const onSQL = (e: any) => {
      const y = Number(e?.detail?.year || periodYear);
      if (Number.isFinite(y) && (y === periodYear || y === selectedYear)) {
        loadGradesForPeriod(y);
      }
    };
    window.addEventListener('sqlGradesUpdated', onSQL as any);
    return () => { mounted = false; window.removeEventListener('sqlGradesUpdated', onSQL as any); };
  }, [isSQLConnected, getGradesByYear, comparisonType, periodYear, selectedYear, sqlGradesByYear]);

  // Sincronizar periodYear con selectedYear cuando cambia el filtro principal
  useEffect(() => {
    if (periodYear !== selectedYear) {
      setPeriodYear(selectedYear);
    }
  }, [selectedYear]); // Solo escuchar cambios en selectedYear

  // Años disponibles (tienen al menos 1 curso y 1 sección) - Optimizado con cache
  const availableYears = useMemo(() => {
    if (typeof window === 'undefined') return [currentYear];
    const years: number[] = [];
    const start = currentYear - 5; // ventana retrospectiva razonable
    for (let y = start; y <= currentYear + 1; y++) {
      try {
        const adminCoursesY = getCachedLocalStorageJson(`smart-student-admin-courses-${y}`, []);
        const adminSectionsY = getCachedLocalStorageJson(`smart-student-admin-sections-${y}`, []);
        const userCoursesY = getCachedLocalStorageJson(`smart-student-courses-${y}`, []);
        const userSectionsY = getCachedLocalStorageJson(`smart-student-sections-${y}`, []);
        const totalCourses = [...adminCoursesY, ...userCoursesY];
        const totalSections = [...adminSectionsY, ...userSectionsY];
        if (totalCourses.length && totalSections.length) {
          years.push(y);
        }
      } catch {}
    }
    if (!years.length) years.push(currentYear);
    return years.sort((a,b)=>a-b);
  }, [currentYear]);

  // 🔧 NUEVO: Años disponibles para el gráfico "Periodo" (solo años anteriores al actual)
  // Basado en años que realmente existen en el sistema (gestión de usuarios)
  const availablePeriodYears = useMemo(() => {
    // Filtrar solo años anteriores al actual que existen en availableYears
    const pastYears = availableYears.filter(y => y < currentYear);
    return pastYears.sort((a, b) => b - a); // Ordenar de más reciente a más antiguo
  }, [availableYears, currentYear]);

  // Asegurar que periodYear esté dentro de los años disponibles para "Periodo"
  useEffect(() => {
    if (availablePeriodYears.length > 0 && !availablePeriodYears.includes(periodYear)) {
      // Seleccionar el año más reciente disponible
      setPeriodYear(availablePeriodYears[0]);
    }
  }, [availablePeriodYears, periodYear]);

  // Eliminada migración automática de datos legacy: solo se usa data real por año

  // Asegurar que selectedYear siempre esté dentro de los disponibles
  useEffect(() => {
    if (!availableYears.includes(selectedYear)) {
      const fallback = availableYears.includes(currentYear) ? currentYear : availableYears[availableYears.length - 1];
      setSelectedYear(fallback);
      try { localStorage.setItem('admin-selected-year', String(fallback)); } catch {}
    }
  }, [availableYears, selectedYear, currentYear]);

  // Cuando cambia el año seleccionado, reiniciar curso/sección si ya no existen en el nuevo año
  // Cuando cambia el año seleccionado, reiniciar curso/sección si ya no existen en el nuevo año - Optimizado
  useEffect(() => {
    try {
      const y = selectedYear;
      const adminKeyCourses = y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses';
      const userKeyCourses = y ? `smart-student-courses-${y}` : 'smart-student-courses';
      const allCourses = [
        ...getCachedLocalStorageJson(adminKeyCourses, []),
        ...getCachedLocalStorageJson(userKeyCourses, [])
      ];
      if (adminCourse !== 'all' && !allCourses.some((c:any)=> String(c.id || c.courseId) === String(adminCourse))) setAdminCourse('all');
      const adminKeySections = y ? `smart-student-admin-sections-${y}` : 'smart-student-admin-sections';
      const userKeySections = y ? `smart-student-sections-${y}` : 'smart-student-sections';
      const allSections = [
        ...getCachedLocalStorageJson(adminKeySections, []),
        ...getCachedLocalStorageJson(userKeySections, [])
      ];
      if (adminSection !== 'all' && !allSections.some((s:any)=> String(s.id || s.sectionId) === String(adminSection))) {
        setAdminSection('all');
        setAdminSectionLetter('');
      }
    } catch {}
  }, [selectedYear]);

  // (Eliminado) Antes se forzaba period='all' para años pasados. Ahora se permite 7d/30d/90d históricos.

  // Cambio directo a un año específico con precarga (usado por storage listener)
  const changeYearTo = useCallback((target: number) => {
    if (!availableYears.includes(target)) return;
    const delta = availableYears.indexOf(target) - availableYears.indexOf(selectedYear);
    if (delta === 0) return;
    changeYear(delta);
  }, [availableYears, selectedYear]);

  // Escuchar cambios del año global desde otras pestañas y aplicar precarga
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'admin-selected-year' && e.newValue) {
        const y = Number(e.newValue);
        if (Number.isFinite(y) && y > 0 && y !== selectedYear) {
          changeYearTo(y);
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [selectedYear, changeYearTo]);

  // Estado para los filtros previos
  const [prevFilters, setPrevFilters] = useState({
    period,
    selectedCourse,
    selectedLevel,
    adminCourse,
    adminSection,
    semester,
    subjectFilter,
    selectedYear
  });

  // Función para actualizar insights con IA
  // Marcar insights como desactualizados cuando cambian los filtros (solo si hay insights previos)
  useEffect(() => {
    const filtersChanged =
      prevFilters.period !== period ||
      prevFilters.selectedCourse !== selectedCourse ||
      prevFilters.selectedLevel !== selectedLevel ||
      prevFilters.adminCourse !== adminCourse ||
      prevFilters.adminSection !== adminSection ||
      prevFilters.semester !== semester ||
      prevFilters.subjectFilter !== subjectFilter ||
      prevFilters.selectedYear !== selectedYear;

    if (aiInsights && aiInsights.length > 0 && filtersChanged) {
      setInsightsSync(false);
    }
    // Actualizar estado de filtros previos
    setPrevFilters({
      period,
      selectedCourse,
      selectedLevel,
      adminCourse,
      adminSection,
      semester,
      subjectFilter,
      selectedYear
    });
  }, [period, selectedCourse, selectedLevel, adminCourse, adminSection, semester, subjectFilter, selectedYear, aiInsights]);

  // Helper para cambiar año y persistir
  const changeYear = (delta: number) => {
    if (yearChanging) return; // evitar múltiples cambios simultáneos
    const current = selectedYear;
    const currentIndex = availableYears.indexOf(current);
    if (currentIndex === -1) return;
    const nextIndex = currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= availableYears.length) return; // fuera de rango
    const next = availableYears[nextIndex];
    if (next === current) return;

    // Iniciar transición con precarga
    setYearChanging(true);
    setPendingYear(next);
    setYearChangeProgress(0);
    // Progreso suave hasta 80% mientras se cargan fuentes
    if (yearChangeIntervalRef.current) { window.clearInterval(yearChangeIntervalRef.current); yearChangeIntervalRef.current = null; }
    yearChangeIntervalRef.current = window.setInterval(() => {
      setYearChangeProgress(prev => Math.min(prev + (3 + Math.random() * 5), 80));
    }, 120);

    // Precarga: SQL (si aplica) + snapshots locales
    const preload = async () => {
      try {
        // 1) Calificaciones SQL para el año objetivo
        if (isSQLConnected && !Array.isArray(sqlGradesByYear?.[next])) {
          try {
            const arr = await getGradesByYear(next);
            setSqlGradesByYear(prev => ({ ...prev, [next]: Array.isArray(arr) ? arr : [] }));
          } catch {}
        }
        setYearChangeProgress(p => Math.max(p, 35));

        // 2) Asistencia SQL para el año objetivo
        if (isAttendanceSQLConnected && !Array.isArray(sqlAttendanceByYear?.[next])) {
          try {
            const arr = await getAttendanceByYear(next);
            setSqlAttendanceByYear(prev => ({ ...prev, [next]: Array.isArray(arr) ? arr : [] }));
          } catch {}
        }
        setYearChangeProgress(p => Math.max(p, 60));

        // 3) Snapshots locales de KPIs/Stats para mostrar algo inmediato si API demora
        try {
          const k = readKPIsSnapshot(next);
          if (k) setFallbackKPIs({ year: next, attendancePct: k.attendancePct, studentsCount: k.studentsCount, approvedCount: k.approvedCount, failedCount: k.failedCount, overallAvgPct: k.overallAvgPct });
        } catch {}
        try {
          const s = readStatsSnapshot(next);
          if (s) setFallbackStats({ year: next, attendanceMonthly: s.attendanceMonthly, sectionAgg: s.sectionAgg });
        } catch {}
        setYearChangeProgress(p => Math.max(p, 75));

        // 3b) Warm-up API: pre-cargar estadísticas del año destino para minimizar uso de snapshots
        try {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), 3000);
          const resp = await fetch(`/api/stats/summary?year=${next}`, { cache: 'no-store', signal: controller.signal });
          window.clearTimeout(timer);
          if (resp.ok) {
            const data = await resp.json();
            // Transformar a formato legacy para fallback inmediato
            const kpis = data?.kpis;
            if (kpis && typeof kpis.year === 'number') {
              setFallbackKPIs({
                year: kpis.year,
                studentsCount: kpis.active_students,
                attendancePct: kpis.attendance_rate,
                approvedCount: Math.floor((kpis.total_grades || 0) * (kpis.average_grade || 0) / 100),
                failedCount: (kpis.total_grades || 0) - Math.floor((kpis.total_grades || 0) * (kpis.average_grade || 0) / 100),
                overallAvgPct: kpis.average_grade
              });
            }
            const attendanceMonthly = Array.isArray(data?.attendanceMonthly) ? data.attendanceMonthly : [];
            const attendanceSection = Array.isArray(data?.attendanceSection) ? data.attendanceSection : [];
            const monthlyLegacy = attendanceMonthly.reduce((acc: Record<string,{present:number;total:number}>, item: any) => {
              const monthKey = `${item.year}-${String(item.month).padStart(2,'0')}`;
              acc[monthKey] = { present: item.present_count || 0, total: item.total_records || 0 };
              return acc;
            }, {});
            const sectionAggLegacy = attendanceSection.map((it: any) => ({
              courseId: it.course_id || null,
              sectionId: it.section_id || null,
              present: it.present_count || 0,
              total: it.total_records || 0
            }));
            if (Object.keys(monthlyLegacy).length > 0 || sectionAggLegacy.length > 0) {
              setFallbackStats({ year: next, attendanceMonthly: monthlyLegacy, sectionAgg: sectionAggLegacy });
            }
            setYearChangeProgress(p => Math.max(p, 90));
          } else {
            setYearChangeProgress(p => Math.max(p, 80));
          }
        } catch {
          // Si falla el warm-up, continuar con snapshots
          setYearChangeProgress(p => Math.max(p, 80));
        }

        // 4) Completar transición
        if (yearChangeIntervalRef.current) { window.clearInterval(yearChangeIntervalRef.current); yearChangeIntervalRef.current = null; }
        // Pequeña espera para suavidad
        await new Promise(r => setTimeout(r, 150));
        setYearChangeProgress(100);
        // Reset filtros dependientes del catálogo anual
        setAdminCourse('all');
        setAdminSection('all');
        setAdminSectionLetter('');
        setSelectedYear(next);
        try { localStorage.setItem('admin-selected-year', String(next)); } catch {}
      } finally {
        // Cerrar transición
        setTimeout(() => {
          setYearChanging(false);
          setPendingYear(null);
          setYearChangeProgress(0);
        }, 250);
      }
    };
    preload();
  };
  
  const router = useRouter();

  // Generar datos demo si el entorno está vacío (solo cliente)
  useEffect(() => {
    // Demo data generation disabled per user request - only show real data
    return;
    
    /*
    if (typeof window === 'undefined') return;
    // Intento gentil: si no existen claves o no hay datos del profesor, generamos
    try {
      const u = user?.username;
      if (!u) return;
      const tasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
      const subs = JSON.parse(localStorage.getItem('smart-student-submissions') || '[]');
      const att = JSON.parse(localStorage.getItem('smart-student-attendance') || '[]');
      const hasData =
        tasks.some((t: any) => t.teacherUsername === u) ||
        subs.some((s: any) => s.teacherUsername === u || s.taskTeacherUsername === u) ||
        att.some((a: any) => a.teacherUsername === u);
      if (!hasData) {
        ensureDemoTeacherData(u);
      }
    } catch {}
    */
  }, [user?.username]);

  const stats = useTeacherStats(
    user?.username,
    period,
    {
  courseSectionId: selectedCourse !== 'all' ? selectedCourse : undefined,
  level: debouncedSelectedLevel !== 'all' ? debouncedSelectedLevel : undefined,
  // Filtros admin
  courseId: debouncedAdminCourse !== 'all' ? debouncedAdminCourse : undefined,
  sectionId: debouncedAdminSection !== 'all' ? debouncedAdminSection : undefined,
  semester: debouncedSemester !== 'all' ? debouncedSemester : undefined,
  subject: debouncedSubjectFilter !== 'all' ? debouncedSubjectFilter : undefined,
  // Optimización: solo procesar datos necesarios según gráficos activos
  skipAttendanceProcessing: !showAttendanceChart,
  skipComparisonProcessing: !showComparisonChart,
    },
    selectedYear,
    preloadStats
  );

  const t = (key: string, fallback?: string) => {
    const v = translate(key);
    return v === key ? (fallback ?? key) : v;
  };

  const attendanceRate = stats.attendance.total > 0
    ? Math.round((stats.attendance.present / stats.attendance.total) * 100)
    : 0;

  // Cursos/secciones reales del profesor (para filtros)
  const teacherCourses = useMemo(() => {
    try {
      const teacherAssignments = JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]');
      const sections = [...JSON.parse(localStorage.getItem('smart-student-admin-sections') || '[]'), ...JSON.parse(localStorage.getItem('smart-student-sections') || '[]')];
      const courses = [...JSON.parse(localStorage.getItem('smart-student-admin-courses') || '[]'), ...JSON.parse(localStorage.getItem('smart-student-courses') || '[]')];
      const my = teacherAssignments.filter((ta: any) => ta.teacherId === user?.id || ta.teacherUsername === user?.username || ta.teacher === user?.username);
      const normalize = (ta: any) => {
        const sectionId = ta.sectionId || ta.section || ta.sectionUUID || ta.section_id || ta.sectionID;
        let courseId = ta.courseId || ta.course || ta.courseUUID || ta.course_id || ta.courseID;
        if (!courseId && sectionId) {
          const sec = sections.find((s: any) => s && (s.id === sectionId || s.sectionId === sectionId));
          courseId = sec?.courseId || (sec?.course && (sec.course.id || sec.courseId)) || courseId;
        }
        return { sectionId, courseId };
      };
      const getLabel = (courseId?: string, sectionId?: string) => {
        const c = courses.find((x: any) => x && (x.id === courseId));
        const s = sections.find((x: any) => x && (x.id === sectionId || x.sectionId === sectionId));
  const courseName = c?.fullName || c?.displayName || c?.longName || c?.label || c?.gradeName || c?.name || t('course','Curso');
        const sectionName = s?.fullName || s?.displayName || s?.longName || s?.label || s?.name || '';
        return `${courseName} ${sectionName}`.trim();
      };
      const list = my.map((ta: any) => {
        const { sectionId, courseId } = normalize(ta);
        if (!sectionId) return null;
        const id = `${courseId || 'unknown-course'}-${sectionId}`;
        const label = getLabel(courseId, sectionId);
        const level = courses.find((c: any) => c.id === courseId)?.level as Level | undefined;
        return { id, courseId: courseId || 'unknown-course', sectionId, label, level };
      }).filter(Boolean) as Array<{ id: string; courseId: string; sectionId: string; label: string; level?: Level }>;
      const seen = new Set<string>();
      return list.filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
    } catch { return [] as Array<{ id: string; courseId: string; sectionId: string; label: string; level?: Level }>; }
  }, [user?.id, user?.username]);

  // Datos para filtros admin (listado de cursos y secciones)
  const adminCourses = useMemo(() => {
    try {
      const y = selectedYear;
      const adminKey = y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses';
      const userKey = y ? `smart-student-courses-${y}` : 'smart-student-courses';
      const courses = [
        ...JSON.parse(localStorage.getItem(adminKey) || '[]'),
        ...JSON.parse(localStorage.getItem(userKey) || '[]')
      ];
      
      return courses
        .filter((c: any) => c && (c.id || c.courseId) && (c.name || c.label || c.fullName || c.displayName))
        .map((c: any) => ({
          id: String(c.id || c.courseId),
          label: c.fullName || c.displayName || c.longName || c.label || c.gradeName || c.name || String(c.id || c.courseId)
        }));
    } catch { return [] as Array<{ id: string; label: string }>; }
  }, [selectedYear]);
  const adminSections = useMemo(() => {
    try {
      const y = selectedYear;
      const adminKey = y ? `smart-student-admin-sections-${y}` : 'smart-student-admin-sections';
      const userKey = y ? `smart-student-sections-${y}` : 'smart-student-sections';
      const sections = [
        ...JSON.parse(localStorage.getItem(adminKey) || '[]'),
        ...JSON.parse(localStorage.getItem(userKey) || '[]')
      ];
      
      // 🔧 CORRECCIÓN: Guardar sección completa con todos sus campos para identificar correctamente
      const processed = sections
        .filter((s: any) => s && (s.id || s.sectionId))
        .map((s: any) => {
          // Extraer la letra de sección (A, B, etc.) del nombre
          const sectionName = s.name || s.label || '';
          const sectionLetter = sectionName.length === 1 && /^[a-z]$/i.test(sectionName) 
            ? sectionName.toLowerCase() 
            : (sectionName.match(/\b([A-Z])\b/i)?.[1]?.toLowerCase() || '');
          
          return {
            id: String(s.id || s.sectionId),
            label: s.fullName || s.displayName || s.longName || s.label || s.name || String(s.id || s.sectionId),
            // 🔧 NUEVO: Guardar la letra de sección para filtrado alternativo
            sectionLetter,
            courseId: s.courseId,
            rawSection: s
          };
        });
      
      // 🔧 DEBUG: Detectar y reportar IDs duplicados
      const idCounts = new Map<string, number>();
      processed.forEach(s => idCounts.set(s.id, (idCounts.get(s.id) || 0) + 1));
      const duplicates = Array.from(idCounts.entries()).filter(([_, count]) => count > 1);
      if (duplicates.length > 0) {
        console.warn('⚠️ [adminSections] IDs de sección duplicados detectados:', duplicates);
        console.warn('⚠️ Secciones afectadas:', processed.filter(s => duplicates.some(([id]) => id === s.id)));
      }
      
      return processed;
    } catch { return [] as Array<{ id: string; label: string; sectionLetter: string; courseId?: string; rawSection?: any }>; }
  }, [selectedYear]);

  const availableLevels = useMemo(() => {
    const lv = new Set<Level>();
    teacherCourses.forEach(tc => { if (tc.level === 'basica' || tc.level === 'media') lv.add(tc.level); });
    return Array.from(lv);
  }, [teacherCourses]);

  // Helper: verificar si hay filtros activos
  const hasActiveFilters = useMemo(() => {
    return (
      semester !== 'all' ||
      selectedLevel !== 'all' ||
      adminCourse !== 'all' ||
      adminSection !== 'all' ||
      subjectFilter !== 'all'
      // Ojo: period intencionalmente excluido para no bloquear asistencia cuando solo se filtra por 7d/30d/90d
    );
  }, [semester, selectedLevel, adminCourse, adminSection, subjectFilter]);

  // Filtros que SÍ deben bloquear el gráfico de asistencia (excluye semestre y periodo)
  const attendanceBlockingFilters = useMemo(() => {
    // Ahora el nivel NO bloquea el gráfico; solo curso, sección o asignatura específica.
    return (
      adminCourse !== 'all' ||
      adminSection !== 'all' ||
      subjectFilter !== 'all'
    );
  }, [adminCourse, adminSection, subjectFilter]);

  // Nuevo: detectar si el ÚNICO filtro activo es el semestre (requerimiento: mostrar métricas variando por semestre)
  const onlySemesterFilterActive = useMemo(() => {
    return (
      semester !== 'all' &&
      selectedLevel === 'all' &&
      adminCourse === 'all' &&
      adminSection === 'all' &&
      subjectFilter === 'all' &&
      period === 'all'
    );
  }, [semester, selectedLevel, adminCourse, adminSection, subjectFilter, period]);

  // Filtros permitidos para mostrar KPIs (ninguno, semestre, nivel, curso, sección o cualquier combinación de estos).
  // NOTA: Ahora permitimos TODOS estos filtros combinados, el único filtro que bloquea es subjectFilter (asignatura)
  const kpiAllowedFiltersOnly = useMemo(() => {
    const periodAllowed = (period === 'all') || (selectedYear === 2025 && ['7d','30d','90d'].includes(period as any));
    // Permitir filtros de semestre, nivel, curso y sección - solo bloquear si hay filtro de asignatura
    return (
      subjectFilter === 'all' &&
      periodAllowed
    );
  }, [subjectFilter, period, selectedYear]);

  // Agregados por estudiante según filtros (para KPIs solicitados)
  // Ahora obtiene calificaciones desde SQL (IndexedDB/Supabase) y NO desde LocalStorage (fallback solo si no hay datos SQL)
  const studentAgg = useMemo(() => {
    try {
  // ELIMINADO: Ya no bloqueamos por hasActiveFilters - ahora permitimos todos los filtros de semestre/nivel/curso/sección
  // Solo bloqueamos si hay filtro de asignatura (subjectFilter !== 'all')
  if (subjectFilter !== 'all') {
        return {
          overallAvgPct: undefined,
          approvedCount: 0,
          failedCount: 0,
          standoutAvgPct: undefined,
          totalStudents: 0,
          standoutCount: 0,
          standoutIsFallbackTop: false,
          hasFilters: true
        };
      }

      // Fuente de datos: SQL primero (IndexedDB/Supabase), fallback a LocalStorage si no hay datos
      // MEJORA: Siempre intentar localStorage si SQL no tiene datos suficientes
      let sourceGrades: any[] = [];
      
      // 1. Intentar SQL primero
      if (isSQLConnected && Array.isArray(sqlGradesByYear?.[selectedYear]) && sqlGradesByYear[selectedYear].length > 0) {
        sourceGrades = sqlGradesByYear[selectedYear];
      }
      
      // 2. Si SQL no tiene datos, usar localStorage
      if (sourceGrades.length === 0) {
        try {
          const lsGrades = LocalStorageManager.getTestGradesForYear(selectedYear) || [];
          if (Array.isArray(lsGrades) && lsGrades.length > 0) {
            sourceGrades = lsGrades;
          }
        } catch {}
      }
      
      // 3. Fallback adicional: buscar en claves alternativas de localStorage
      if (sourceGrades.length === 0) {
        try {
          const keys = [`smart-student-grades-${selectedYear}`, `smart-student-test-grades-${selectedYear}`, 'smart-student-grades', 'smart-student-test-grades'];
          for (const key of keys) {
            try {
              const raw = localStorage.getItem(key);
              if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  // Filtrar por año si es necesario
                  const filtered = parsed.filter((g: any) => {
                    const ts = g.gradedAt || g.graded_at || g.createdAt || g.created_at;
                    if (!ts) return true;
                    const date = typeof ts === 'number' ? new Date(ts) : new Date(ts);
                    return date.getFullYear() === selectedYear;
                  });
                  if (filtered.length > 0) {
                    sourceGrades = filtered;
                    break;
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }

      // Si no hay calificaciones en ninguna fuente, devolver métricas vacías
      if (!sourceGrades || sourceGrades.length === 0) {
        return {
          overallAvgPct: undefined,
          approvedCount: 0,
          failedCount: 0,
          standoutAvgPct: undefined,
          totalStudents: 0,
          standoutCount: 0,
          standoutIsFallbackTop: false,
          hasFilters: false
        };
      }

  // Filtrado por semestre (si está activo) - AHORA SIEMPRE se aplica cuando hay filtro de semestre
      let filteredGrades = sourceGrades as any[];
  if (semester !== 'all') {
        try {
          const year = selectedYear;
          // Usar utilidad robusta ya definida para obtener rango de semestre
          const { start: fromTs, end: toTs } = __getSemesterRange(year, semester);
          if (fromTs && toTs) {
            filteredGrades = filteredGrades.filter(g => {
              const rawTs = g.gradedAt || g.graded_at;
              const ts = typeof rawTs === 'number' ? rawTs : (rawTs ? Date.parse(rawTs) : undefined);
              if (!ts) return true;
              return ts >= fromTs! && ts <= toTs!;
            });
          }
        } catch {}
      }

      // Filtrado por nivel (si está activo) - usa mapa consistente de cursos del sistema
      if (selectedLevel !== 'all') {
        try {
          const y = selectedYear;
          const adminKey = y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses';
          const userKey = y ? `smart-student-courses-${y}` : 'smart-student-courses';
          const storedCourses = [
            ...JSON.parse(localStorage.getItem(adminKey) || '[]'),
            ...JSON.parse(localStorage.getItem(userKey) || '[]'),
            // Fallback a cursos globales para asegurar mapeo
            ...JSON.parse(localStorage.getItem('smart-student-admin-courses') || '[]'),
            ...JSON.parse(localStorage.getItem('smart-student-courses') || '[]')
          ];

          // Misma lógica que en otros lugares: inferir nivel desde nombre de curso
          const inferLevelFromCourseName = (name: string): 'basica' | 'media' | undefined => {
            if (!name) return undefined;
            const n = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            
            // Básica patterns
            if (/\b(1|2|3|4|5|6|7|8)(ro|do|er|to|vo|mo)?\s*(basico|b\u00e1sico|bas)\b/.test(n)) return 'basica';
            if (/basico|b\u00e1sico/.test(n)) return 'basica';
            if (/\b(1|2|3|4|5|6|7|8)b\b/.test(n)) return 'basica'; // 1b, 2b...
            if (/\bnb(1|2|3|4|5|6|7|8)\b/.test(n)) return 'basica'; // nb1...

            // Media patterns
            if (/\b(1|2|3|4)(ro|do|er|to)?\s*(medio|med)\b/.test(n)) return 'media';
            if (/medio|media|secundaria/.test(n)) return 'media';
            if (/\b(1|2|3|4)m\b/.test(n)) return 'media'; // 1m, 2m...
            if (/\b(i|ii|iii|iv)\s*(medio|med|m)\b/.test(n)) return 'media'; // i medio, ii m...
            if (/\bnm(1|2|3|4)\b/.test(n)) return 'media'; // nm1...
            
            return undefined;
          };

          // Construir mapa courseId -> nivel usando cursos del sistema (adminCourses + stored)
          const courseIdToLevel = new Map<string, 'basica' | 'media'>();

          const pushCourse = (c: any) => {
            if (!c) return;
            const id = String(c.id || c.courseId || c.course_id || c.value || '');
            if (!id) return;
            const name = c.fullName || c.displayName || c.longName || c.label || c.gradeName || c.name || '';
            
            let level: 'basica' | 'media' | undefined = undefined;
            
            // 1. Try explicit level property (normalized)
            if (c.level) {
                const l = String(c.level).toLowerCase().trim();
                if (l === 'basica' || l === 'media') level = l;
                else if (l === 'basic') level = 'basica';
                else if (l === 'high' || l === 'secondary') level = 'media';
            }
            
            // 2. Infer from name if not found
            if (!level) {
                level = inferLevelFromCourseName(name);
            }
            
            if (level) courseIdToLevel.set(id, level);
          };

          storedCourses.forEach(pushCourse);
          if (Array.isArray(adminCourses)) (adminCourses as any[]).forEach(pushCourse);

          // Si no pudimos determinar ningún curso con nivel, no filtramos por nivel
          if (courseIdToLevel.size === 0) {
            console.warn('[AdminKPIs] Nivel seleccionado pero sin cursos mapeados a nivel; se omite filtro de nivel');
          } else {
            // Aplicar filtro de nivel sobre las calificaciones usando courseId / course_id
            filteredGrades = filteredGrades.filter(g => {
              const gCourseId = String(g.courseId || g.course_id || '');
              
              // 1. Intentar obtener nivel del mapa de cursos
              if (gCourseId) {
                  const lvl = courseIdToLevel.get(gCourseId);
                  if (lvl) return lvl === selectedLevel;

                  // 1.5 Si no está en el mapa, intentar inferir del ID del curso (si es un nombre como "1ro Medio")
                  // Esto corrige casos donde el curso no existe en la lista de cursos pero sí en las calificaciones (Carga Masiva)
                  const inferred = inferLevelFromCourseName(gCourseId);
                  if (inferred) return inferred === selectedLevel;
              }
              
              // 2. Fallback: Inferir desde studentId (patrón común: 1..., 8..., I..., 1M...)
              // Esto es necesario si el curso no está en el mapa o el ID no coincide
              const sid = String(g.studentId || g.student_id || g.studentUsername || '').toUpperCase();
              if (sid) {
                  // Patrones Media: empieza con I, 9, o tiene M (1M, 2M)
                  // Nota: 'I' captura I Medio, II Medio, etc.
                  if (sid.startsWith('I') || sid.startsWith('9') || (sid.includes('M') && /^[1-4]/.test(sid))) {
                      return selectedLevel === 'media';
                  }
                  // Patrones Básica: empieza con 1-8
                  if (/^[1-8]/.test(sid)) {
                      return selectedLevel === 'basica';
                  }
              }

              // 3. Si no se puede determinar, excluir (estricto) para evitar contaminación de datos
              return false;
            });
          }
        } catch (e) {
          console.error('[AdminKPIs] Error en filtro por nivel', e);
        }
      }

      // Filtrado por curso (incluye todas sus secciones)
      if (adminCourse !== 'all') {
        try {
          const readJson = (key: string) => {
            try {
              const raw = key ? localStorage.getItem(key) : null;
              const parsed = raw ? JSON.parse(raw) : [];
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          };

          const year = selectedYear;
          const courseKeys = [
            year ? `smart-student-admin-courses-${year}` : 'smart-student-admin-courses',
            year ? `smart-student-courses-${year}` : 'smart-student-courses',
            'smart-student-admin-courses',
            'smart-student-courses'
          ];
          const sectionKeys = [
            year ? `smart-student-admin-sections-${year}` : 'smart-student-admin-sections',
            year ? `smart-student-sections-${year}` : 'smart-student-sections',
            'smart-student-admin-sections',
            'smart-student-sections'
          ];

          const allCourses = courseKeys.flatMap(readJson);
          const allSections = sectionKeys.flatMap(readJson);
          const selectedCourseId = String(adminCourse);
          const normalizeId = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
          const selectedCourseNorm = normalizeId(selectedCourseId);
          const courseMatches = (value?: string) => {
            if (!value) return false;
            const norm = normalizeId(value);
            return value === selectedCourseId || norm === selectedCourseNorm;
          };
          
          // Buscar el objeto del curso seleccionado para obtener su label
          const selectedCourseObj = allCourses.find((c: any) => {
            const cid = String(c?.id || c?.courseId || c?.course_id || '');
            return cid === selectedCourseId || normalizeId(cid) === selectedCourseNorm;
          });
          const selectedCourseLabel = selectedCourseObj?.fullName || selectedCourseObj?.displayName || selectedCourseObj?.longName || selectedCourseObj?.label || selectedCourseObj?.gradeName || selectedCourseObj?.name || '';
          
          const courseIdToLabel = new Map<string, string>();
          allCourses.forEach((c: any) => {
            const cid = String(c?.id || c?.courseId || c?.course_id || '');
            const label = c?.fullName || c?.displayName || c?.longName || c?.label || c?.gradeName || c?.name || '';
            if (cid) courseIdToLabel.set(cid, label);
          });

          const sectionIdsForCourse = new Set<string>();
          allSections.forEach((s: any) => {
            const cid = String(s?.courseId || s?.course?.id || s?.course_id || '');
            const sid = String(s?.id || s?.sectionId || s?.section_id || '');
            if (cid && sid && courseMatches(cid)) {
              sectionIdsForCourse.add(sid);
            }
          });

          // Función para extraer el "grado key" (ej: "1basica", "2media") de un nombre de curso o studentId
          const extractGradeKey = (value?: string) => {
            if (!value) return '';
            const norm = value.toLowerCase().normalize('NFD').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            if (!norm) return '';
            const romanMap: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };
            // Buscar números al inicio o en cualquier parte (ej: "1ro", "1ro basico", "1 basico")
            const numberMatch = norm.match(/(\d{1,2})/);
            const romanMatch = norm.match(/\b(i{1,3}|iv)\b/);
            const gradeNumber = numberMatch ? parseInt(numberMatch[1], 10) : (romanMatch ? romanMap[romanMatch[1]] : undefined);
            let level: 'basica' | 'media' | '' = '';
            if (/basica|basico|basic|prim|bsico/.test(norm)) level = 'basica';
            else if (/media|medio|secundaria|high/.test(norm)) level = 'media';
            else if (typeof gradeNumber === 'number') level = gradeNumber <= 8 ? 'basica' : 'media';
            const keyNumber = gradeNumber ? String(gradeNumber) : '';
            return `${keyNumber}${level}`;
          };

          // Función para extraer grade key desde studentId (ej: "1A-001" -> "1basica", "1M-001" -> "1media")
          const extractGradeKeyFromStudentId = (studentId?: string): string => {
            if (!studentId) return '';
            const sid = studentId.toUpperCase().trim();
            
            // SAFETY: Si el ID parece un RUT o ID numérico largo (>4 dígitos consecutivos), ignorar inferencia
            // Esto evita que RUTs como "10.xxx.xxx" se interpreten como "2do Medio" (10 > 8)
            const numericPart = sid.replace(/[^0-9]/g, '');
            if (numericPart.length >= 5) return '';

            // Patrones comunes: "1A-001", "2B-003", "1M-001", "2M-002", etc.
            // También: "1ro-A-001", "2do-B-003"
            const match = sid.match(/^(\d{1,2})/);
            if (!match) return '';
            const gradeNum = parseInt(match[1], 10);
            // Detectar si es Media por el sufijo M o número > 8
            const isMedia = /^\d{1,2}M/.test(sid) || gradeNum > 8 || /^I{1,3}|^IV/.test(sid);
            const level = isMedia ? 'media' : 'basica';
            const effectiveGrade = isMedia && gradeNum > 4 ? gradeNum - 8 : gradeNum; // 9 -> 1 medio, etc.
            return `${effectiveGrade}${level}`;
          };

          const selectedGradeKey = extractGradeKey(selectedCourseLabel);
          
          // Debug logging
          if (typeof window !== 'undefined') {
          }

          filteredGrades = filteredGrades.filter(g => {
            const gCourseIdRaw = String(g.courseId || g.course_id || '').trim();
            if (gCourseIdRaw && courseMatches(gCourseIdRaw)) {
              return true;
            }

            const gSectionId = String(g.sectionId || g.section_id || '').trim();
            if (gSectionId && sectionIdsForCourse.has(gSectionId)) {
              return true;
            }

            const csRaw = String((g as any).courseSectionId || '').trim();
            if (csRaw && csRaw.includes('-')) {
              const parts = csRaw.split('-');
              const csCourse = normalizeId(parts.slice(0, -1).join('-'));
              const csSection = parts.at(-1)?.trim();
              if (csCourse && csCourse === selectedCourseNorm) return true;
              if (csSection && sectionIdsForCourse.has(csSection)) return true;
            }

            // Intentar match por nombre del curso en el registro (campo 'course' o 'courseName')
            // Los registros SQL tienen: course: '1ro Básico', courseId: '1ro_bsico'
            const courseNameField = g.course || g.courseName || g.curso || g.course_label || '';
            if (selectedGradeKey && courseNameField) {
              const courseGradeKey = extractGradeKey(String(courseNameField));
              if (courseGradeKey && courseGradeKey === selectedGradeKey) {
                return true;
              }
            }
            
            // También intentar con el courseId como nombre (ej: '1ro_bsico' -> '1basica')
            if (selectedGradeKey && gCourseIdRaw) {
              const courseIdGradeKey = extractGradeKey(gCourseIdRaw);
              if (courseIdGradeKey && courseIdGradeKey === selectedGradeKey) {
                return true;
              }
            }

            // Último recurso: inferir curso desde studentId (patrón "1A-001" = 1ro Básico)
            const studentId = String(g.studentId || g.student_id || g.studentUsername || '');
            if (selectedGradeKey && studentId) {
              const studentGradeKey = extractGradeKeyFromStudentId(studentId);
              if (studentGradeKey && studentGradeKey === selectedGradeKey) {
                return true;
              }
            }

            return false;
          });
          
          if (typeof window !== 'undefined') {
          }

          if (adminSection !== 'all') {
            // Obtener información de la sección seleccionada
            const selectedSectionId = String(adminSection);
            // Buscar primero en allSections, luego en el catálogo de filtros
            let selectedSectionObj = allSections.find((s: any) => {
              const sid = String(s?.id || s?.sectionId || s?.section_id || '');
              return sid === selectedSectionId;
            });
            // Obtener nombre/letra de la sección (ej: "A", "B", "1ro Básico A")
            const selectedSectionName = selectedSectionObj?.name || selectedSectionObj?.label || selectedSectionObj?.sectionName || selectedSectionObj?.shortName || '';
            // Extraer solo la letra de la sección si es un nombre compuesto
            const selectedSectionLetter = selectedSectionName.length === 1 
              ? selectedSectionName.toUpperCase() 
              : (selectedSectionName.match(/[A-Z]$/i)?.[0]?.toUpperCase() || selectedSectionName.toUpperCase());
            
            if (typeof window !== 'undefined') {
            }
            
            // 🔥 DEBUG: Log adicional para ver por qué no matchea
            let debugCount = 0;
            
            filteredGrades = filteredGrades.filter(g => {
              const gSectionId = String(g.sectionId || g.section_id || '').trim();
              // Match directo por ID
              if (gSectionId === selectedSectionId) return true;
              
              // Match por nombre de sección (campo 'section' en registros SQL)
              const gSectionName = String(g.section || g.sectionName || g.seccion || '').trim().toUpperCase();

              // NUEVO: Verificar si el sectionId coincide con la letra (ej: sectionId="A")
              // Esto maneja casos donde el ID en el registro es la letra misma, pero el selector usa UUID
              if (selectedSectionLetter && gSectionId.toUpperCase() === selectedSectionLetter.toUpperCase()) return true;
              
              // NUEVO: Verificar si el sectionId termina en la letra (ej: "1ro_basico_A")
              // Evitar UUIDs (longitud 36) que casualmente terminen en la letra
              if (selectedSectionLetter && gSectionId.length < 30) {
                 const upperId = gSectionId.toUpperCase();
                 if (upperId.endsWith(`_${selectedSectionLetter}`)) return true;
                 if (upperId.endsWith(`-${selectedSectionLetter}`)) return true;
                 // Caso especial: ID es "1A" o "1B"
                 if (upperId.match(new RegExp(`^\\d+${selectedSectionLetter}$`))) return true;
              }
              if (gSectionName && selectedSectionLetter) {
                // Si es solo una letra, comparar directamente
                if (gSectionName.length === 1 && gSectionName === selectedSectionLetter) return true;
                // Si termina con la letra de sección
                if (gSectionName.endsWith(selectedSectionLetter)) return true;
                // Si contiene el nombre completo de la sección
                if (selectedSectionName && gSectionName.includes(selectedSectionName.toUpperCase())) return true;
              }
              
              // Intentar extraer sección desde el ID del registro (patrón: ...-a-..., ...-b-...)
              const recordId = String(g.id || '').toLowerCase();
              if (recordId && selectedSectionLetter) {
                // Buscar patrón -a-, -b-, etc. en el ID
                const sectionPattern = new RegExp(`-${selectedSectionLetter.toLowerCase()}-`);
                if (sectionPattern.test(recordId)) return true;
                // También buscar al final del courseId: "1ro_basico_a" o similar
                const courseIdRaw = String(g.courseId || g.course_id || '').toLowerCase();
                if (courseIdRaw.endsWith(`_${selectedSectionLetter.toLowerCase()}`)) return true;
                if (courseIdRaw.endsWith(`-${selectedSectionLetter.toLowerCase()}`)) return true;
              }
              
              // Intentar extraer desde studentId (patrón: "1A-001" donde A es la sección)
              const studentId = String(g.studentId || g.student_id || '').toUpperCase();
              if (studentId && selectedSectionLetter) {
                // Patrón común: "1A-001", "2B-003" donde la letra después del número es la sección
                const studentMatch = studentId.match(/^\d+([A-Z])/);
                if (studentMatch && studentMatch[1] === selectedSectionLetter.toUpperCase()) return true;
              }
              
              // 🔥 DEBUG: Log por qué NO matcheó
              if (debugCount < 3 && typeof window !== 'undefined') {
                debugCount++;
              }
              
              return false;
            });
            
            if (typeof window !== 'undefined') {
            }
          }
        } catch (err) {
          console.error('[studentAgg] Error aplicando filtro de curso', err);
          filteredGrades = filteredGrades.filter(g => String(g.courseId || g.course_id || '') === String(adminCourse));
          if (adminSection !== 'all') {
            // Fallback: filtro simple por sectionId o campo section
            const selectedSectionId = String(adminSection);
            filteredGrades = filteredGrades.filter(g => {
              const gSectionId = String(g.sectionId || g.section_id || '').trim();
              const gSection = String(g.section || '').trim().toUpperCase();
              return gSectionId === selectedSectionId || gSection === selectedSectionId.toUpperCase();
            });
          }
        }
      } else if (adminSection !== 'all') {
        // Solo filtro por sección (sin curso)
        // Obtener información de secciones - Optimizado con cache
        try {
          const readJson = (k: string): any[] => {
            const data = getCachedLocalStorageJson(k, []);
            return Array.isArray(data) ? data : (typeof data === 'object' && data !== null ? [data] : []);
          };
          const year = selectedYear;
          const sectionKeys = [
            year ? `smart-student-admin-sections-${year}` : 'smart-student-admin-sections',
            'smart-student-admin-sections'
          ];
          const allSections = sectionKeys.flatMap(readJson);
          const selectedSectionId = String(adminSection);
          const selectedSectionObj = allSections.find((s: any) => {
            const sid = String(s?.id || s?.sectionId || s?.section_id || '');
            return sid === selectedSectionId;
          });
          const selectedSectionName = selectedSectionObj?.name || selectedSectionObj?.label || selectedSectionObj?.sectionName || '';
          const selectedSectionLetter = selectedSectionName.length === 1 
            ? selectedSectionName.toUpperCase() 
            : (selectedSectionName.match(/[A-Z]$/i)?.[0]?.toUpperCase() || selectedSectionName.toUpperCase());
          
          filteredGrades = filteredGrades.filter(g => {
            const gSectionId = String(g.sectionId || g.section_id || '').trim();
            if (gSectionId === selectedSectionId) return true;
            
            const gSectionName = String(g.section || g.sectionName || g.seccion || '').trim().toUpperCase();

            // NUEVO: Verificar si el sectionId coincide con la letra (ej: sectionId="A")
            if (selectedSectionLetter && gSectionId.toUpperCase() === selectedSectionLetter) return true;
            
            // NUEVO: Verificar si el sectionId termina en la letra (ej: "1ro_basico_A")
            if (selectedSectionLetter && gSectionId.length < 30) {
               const upperId = gSectionId.toUpperCase();
               if (upperId.endsWith(`_${selectedSectionLetter}`)) return true;
               if (upperId.endsWith(`-${selectedSectionLetter}`)) return true;
               if (upperId.match(new RegExp(`^\\d+${selectedSectionLetter}$`))) return true;
            }

            if (gSectionName && selectedSectionLetter) {
              if (gSectionName.length === 1 && gSectionName === selectedSectionLetter) return true;
              if (gSectionName.endsWith(selectedSectionLetter)) return true;
            }
            
            // Intentar extraer sección desde el ID del registro
            const recordId = String(g.id || '').toLowerCase();
            if (recordId && selectedSectionLetter) {
              const sectionPattern = new RegExp(`-${selectedSectionLetter.toLowerCase()}-`);
              if (sectionPattern.test(recordId)) return true;
            }
            
            // Intentar extraer desde studentId
            const studentId = String(g.studentId || g.student_id || '').toUpperCase();
            if (studentId && selectedSectionLetter) {
              const studentMatch = studentId.match(/^\d+([A-Z])/);
              if (studentMatch && studentMatch[1] === selectedSectionLetter) return true;
            }
            
            return false;
          });
        } catch (err) {
          // Fallback simple
          filteredGrades = filteredGrades.filter(g => String(g.sectionId || g.section_id || '') === String(adminSection));
        }
      }

      // Filtrado por periodo (solo año 2025 y periodos permitidos 7d/30d/90d)
      if (selectedYear === 2025 && period !== 'all' && ['7d','30d','90d'].includes(period as any)) {
        try {
          const now = Date.now();
          const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
          const days = daysMap[period] || 0;
          const fromTs = now - days * 24 * 60 * 60 * 1000;
          filteredGrades = filteredGrades.filter(g => {
            const rawTs = g.gradedAt || g.graded_at;
            const ts = typeof rawTs === 'number' ? rawTs : (rawTs ? Date.parse(rawTs) : undefined);
            if (!ts) return false; // si no hay fecha, excluir para precisión temporal
            return ts >= fromTs && ts <= now;
          });
        } catch {}
      }

      // Agrupar calificaciones por estudiante
      const byStudent: Record<string, { sum: number; n: number }> = {};
      filteredGrades.forEach((grade: any) => {
        const studentKey = String(grade.studentId || grade.student_id || grade.studentUsername || '');
        // En SQL score ya viene 0-100; en legacy también usamos 0-100
        const score = typeof grade.score === 'number' ? grade.score : undefined;
        
        if (!studentKey || typeof score !== 'number' || !isFinite(score)) return;
        
        if (!byStudent[studentKey]) byStudent[studentKey] = { sum: 0, n: 0 };
        byStudent[studentKey].sum += score;
        byStudent[studentKey].n += 1;
      });

      // Calcular promedios finales por estudiante
      const finalAvgs = Object.values(byStudent).map(x => x.sum / x.n).filter(v => typeof v === 'number' && isFinite(v)) as number[];
      const overallAvgPct = finalAvgs.length ? (finalAvgs.reduce((a,b)=>a+b,0) / finalAvgs.length) : undefined;
      const approvedCount = finalAvgs.filter(v => isApprovedByPercent(v)).length;
      const failedCount = finalAvgs.filter(v => !isApprovedByPercent(v)).length;
      const standout = finalAvgs.filter(v => v >= 90);
      let standoutAvgPct: number | undefined = undefined;
      let standoutIsFallbackTop = false;
      if (standout.length) {
        standoutAvgPct = standout.reduce((a,b)=>a+b,0) / standout.length;
      } else if (finalAvgs.length) {
        // Fallback: si no hay destacados ≥90%, mostrar el mejor promedio disponible
        standoutAvgPct = Math.max(...finalAvgs);
        standoutIsFallbackTop = true;
      }

      return { 
        overallAvgPct, 
        approvedCount, 
        failedCount, 
        standoutAvgPct, 
        totalStudents: finalAvgs.length, 
        standoutCount: standout.length,
        standoutIsFallbackTop,
  hasFilters: hasActiveFilters && !kpiAllowedFiltersOnly 
      } as {
        overallAvgPct?: number; 
        approvedCount: number; 
        failedCount: number; 
        standoutAvgPct?: number; 
        totalStudents: number; 
        standoutCount: number; 
        standoutIsFallbackTop?: boolean;
        hasFilters: boolean;
      };
    } catch {
      return { 
        overallAvgPct: undefined, 
        approvedCount: 0, 
        failedCount: 0, 
        standoutAvgPct: undefined, 
        totalStudents: 0, 
        standoutCount: 0,
        standoutIsFallbackTop: false,
    hasFilters: hasActiveFilters && !kpiAllowedFiltersOnly 
      } as {
        overallAvgPct?: number; 
        approvedCount: number; 
        failedCount: number; 
        standoutAvgPct?: number; 
        totalStudents: number; 
        standoutCount: number; 
        standoutIsFallbackTop?: boolean;
        hasFilters: boolean;
      };
    }
  }, [hasActiveFilters, kpiAllowedFiltersOnly, semester, selectedLevel, adminCourse, adminSection, period, selectedYear, user?.role, isSQLConnected, sqlGradesByYear, adminCourses, subjectFilter]);

  // KPIs dinámicos para profesor según filtros activos
  const dynamicKPIsRaw = useAdminKPIs({
    level: selectedLevel !== 'all' ? selectedLevel : undefined,
    courseId: adminCourse !== 'all' ? adminCourse : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(0,-1).join('-') : undefined),
    sectionId: adminSection !== 'all' ? adminSection : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(-1)[0] : undefined),
    semester: semester !== 'all' ? semester : undefined,
    year: selectedYear,
    period: period,
  });
  
  // 🔧 CORREGIDO: NO preservar último valor - si no hay datos, mostrar 0%
  // El usuario quiere ver 0% cuando no hay datos para los filtros seleccionados

  // 🚀 OPTIMIZACIÓN: Usar KPIs cacheados cuando están disponibles para mejorar rendimiento
  // Pero SIEMPRE mostrar datos de dynamicKPIsRaw si los tiene, ya que son los más actualizados
  const hasSpecificFilters = selectedLevel !== 'all' || adminCourse !== 'all' || adminSection !== 'all' || semester !== 'all' || period !== 'all';
  
  const dynamicKPIs = useMemo(() => {
    // 🔥 IMPORTANTE: Cuando hay filtros específicos, SIEMPRE usar attendancePct de dynamicKPIsRaw
    // porque ese valor está calculado con los filtros aplicados (Firebase/SQL data filtrada)
    // Los datos cacheados (statsAPI, fallbackKPIs) son valores globales sin filtros
    
    // 🔧 CORREGIDO: Usar siempre el valor calculado - si es 0, mostrar 0
    // NO preservar valores anteriores ya que confunde al usuario
    const effectiveAttendancePct = dynamicKPIsRaw.attendancePct ?? 0;
    
    // SIEMPRE usar dynamicKPIsRaw si tiene datos (viene de localStorage y es instantáneo)
    // Esto garantiza que los KPIs se muestren inmediatamente sin depender de Firebase/API
    if (dynamicKPIsRaw.studentsCount > 0 || dynamicKPIsRaw.coursesCount > 0 || dynamicKPIsRaw.sectionsCount > 0 || dynamicKPIsRaw.teachersCount > 0) {
      return {
        ...dynamicKPIsRaw,
        attendancePct: effectiveAttendancePct,
        _hasAttendanceData: dynamicKPIsRaw._hasAttendanceData,
      };
    }
    
    // Si dynamicKPIsRaw está vacío, intentar con datos de la API de stats
    if (statsAPI.hasData && statsAPI.kpis) {
      const cachedKpis = statsAPI.kpis;
      return {
        studentsCount: cachedKpis.studentsCount || 0,
        coursesCount: cachedKpis.coursesCount || 0,
        sectionsCount: cachedKpis.sectionsCount || 0,
        teachersCount: cachedKpis.teachersCount || 0,
        // 🔥 CRÍTICO: Si hay filtros específicos, SIEMPRE usar el valor calculado dinámicamente
        // El valor cacheado (cachedKpis.attendancePct) es global y no refleja los filtros
        attendancePct: hasSpecificFilters 
          ? effectiveAttendancePct 
          : (cachedKpis.attendancePct ?? effectiveAttendancePct),
        attendanceAvgDaysPerStudent: dynamicKPIsRaw.attendanceAvgDaysPerStudent,
        attendanceDaysPresent: dynamicKPIsRaw.attendanceDaysPresent,
        attendanceDaysTotal: dynamicKPIsRaw.attendanceDaysTotal,
        attendanceDaysPeriodTotal: dynamicKPIsRaw.attendanceDaysPeriodTotal,
        _tick: dynamicKPIsRaw._tick,
        _hasAttendanceData: dynamicKPIsRaw._hasAttendanceData,
      };
    }
    
    // Si fallbackKPIs tiene datos, usarlos
    if (fallbackKPIs && (fallbackKPIs.studentsCount || 0) > 0) {
      return {
        studentsCount: fallbackKPIs.studentsCount || 0,
        coursesCount: dynamicKPIsRaw.coursesCount || 0,
        sectionsCount: dynamicKPIsRaw.sectionsCount || 0,
        teachersCount: dynamicKPIsRaw.teachersCount || 0,
        // 🔥 CRÍTICO: Si hay filtros específicos, SIEMPRE usar el valor calculado dinámicamente
        attendancePct: hasSpecificFilters 
          ? effectiveAttendancePct 
          : (fallbackKPIs.attendancePct ?? effectiveAttendancePct),
        attendanceAvgDaysPerStudent: dynamicKPIsRaw.attendanceAvgDaysPerStudent,
        attendanceDaysPresent: dynamicKPIsRaw.attendanceDaysPresent,
        attendanceDaysTotal: dynamicKPIsRaw.attendanceDaysTotal,
        attendanceDaysPeriodTotal: dynamicKPIsRaw.attendanceDaysPeriodTotal,
        _tick: dynamicKPIsRaw._tick,
        _hasAttendanceData: dynamicKPIsRaw._hasAttendanceData,
      };
    }
    
    // Fallback final: usar dynamicKPIsRaw con el attendancePct efectivo
    return {
      ...dynamicKPIsRaw,
      attendancePct: effectiveAttendancePct,
      _hasAttendanceData: dynamicKPIsRaw._hasAttendanceData,
    };
  }, [statsAPI.hasData, statsAPI.kpis, fallbackKPIs, dynamicKPIsRaw, dynamicKPIsRaw._tick, hasSpecificFilters]);

  // 🚀 Persistir studentAgg al snapshot para carga instantánea futura (solo cuando no hay filtros activos)
  useEffect(() => {
    // Solo guardar cuando tenemos datos válidos y sin filtros que sesguen los resultados
    if (!hasActiveFilters) {
      const totalStudents = (dynamicKPIs?.studentsCount > 0)
        ? dynamicKPIs.studentsCount
        : studentAgg.totalStudents;
      if (totalStudents > 0) {
        const failedCount = studentAgg.failedCount;
        const approvedCount = Math.max(0, totalStudents - failedCount);
        if (approvedCount + failedCount > 0) {
          writeKPIsSnapshot(selectedYear, {
            studentsCount: totalStudents,
            approvedCount,
            failedCount,
            overallAvgPct: studentAgg.overallAvgPct,
          });
        }
      }
    }
  }, [hasActiveFilters, selectedYear, studentAgg.totalStudents, studentAgg.approvedCount, studentAgg.failedCount, studentAgg.overallAvgPct, dynamicKPIs?.studentsCount]);

  // Función helper para formatear insights
  const formatInsight = (insight: string): JSX.Element => {
  // Quitar asteriscos y numeración existente
  let cleanText = insight.replace(/\*+/g, '');
  cleanText = cleanText.replace(/^\d+\.\s*/, '');
  cleanText = cleanText.replace(/^\s*\*/g, '');

    // Frases clave a resaltar como bloque
    const phrases = [
      'bajo promedio general de \d+\.?\d*%',
      'alto rendimiento general de \d+\.?\d*%',
      'asistencia promedio relativamente alta \(\d+\.?\d*%\)',
      'asistencia promedio de \d+\.?\d*%',
      'promedio general de \d+\.?\d*%',
      'rendimiento académico de \d+\.?\d*%',
      'aprobación del \d+\.?\d*%',
      'reprobación del \d+\.?\d*%',
      'asistencia del \d+\.?\d*%',
      'asistencia baja del \d+\.?\d*%',
      'asistencia ejemplar del \d+\.?\d*%',
      'asistencia crítica del \d+\.?\d*%',
      // Términos educativos específicos
      '\d+(ro|do|to|er) Básico [A-Z]',
      '\d+(ro|do|to|er) Medio [A-Z]',
      '\d+(ro|do|to|er) Básico',
      '\d+(ro|do|to|er) Medio',
      '1er Semestre',
      '2do Semestre',
      'Primer [Ss]emestre',
      'Segundo [Ss]emestre',
      'Básica',
      'Media',
      'sección [A-Z]',
      'secciones [A-Z] y [A-Z]',
      'entre las secciones [A-Z]',
      'curso \d+(ro|do|to|er)',
      'en el \d+(ro|do|to|er) Básico',
      'en el \d+(ro|do|to|er) Medio',
      'del \d+(ro|do|to|er) Básico',
      'del \d+(ro|do|to|er) Medio'
    ];

    // Palabras clave a resaltar
    const keywords = [
      'promedio', 'rendimiento', 'asistencia', 'reprobación', 'aprobación', 
      'crítico', 'urgente', 'destacados', 'bajo', 'alto', 'excelente',
      'deficiente', 'preocupante', 'satisfactorio', 'sobresaliente',
      // Términos educativos adicionales
      'semestre', 'básica', 'media', 'curso', 'sección', 'nivel',
      'estudiantes', 'calificaciones', 'tareas', 'evaluaciones'
    ];

    // Primero, resaltar TODAS las frases clave (bloque completo, sin doble color)
    let text = cleanText;
    
    // Crear un regex combinado de todas las frases educativas
    const educationalPhrases = [
      '\d+(ro|do|to|er) Básico [A-Z]',
      '\d+(ro|do|to|er) Medio [A-Z]',
      '\d+(ro|do|to|er) Básico',
      '\d+(ro|do|to|er) Medio',
      '1er Semestre',
      '2do Semestre',
      'Primer [Ss]emestre',
      'Segundo [Ss]emestre',
      'Básica',
      'Media',
      'sección [A-Z]',
      'secciones [A-Z] y [A-Z]',
      'entre las secciones [A-Z]',
      'curso \d+(ro|do|to|er)',
      'en el \d+(ro|do|to|er) Básico',
      'en el \d+(ro|do|to|er) Medio',
      'del \d+(ro|do|to|er) Básico',
      'del \d+(ro|do|to|er) Medio'
    ];
    
    // Aplicar resaltado a frases educativas
    educationalPhrases.forEach((phrase, i) => {
      const regex = new RegExp(phrase, 'gi');
      text = text.replace(regex, (match) => `<EDUCATIONAL_${i}>${match}</EDUCATIONAL_${i}>`);
    });
    
    // Aplicar resaltado a otras frases de rendimiento
    const performancePhrases = [
      'bajo promedio general de \d+\.?\d*%',
      'alto rendimiento general de \d+\.?\d*%',
      'asistencia promedio relativamente alta \(\d+\.?\d*%\)',
      'asistencia promedio de \d+\.?\d*%',
      'promedio general de \d+\.?\d*%',
      'rendimiento académico de \d+\.?\d*%',
      'aprobación del \d+\.?\d*%',
      'reprobación del \d+\.?\d*%',
      'asistencia del \d+\.?\d*%',
      'asistencia baja del \d+\.?\d*%',
      'asistencia ejemplar del \d+\.?\d*%',
      'asistencia crítica del \d+\.?\d*%'
    ];
    
    performancePhrases.forEach((phrase, i) => {
      const regex = new RegExp(phrase, 'gi');
      text = text.replace(regex, (match) => `<PERFORMANCE_${i}>${match}</PERFORMANCE_${i}>`);
    });
    
    // Convertir marcadores a JSX
    const result: Array<JSX.Element|string> = [];
    const parts = text.split(/(<(?:EDUCATIONAL|PERFORMANCE)_\d+>.*?<\/(?:EDUCATIONAL|PERFORMANCE)_\d+>)/);
    
    parts.forEach((part, idx) => {
      if (part.match(/^<(EDUCATIONAL|PERFORMANCE)_(\d+)>(.*?)<\/\1_\2>$/)) {
        const content = part.replace(/^<(?:EDUCATIONAL|PERFORMANCE)_\d+>(.*?)<\/(?:EDUCATIONAL|PERFORMANCE)_\d+>$/, '$1');
        result.push(<span key={`phrase-${idx}`} className="font-semibold text-orange-600 dark:text-orange-400">{content}</span>);
      } else if (part.trim()) {
        // Procesar números y palabras clave en el texto restante
        result.push(...processNumbersAndKeywords(part, idx));
      }
    });
    
    return <span>{result}</span>;
  };
  
  // Función auxiliar para procesar números y palabras clave
  const processNumbersAndKeywords = (text: string, baseIdx: number): Array<JSX.Element|string> => {
    const keywords = [
      'promedio', 'rendimiento', 'asistencia', 'reprobación', 'aprobación', 
      'crítico', 'urgente', 'destacados', 'bajo', 'alto', 'excelente',
      'deficiente', 'preocupante', 'satisfactorio', 'sobresaliente',
      'estudiantes', 'calificaciones', 'tareas', 'evaluaciones'
    ];
    
    // Regex para números decimales y porcentajes (con punto o coma)
    // Solo procesa números que NO sean parte de términos ya marcados como educativos
    // Evita números seguidos de ordinals educativos (to, do, ro, er) y "Básico", "Medio"
    const regex = /(\d+[\.,]\d+%?|\d+%)(?!\s*(to|do|ro|er)\s+(Básico|Medio))/g;
    const parts = [];
    let lastIndex = 0;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      // Texto antes del número
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      const value = match[0];
      if (/\d+[\.,]\d+%|\d+%/.test(value)) {
        // Números decimales y porcentajes - unificado en naranja
        parts.push(<span key={`pct-${baseIdx}-${match.index}`} className="font-semibold text-orange-600 dark:text-orange-400">{value}</span>);
      } else if (/^\d+$/.test(value)) {
        // Números enteros - unificado en naranja
        parts.push(<span key={`num-${baseIdx}-${match.index}`} className="font-semibold text-orange-600 dark:text-orange-400">{value}</span>);
      } else {
        parts.push(value);
      }
      lastIndex = regex.lastIndex;
    }
    
    // Resto del texto
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    
    // Palabras clave
    return parts.map((part: any, tidx: number) => {
      if (typeof part === 'string' && keywords.some(k => new RegExp(`^${k}$`, 'i').test(part.trim()))) {
        return <span key={`kw-${baseIdx}-${tidx}`} className="font-medium text-orange-600 dark:text-orange-400">{part}</span>;
      }
      return part;
    });
  };

  // Función para generar insights con IA de Google
  const generateAIInsights = useCallback(async (statsData: any, studentData: any, kpisData: any, courses: any[] = [], sections: any[] = []) => {
    try {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
      
      
      if (!apiKey) {
        console.warn('API Key de Google no configurada, usando insights básicos');
        return generateFallbackInsights(statsData, studentData, kpisData);
      }

      // Buscar nombre legible del curso
      const selectedCourseData = courses.find((c: any) => String(c?.id || c?.courseId) === String(adminCourse));
      const courseName = selectedCourseData 
        ? (selectedCourseData?.label || selectedCourseData?.name || `Curso ${adminCourse}`)
        : adminCourse === 'all' ? 'Todos los cursos' : `Curso ${adminCourse}`;

      // Buscar nombre legible del nivel
      const levelName = selectedLevel === 'all' ? 'Todos los niveles' : 
        selectedLevel === 'basica' ? 'Básica' :
        selectedLevel === 'media' ? 'Media' : selectedLevel;

      // Buscar nombre legible de la sección
      const selectedSectionData = sections.find((s: any) => String(s?.id || s?.sectionId) === String(adminSection));
      const sectionName = adminSection === 'all' ? 'Todas las secciones' : 
        selectedSectionData ? 
          (selectedSectionData?.fullName || selectedSectionData?.displayName || selectedSectionData?.longName || selectedSectionData?.label || selectedSectionData?.name || `Sección ${adminSection}`) :
          `Sección ${adminSection}`;

      // Buscar nombre legible del semestre
      const semesterName = semester === 'all' ? 'Todo el año' :
        semester === 'S1' ? 'Primer semestre' :
        semester === 'S2' ? 'Segundo semestre' : semester;

      // Preparar datos para el análisis
      const analysisData = {
        totalStudents: studentData?.totalStudents || 0,
        approvedCount: studentData?.approvedCount || 0,
        failedCount: studentData?.failedCount || 0,
        overallAvgPct: studentData?.overallAvgPct || 0,
        standoutCount: (studentData as any)?.standoutCount || 0,
        attendancePct: kpisData?.attendancePct || 0,
        monthlyTrend: statsData?.monthlyAvg20 || [],
        activeTasks: statsData?.tasksCreated || 0,
        completedTasks: statsData?.gradedSubmissions || 0,
        avgScore: statsData?.avgScore20 || 0,
        // Datos específicos de gráficos
        comparisonData: statsData?.comparisonDataPct || [],
        monthlyPctByKey: statsData?.monthlyPctByKey || {},
        attendanceMonthlyPct: statsData?.attendanceMonthlyPct || {},
        comparisonType: comparisonType,
        filters: {
          period,
          level: levelName,
          course: courseName,
          section: sectionName,
          semester: semesterName,
          subject: subjectFilter || 'Todas las asignaturas',
          year: selectedYear
        }
      };


      // VALIDACIÓN ESTRICTA: Solo generar insights si hay estudiantes
      if (analysisData.totalStudents === 0) {
        return [];
      }


      // Definir variables para el análisis
      const hasAttendance = analysisData.attendancePct > 0;
      const hasMonthlyTrend = Array.isArray(analysisData.monthlyTrend) && analysisData.monthlyTrend.length > 1;
      const hasTasks = analysisData.activeTasks > 0 || analysisData.completedTasks > 0;
      const hasStudentData = analysisData.totalStudents > 0;

      // Evaluar si los datos son limitados
      const isLimitedData = !hasAttendance && !hasMonthlyTrend && !hasTasks;
      const dataScope = isLimitedData ? 'LIMITED_DATA' : 'COMPLETE_DATA';

      const lang = typeof window !== 'undefined' && (localStorage.getItem('smart-student-lang') || document.documentElement.lang) === 'en' ? 'en' : 'es';
      const prompt = lang === 'en'
  ? `Analyze the following educational data and provide key insights in English:

DATA SCOPE: ${dataScope}
${isLimitedData ? '(Note: Limited data available - provide 1-2 comprehensive insights instead of 6)' : '(Note: Complete data available - provide up to 6 insights)'}

System data:
- Total students: ${analysisData.totalStudents}
- Approved students: ${analysisData.approvedCount}
- Failed students: ${analysisData.failedCount}
- Overall average: ${analysisData.overallAvgPct.toFixed(1)}%
- Standout students: ${analysisData.standoutCount}
- Average attendance: ${analysisData.attendancePct.toFixed(1)}%
- Active tasks: ${analysisData.activeTasks}
- Completed tasks: ${analysisData.completedTasks}
- Average score: ${analysisData.avgScore.toFixed(1)}

Chart data:
- Current analysis type: ${analysisData.comparisonType === 'notas' ? 'Grades' : 'Attendance'}
- Comparison chart data: ${JSON.stringify(analysisData.comparisonData.slice(0, 5))} ${analysisData.comparisonData.length > 5 ? '(showing first 5)' : ''}
- Monthly trend data: ${JSON.stringify(Object.entries(analysisData.monthlyPctByKey).slice(0, 6))} ${Object.keys(analysisData.monthlyPctByKey).length > 6 ? '(showing first 6 months)' : ''}
- Monthly attendance trend: ${JSON.stringify(Object.entries(analysisData.attendanceMonthlyPct).slice(0, 6))} ${Object.keys(analysisData.attendanceMonthlyPct).length > 6 ? '(showing first 6 months)' : ''}

Applied filters:
- Period: ${analysisData.filters.period}
- Level: ${analysisData.filters.level}
- Course: ${analysisData.filters.course}
- Section: ${analysisData.filters.section}
- Semester: ${analysisData.filters.semester}
- Subject: ${analysisData.filters.subject}
- Year: ${analysisData.filters.year}

CRITICAL INSTRUCTIONS:
- DO NOT mention "absence of data", "lack of information", "no data available" or similar
- DO NOT reference that the school year hasn't started or no data has been recorded
- DO NOT comment on missing data or unavailable information
- FOCUS ONLY on PRESENT data and their positive implications
- If data is limited, provide FEWER but MORE COMPLETE AND SPECIFIC insights
- With limited data (only attendance), generate 1-2 substantial insights instead of repeating similar concepts

FORMAT AND SPECIFIC CONTEXT:
- When comparing groups or sections, ALWAYS specify the complete course (e.g.: "in 4th Grade, sections A and B" NOT "groups A and B")
- Use full course names (e.g.: "4th Grade A", "2nd High School B")
- Clearly specify the educational level (Elementary/High School) and semester when relevant
- Avoid vague references like "groups", "classes" without specific context

Provide practical and actionable insights for educators. Each insight should be a complete and specific sentence. Focus on:
1. Academic performance and trends based on available data
2. Specific improvement opportunities
3. Students requiring attention
4. Effectiveness of current strategies
5. Concrete recommendations for growth

Format: One line per insight. If there is complete data: maximum 6 insights. If there is limited data: 1-3 more substantial and detailed insights. Only constructive and action-oriented insights.`
  : `Analiza los siguientes datos educativos y proporciona insights clave en español:

ALCANCE DE DATOS: ${dataScope}
${isLimitedData ? '(Nota: Datos limitados disponibles - proporciona 1-2 insights comprehensivos en lugar de 6)' : '(Nota: Datos completos disponibles - proporciona hasta 6 insights)'}

Datos del sistema:
- Total estudiantes: ${analysisData.totalStudents}
- Estudiantes aprobados: ${analysisData.approvedCount}
- Estudiantes reprobados: ${analysisData.failedCount}
- Promedio general: ${analysisData.overallAvgPct.toFixed(1)}%
- Estudiantes destacados: ${analysisData.standoutCount}
- Asistencia promedio: ${analysisData.attendancePct.toFixed(1)}%
- Tareas activas: ${analysisData.activeTasks}
- Tareas completadas: ${analysisData.completedTasks}
- Puntaje promedio: ${analysisData.avgScore.toFixed(1)}

Datos de gráficos:
- Tipo de análisis actual: ${analysisData.comparisonType === 'notas' ? 'Calificaciones' : 'Asistencia'}
- Datos gráfico comparación: ${JSON.stringify(analysisData.comparisonData.slice(0, 5))} ${analysisData.comparisonData.length > 5 ? '(mostrando primeros 5)' : ''}
- Datos tendencia mensual: ${JSON.stringify(Object.entries(analysisData.monthlyPctByKey).slice(0, 6))} ${Object.keys(analysisData.monthlyPctByKey).length > 6 ? '(mostrando primeros 6 meses)' : ''}
- Tendencia asistencia mensual: ${JSON.stringify(Object.entries(analysisData.attendanceMonthlyPct).slice(0, 6))} ${Object.keys(analysisData.attendanceMonthlyPct).length > 6 ? '(mostrando primeros 6 meses)' : ''}

Filtros aplicados:
- Período: ${analysisData.filters.period}
- Nivel: ${analysisData.filters.level}
- Curso: ${analysisData.filters.course}
- Sección: ${analysisData.filters.section}
- Semestre: ${analysisData.filters.semester}
- Asignatura: ${analysisData.filters.subject}
- Año: ${analysisData.filters.year}

INSTRUCCIONES CRÍTICAS:
- NO menciones "ausencia de datos", "falta de información", "no hay datos" o similares
- NO hagas referencia a que el año escolar no ha comenzado o no se han registrado datos
- NO comentes sobre datos faltantes o información no disponible
- ENFÓCATE ÚNICAMENTE en los datos PRESENTES y sus implicaciones positivas
- Si los datos son limitados, proporciona MENOS insights pero MÁS COMPLETOS Y ESPECÍFICOS
- Con datos limitados (solo asistencia), genera 1-2 insights sustanciales en lugar de repetir conceptos similares

FORMATO Y CONTEXTO ESPECÍFICO:
- Cuando compares grupos o secciones, SIEMPRE especifica el curso completo (ej: "en 4to Básico, las secciones A y B" NO "los grupos A y B")
- Usa nombres completos de cursos (ej: "4to Básico A", "2do Medio B")
- Especifica claramente el nivel educativo (Básica/Media) y semestre cuando sea relevante
- Evita referencias vagas como "grupos", "clases" sin contexto específico

Proporciona insights prácticos y accionables para educadores. Cada insight debe ser una oración completa y específica. Enfócate en:
1. Rendimiento académico y tendencias basadas en datos disponibles
2. Oportunidades de mejora específicas
3. Estudiantes que requieren atención
4. Efectividad de las estrategias actuales
5. Recomendaciones concretas para el crecimiento

Formato: Una línea por insight. Si hay datos completos: máximo 6 insights. Si hay datos limitados: 1-3 insights más sustanciales y detallados. Solo insights constructivos y orientados a la acción.`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error de API Google (${response.status}):`, errorText);
        
        // Si es error 403 o cualquier error de autenticación, usar fallback
        if (response.status === 403 || response.status === 401) {
          console.warn('Error de autenticación con Google API, usando insights básicos');
          return generateFallbackInsights(statsData, studentData, kpisData);
        }
        
        throw new Error(`Error de API: ${response.status}`);
      }

      const data = await response.json();
      const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      if (!generatedText) {
        console.warn('Respuesta vacía de Google API, usando insights básicos');
        return generateFallbackInsights(statsData, studentData, kpisData);
      }
      
      // Procesar la respuesta para extraer insights individuales
      const insights = generatedText
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 10 && line.includes('.'))
        .slice(0, 6); // Máximo 6 insights

      return insights.length > 0 ? insights : generateFallbackInsights(statsData, studentData, kpisData);
      
    } catch (error) {
      console.error('Error generando insights con IA:', error);
      return generateFallbackInsights(statsData, studentData, kpisData);
    }
  }, [period, selectedLevel, adminCourse, adminSection, semester, subjectFilter, selectedYear, adminCourses, adminSections]);

  // Función para generar insights básicos como fallback
  const generateFallbackInsights = useCallback((statsData: any, studentData: any, kpisData: any) => {
    const insights: string[] = [];
    const total = Number(studentData?.totalStudents || 0);
    const approved = Number(studentData?.approvedCount || 0);
    const failed = Number(studentData?.failedCount || 0);
    const avgPct = Number(studentData?.overallAvgPct || 0);
    const standouts = Number((studentData as any)?.standoutCount || 0);
    const attendance = Number(kpisData?.attendancePct || 0);
    const activeTasks = Number(statsData?.tasksCreated || 0);
    const completedTasks = Number(statsData?.gradedSubmissions || 0);

    // Si no hay datos relevantes para analizar, retornar array vacío
    if (total === 0 && attendance === 0 && activeTasks === 0 && completedTasks === 0) {
      return [];
    }

    if (total === 0) {
      // Si no hay estudiantes, pero sí datos de asistencia, consolidar en un insight más completo
      if (attendance > 0) {
        let attendanceInsight = '';
        if (attendance >= 96) {
          attendanceInsight = `La asistencia ejemplar del ${attendance.toFixed(1)}% establece una base sólida para el éxito académico. Este nivel de compromiso estudiantil indica un ambiente educativo favorable que debe mantenerse mediante estrategias de motivación y reconocimiento constante.`;
        } else if (attendance >= 90) {
          attendanceInsight = `La buena asistencia del ${attendance.toFixed(1)}% proporciona una plataforma estable para el aprendizaje, aunque existe margen de mejora. Implementar incentivos específicos y comunicación proactiva con familias podría optimizar este indicador.`;
        } else if (attendance >= 85) {
          attendanceInsight = `La asistencia del ${attendance.toFixed(1)}% sugiere oportunidades de mejora significativas. Desarrollar estrategias focalizadas de seguimiento personalizado, identificar barreras de acceso y fortalecer el vínculo familia-escuela para incrementar la participación estudiantil.`;
        } else if (attendance >= 75) {
          attendanceInsight = `La asistencia del ${attendance.toFixed(1)}% requiere atención prioritaria, ya que impacta directamente el rendimiento académico. Es crucial implementar un sistema de seguimiento individualizado, programas de apoyo familiar y estrategias de reengagement estudiantil.`;
        } else {
          attendanceInsight = `La asistencia crítica del ${attendance.toFixed(1)}% representa un desafío fundamental que requiere intervención inmediata y multidisciplinaria. Implementar planes de acción integrales que aborden factores socioeconómicos, motivacionales y de acceso educativo.`;
        }
        insights.push(attendanceInsight);
      }
      
      // Solo agregar insight de tareas si hay datos significativos Y no es redundante con asistencia
      if ((activeTasks > 0 || completedTasks > 0) && insights.length === 0) {
        const totalTasks = activeTasks + completedTasks;
        const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
        if (completionRate >= 85) {
          insights.push(`La excelente gestión de tareas con ${completionRate}% de completitud (${completedTasks}/${totalTasks} tareas) refleja organización efectiva y compromiso académico que debe ser reconocido y replicado.`);
        } else if (completionRate >= 70) {
          insights.push(`La gestión de tareas al ${completionRate}% muestra potencial de optimización. Implementar mejores procesos de seguimiento, cronogramas claros y apoyo diferenciado podría elevar significativamente este indicador.`);
        } else if (totalTasks > 0) {
          insights.push(`La gestión de tareas al ${completionRate}% requiere revisión integral de metodologías de planificación, seguimiento académico y estrategias de apoyo estudiantil para mejorar la efectividad del proceso educativo.`);
        }
      }
      
      // Si no hay datos relevantes, no mostrar ningún insight
      return insights;
    }

    const approvalRate = Math.round((approved / total) * 100);
    const failureRate = Math.round((failed / total) * 100);

    // Análisis prioritario de rendimiento académico
    if (approvalRate >= 90) {
      insights.push(`Rendimiento excepcional: ${approvalRate}% de aprobación indica excelente calidad educativa.`);
    } else if (approvalRate >= 80) {
      insights.push(`Buen rendimiento académico con ${approvalRate}% de aprobación, buscar oportunidades de mejora continua.`);
    } else if (approvalRate >= 70) {
      insights.push(`Rendimiento moderado del ${approvalRate}% requiere análisis de metodologías de enseñanza y apoyo estudiantil.`);
    } else if (approvalRate >= 50) {
      insights.push(`Rendimiento preocupante del ${approvalRate}% necesita intervención inmediata y plan de mejora académica.`);
    } else {
      insights.push(`Situación crítica: solo ${approvalRate}% de aprobación requiere revisión completa del programa educativo.`);
    }

    // Análisis específico de reprobación si es significativa
    if (failureRate >= 40) {
      insights.push(`Alerta máxima: ${failureRate}% de reprobación indica problemas sistemicos en el proceso educativo.`);
    } else if (failureRate >= 25) {
      insights.push(`Tasa de reprobación elevada del ${failureRate}% requiere identificar causas raíz y estrategias de remediación.`);
    } else if (failureRate >= 15) {
      insights.push(`Tasa de reprobación del ${failureRate}% sugiere necesidad de programas de apoyo académico adicionales.`);
    }

    // Análisis de promedio general
    if (avgPct >= 90) {
      insights.push(`Promedio excepcional de ${avgPct.toFixed(1)}% refleja alta calidad en el proceso de enseñanza-aprendizaje.`);
    } else if (avgPct >= 80) {
      insights.push(`Promedio sólido de ${avgPct.toFixed(1)}% con potencial para alcanzar niveles de excelencia académica.`);
    } else if (avgPct >= 70) {
      insights.push(`Promedio de ${avgPct.toFixed(1)}% indica necesidad de reforzar competencias fundamentales en los estudiantes.`);
    } else if (avgPct >= 60) {
      insights.push(`Promedio bajo de ${avgPct.toFixed(1)}% requiere revisión de estrategias pedagógicas y evaluación curricular.`);
    } else if (avgPct > 0) {
      insights.push(`Promedio crítico de ${avgPct.toFixed(1)}% demanda intervención urgente y reestructuración del programa académico.`);
    }

    // Análisis de estudiantes destacados
    const standoutPercentage = total > 0 ? Math.round((standouts / total) * 100) : 0;
    if (standouts >= 5 && standoutPercentage >= 20) {
      insights.push(`Excelente: ${standouts} estudiantes destacados (${standoutPercentage}%) demuestran potencial para programas de excelencia académica.`);
    } else if (standouts >= 3 && standoutPercentage >= 10) {
      insights.push(`${standouts} estudiantes destacados (${standoutPercentage}%) muestran oportunidades para mentorías y liderazgo académico.`);
    } else if (standouts > 0) {
      insights.push(`${standouts} estudiantes destacados identificados - considerar estrategias para ampliar este grupo de alto rendimiento.`);
    } else {
      // Si no hay estudiantes destacados, enfocarse en oportunidades de mejora sin mencionar ausencia
      if (avgPct >= 75) {
        insights.push('Oportunidad para implementar programas de desarrollo del talento académico y reconocimiento de excelencia.');
      } else if (avgPct >= 60) {
        insights.push('Potencial para crear programas de apoyo que identifiquen y desarrollen estudiantes con alto rendimiento académico.');
      }
    }

    // Análisis de asistencia si está disponible
    if (attendance > 0) {
      if (attendance >= 96) {
        insights.push(`Asistencia ejemplar del ${attendance.toFixed(1)}% contribuye significativamente al alto rendimiento académico.`);
      } else if (attendance >= 90) {
        insights.push(`Buena asistencia del ${attendance.toFixed(1)}% facilita el proceso educativo pero puede optimizarse.`);
      } else if (attendance >= 85) {
        insights.push(`Asistencia del ${attendance.toFixed(1)}% requiere estrategias para reducir ausentismo y mejorar engagement estudiantil.`);
      } else if (attendance >= 75) {
        insights.push(`Asistencia baja del ${attendance.toFixed(1)}% impacta negativamente el rendimiento - implementar seguimiento individualizado.`);
      } else {
        insights.push(`Asistencia crítica del ${attendance.toFixed(1)}% es factor determinante en el bajo rendimiento académico observado.`);
      }
    }

    // Análisis de gestión de tareas si hay datos
    if (activeTasks > 0 || completedTasks > 0) {
      const totalTasks = activeTasks + completedTasks;
      const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      
      if (completionRate >= 85) {
        insights.push(`Excelente gestión de tareas con ${completionRate}% de completitud (${completedTasks}/${totalTasks} tareas).`);
      } else if (completionRate >= 70) {
        insights.push(`Gestión adecuada de tareas al ${completionRate}% - oportunidad de optimizar procesos de seguimiento.`);
      } else if (completionRate >= 50) {
        insights.push(`Gestión de tareas al ${completionRate}% requiere mejores estrategias de planificación y seguimiento académico.`);
      } else if (totalTasks > 0) {
        insights.push(`Gestión deficiente de tareas al ${completionRate}% impacta el proceso de aprendizaje - revisar metodología.`);
      }
    }

    // Recomendaciones según filtros aplicados
    if (semester !== 'all') {
      const semesterName = semester === 'S1' ? 'primer' : 'segundo';
      insights.push(`Análisis del ${semesterName} semestre permite comparación con períodos anteriores para tendencias educativas.`);
    }

    return insights.slice(0, 6);
  }, [period, semester]);

  // Función para actualizar insights con IA
  const handleRefreshInsights = useCallback(async () => {
    try {
      setIsGeneratingInsights(true);
      setInsightsSync(false); // Marcar como no sincronizado mientras se genera
      
      
      // Generar insights con los datos actuales
      const newInsights = await generateAIInsights(stats, studentAgg, dynamicKPIs, adminCourses, adminSections);
      
      
      // Actualizar insights y marcar como sincronizado
      setAiInsights(newInsights);
      setInsightsSync(true);
      
    } catch (error) {
      console.error('Error al actualizar insights:', error);
      setInsightsSync(false);
    } finally {
      setIsGeneratingInsights(false);
    }
  }, [generateAIInsights, stats, studentAgg, dynamicKPIs, adminCourses, adminSections]);

  // Generar insights automáticamente cuando se carguen los datos iniciales
  useEffect(() => {
    const timer = setTimeout(() => {
      // Solo generar insights si hay datos reales (estudiantes)
      const totalStudents = Number(studentAgg?.totalStudents || 0);
      if (studentAgg && dynamicKPIs && stats && aiInsights.length === 0 && totalStudents > 0) {
        handleRefreshInsights();
      }
    }, 1000); // Esperar 1 segundo para que se carguen todos los datos

    return () => clearTimeout(timer);
  }, [studentAgg, dynamicKPIs, stats, aiInsights.length, handleRefreshInsights]);

  // 🔧 NUEVO: Limpiar aiInsights cuando no hay datos disponibles
  // Esto evita que queden "congelados" con información de filtros anteriores
  useEffect(() => {
    const totalStudents = Number(studentAgg?.totalStudents || 0);
    const hasGrades = studentAgg?.approvedCount > 0 || studentAgg?.failedCount > 0 || 
                      (typeof studentAgg?.overallAvgPct === 'number' && studentAgg.overallAvgPct > 0);
    const hasAttendance = typeof dynamicKPIs?.attendancePct === 'number' && dynamicKPIs.attendancePct > 0;
    
    // Si no hay estudiantes O no hay ni calificaciones ni asistencia, limpiar insights
    if (totalStudents === 0 || (!hasGrades && !hasAttendance)) {
      if (aiInsights.length > 0) {
        setAiInsights([]);
        setInsightsSync(false);
      }
    }
  }, [studentAgg?.totalStudents, studentAgg?.approvedCount, studentAgg?.failedCount, 
      studentAgg?.overallAvgPct, dynamicKPIs?.attendancePct, aiInsights.length]);

  // Insights dinámicos basados en los KPIs y filtros actuales
  const insights = useMemo(() => {
    try {
      const items: string[] = [];
      const total = Number(studentAgg?.totalStudents || 0);
      const apr = Number(studentAgg?.approvedCount || 0);
      const rep = Number(studentAgg?.failedCount || 0);
      const aprPct = total > 0 ? Math.round((apr / total) * 100) : 0;
      const repPct = total > 0 ? Math.round((rep / total) * 100) : 0;
      const ov = typeof studentAgg?.overallAvgPct === 'number' ? studentAgg.overallAvgPct : undefined;
      const att = typeof dynamicKPIs?.attendancePct === 'number' ? dynamicKPIs.attendancePct : undefined;
      const topCount = Number((studentAgg as any)?.standoutCount || 0);
      const activeTasks = typeof stats?.tasksCreated === 'number' ? stats.tasksCreated : 0;
      const completedTasks = typeof stats?.gradedSubmissions === 'number' ? stats.gradedSubmissions : 0;

      // VALIDACIÓN ESTRICTA: Solo generar insights si hay estudiantes reales
      if (total === 0) {
        return []; // Sin estudiantes = sin insights
      }

      // Hay estudiantes, generar insights académicos
      if (aprPct >= 70) items.push(`${t('insightHighApproval','Aprobación alta')}: ${aprPct}% (${apr}/${total}).`);
      if (repPct >= 30) items.push(`${t('warnFailing','Atención: reprobación')} ${repPct}% (${rep}/${total}).`);
      if (typeof ov === 'number') items.push(`${t('insightGeneralAverage','Promedio general')}: ${ov.toFixed(1)}%.`);
      if (topCount > 0) items.push(`${t('insightStandoutStudents','Estudiantes destacados (≥ 90%)')}: ${topCount}.`);
      
      // Asistencia
      if (typeof att === 'number') {
        if (att < 85) items.push(`${t('insightLowAttendance','Asistencia baja')}: ${att.toFixed(1)}%.`);
        else if (att >= 95) items.push(`${t('insightGreatAttendance','Excelente asistencia')}: ${att.toFixed(1)}%.`);
      }
      
      // Tendencia mensual de notas
      if (stats?.monthlyAvg20 && stats.monthlyAvg20.length >= 2) {
        const first = (stats.monthlyAvg20[0] ?? 0) * 5;
        const last = (stats.monthlyAvg20[stats.monthlyAvg20.length - 1] ?? 0) * 5;
        const diff = last - first;
        if (Math.abs(diff) >= 3) {
          items.push(diff > 0
            ? `${t('insightAvgImproved','Mejora de promedio en el periodo')}: +${diff.toFixed(1)} ${t('points','pts')}.`
            : `${t('insightAvgDropped','Caída de promedio en el periodo')}: ${diff.toFixed(1)} ${t('points','pts')}.`);
        }
      }

      // Deduplicar y limitar
      return Array.from(new Set(items)).slice(0, 6);
    } catch {
      return [] as string[];
    }
  }, [studentAgg?.totalStudents, studentAgg?.approvedCount, studentAgg?.failedCount, studentAgg?.overallAvgPct, (studentAgg as any)?.standoutCount, dynamicKPIs?.attendancePct, stats?.monthlyAvg20?.join(','), stats?.tasksCreated, stats?.gradedSubmissions, subjectFilter]);

  const exportPDF = async () => {
    try {
      // Importar librerías pesadas del lado del cliente de forma diferida para evitar SSR issues
      const [{ default: html2canvas }, { default: JsPDF } ] = await Promise.all([
        import('html2canvas'),
        import('jspdf')
      ]);

      const container = document.getElementById('teacher-stats-container');
      if (!container) {
  console.error('[stats] teacher-stats-container not found');
        return;
      }

      // Configurar PDF
      const pdf = new JsPDF('p', 'pt', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 30;

      // Mostrar indicador de carga
      const loadingEl = document.createElement('div');
      loadingEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:white;padding:20px;border-radius:8px;z-index:10000;font-family:system-ui';
      loadingEl.textContent = 'Generando PDF...';
      document.body.appendChild(loadingEl);

      // Ocultar temporalmente el botón de descarga y otros elementos no deseados
      const downloadButton = container.querySelector('[data-download-button]') || container.querySelector('button:has(.lucide-download)');
      const originalDisplays: Array<{ element: Element; display: string }> = [];
      
      // Ocultar botones de descarga y elementos de navegación
      const elementsToHide = container.querySelectorAll('button, .download-btn, [aria-label*="download"], [aria-label*="Download"]');
      elementsToHide.forEach(el => {
        const element = el as HTMLElement;
        if (element.textContent?.toLowerCase().includes('download') || 
            element.textContent?.toLowerCase().includes('descargar') ||
            element.querySelector('.lucide-download')) {
          originalDisplays.push({ element, display: element.style.display });
          element.style.display = 'none';
        }
      });

      // Optimizar captura para mejor calidad y compatibilidad con contenido dinámico
      const canvas = await html2canvas(container as HTMLElement, {
        scale: 1.8, // Mejor calidad
        backgroundColor: '#1e293b', // Color de fondo oscuro consistente
        useCORS: true,
        allowTaint: true,
        foreignObjectRendering: true,
        logging: false,
        width: container.scrollWidth,
        height: container.scrollHeight,
        scrollX: 0,
        scrollY: 0,
        // Mejorar rendering de SVGs y gráficos
        onclone: (clonedDoc) => {
          // Asegurar que los estilos se aplican correctamente
          const clonedContainer = clonedDoc.getElementById('teacher-stats-container');
          if (clonedContainer) {
            clonedContainer.style.transform = 'none';
            clonedContainer.style.position = 'static';
            clonedContainer.style.padding = '20px';
          }
          
          // Ocultar elementos no deseados en el clon también
          const clonedElementsToHide = clonedDoc.querySelectorAll('button, .download-btn, [aria-label*="download"], [aria-label*="Download"]');
          clonedElementsToHide.forEach(el => {
            const element = el as HTMLElement;
            if (element.textContent?.toLowerCase().includes('download') || 
                element.textContent?.toLowerCase().includes('descargar') ||
                element.querySelector('.lucide-download')) {
              element.style.display = 'none';
            }
          });
        }
      });

      // Restaurar elementos ocultos
      originalDisplays.forEach(({ element, display }) => {
        (element as HTMLElement).style.display = display;
      });

      document.body.removeChild(loadingEl);

      if (!canvas.width || !canvas.height) {
        throw new Error('No se pudo capturar el contenido');
      }

      // Agregar encabezado al PDF
      pdf.setFillColor(30, 41, 59); // Color de fondo oscuro
      pdf.rect(0, 0, pageWidth, 80, 'F');
      
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
  pdf.text((t('statisticsPageTitle','Estadísticas') + ' - Smart Student'), margin, 35);
      
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'normal');
  const today = new Date().toLocaleDateString((language === 'en') ? 'en-US' : 'es-ES', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
  pdf.text(`${(language === 'en') ? 'Generated on' : 'Generado el'} ${today}`, margin, 55);

      // Filtros activos
      const activeFilterParts = [];
  if (semester !== 'all') activeFilterParts.push(semester === 'S1' ? t('firstSemester','1er Semestre') : t('secondSemester','2do Semestre'));
  if (selectedLevel !== 'all') activeFilterParts.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
  if (adminCourse !== 'all' || selectedCourse !== 'all') activeFilterParts.push(t('specificCourse','Curso específico'));
      
      if (activeFilterParts.length > 0) {
        pdf.text(`${(useLanguage().language === 'en') ? 'Filters' : 'Filtros'}: ${activeFilterParts.join(' • ')}`, margin, 70);
      }
      if (subjectFilter !== 'all') activeFilterParts.push(t('subject','Asignatura'));

      // Calcular dimensiones optimizadas para el contenido
      const contentStartY = 100; // Después del encabezado
      const availableHeight = pageHeight - contentStartY - margin;
      const imgWidth = pageWidth - (margin * 2);
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      // Si la imagen cabe en una página
      if (imgHeight <= availableHeight) {
        const imgData = canvas.toDataURL('image/png', 0.95);
        pdf.addImage(imgData, 'PNG', margin, contentStartY, imgWidth, imgHeight);
      } else {
        // Dividir en múltiples páginas
        const totalPages = Math.ceil(imgHeight / availableHeight);
        const sliceHeight = canvas.height / totalPages;

        for (let i = 0; i < totalPages; i++) {
          if (i > 0) {
            pdf.addPage();
            // Agregar encabezado reducido en páginas adicionales
            pdf.setFillColor(30, 41, 59);
            pdf.rect(0, 0, pageWidth, 50, 'F');
            pdf.setTextColor(255, 255, 255);
            pdf.setFontSize(14);
            pdf.setFont('helvetica', 'bold');
            pdf.text(`Estadísticas - Página ${i + 1} de ${totalPages}`, margin, 30);
          }

          // Crear slice del canvas
          const sliceCanvas = document.createElement('canvas');
          sliceCanvas.width = canvas.width;
          sliceCanvas.height = Math.min(sliceHeight, canvas.height - (i * sliceHeight));
          
          const ctx = sliceCanvas.getContext('2d');
          if (ctx) {
            // Fondo oscuro consistente
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
            
            // Dibujar el slice
            ctx.drawImage(
              canvas,
              0, i * sliceHeight, // origen
              canvas.width, sliceCanvas.height, // tamaño fuente
              0, 0, // destino
              sliceCanvas.width, sliceCanvas.height // tamaño destino
            );
          }

          const sliceData = sliceCanvas.toDataURL('image/png', 0.95);
          const sliceImgHeight = (sliceCanvas.height * imgWidth) / sliceCanvas.width;
          const currentContentStartY = i === 0 ? contentStartY : 60; // Menos espacio en páginas adicionales
          pdf.addImage(sliceData, 'PNG', margin, currentContentStartY, imgWidth, sliceImgHeight);
        }
      }

      // Generar nombre de archivo con filtros activos
      const filterParts = [];
      if (semester !== 'all') filterParts.push(semester === 'S1' ? '1S' : '2S');
      if (selectedLevel !== 'all') filterParts.push(selectedLevel);
  if (adminCourse !== 'all' || selectedCourse !== 'all') filterParts.push('curso');
  if (subjectFilter !== 'all') filterParts.push('asignatura');
      
      const fileName = `${t('statisticsExportPrefix','estadisticas')}-${filterParts.join('-')}-${new Date().toISOString().slice(0,10)}.pdf`;
      pdf.save(fileName);

    } catch (e) {
      console.error('[TeacherStatisticsPage] Error exportando PDF:', e);
      // Mostrar error al usuario
      const errorEl = document.createElement('div');
      errorEl.style.cssText = 'position:fixed;top:20px;right:20px;background:#ef4444;color:white;padding:12px 16px;border-radius:6px;z-index:10000;font-family:system-ui;font-size:14px;max-width:300px';
  errorEl.textContent = t('errorGenerating','Error generating. Please try again.');
      document.body.appendChild(errorEl);
      setTimeout(() => document.body.removeChild(errorEl), 5000);
    }
  };

  // Generador de datos demo para Admin (submissions en 0-100)
  const loadDemoAdminStatsData = () => {
    try {
      if (typeof window === 'undefined') return;
      
      // Usar datos del año seleccionado
      const y = selectedYear;
      let adminSections: any[] = JSON.parse(localStorage.getItem(y ? `smart-student-admin-sections-${y}` : 'smart-student-admin-sections') || '[]');
      let userSections: any[] = JSON.parse(localStorage.getItem(y ? `smart-student-sections-${y}` : 'smart-student-sections') || '[]');
      let adminCourses: any[] = JSON.parse(localStorage.getItem(y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses') || '[]');
      let userCourses: any[] = JSON.parse(localStorage.getItem(y ? `smart-student-courses-${y}` : 'smart-student-courses') || '[]');
      let sections: any[] = [...adminSections, ...userSections];
      let courses: any[] = [...adminCourses, ...userCourses];

      // NO GENERAR SEED AUTOMÁTICO - Solo usar datos existentes
      // Si no hay cursos/secciones reales, no generar datos demo
      if (courses.length === 0 || sections.length === 0) {
        return;
      }

      // Lectura de contexto existente
      const subs: any[] = JSON.parse(localStorage.getItem('smart-student-submissions') || '[]');
      let users: any[] = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      
      // Si ya hay submissions demo para estos cursos/secciones, no regenerar
      const hasExistingDemo = subs.some(sub => 
        sections.some(sec => String(sec.id) === String(sub.sectionId)) &&
        courses.some(course => String(course.id) === String(sub.courseId))
      );
      if (hasExistingDemo) {
        return;
      }

      // Asegurar que hay estudiantes para generar datos demo
      const students = users.filter(u => u?.role === 'student');
      if (students.length === 0) {
        // Crear algunos estudiantes demo solo si hay cursos/secciones reales
        const makeStu = (i:number) => ({ 
          id: `stu-${String(i).padStart(2,'0')}`, 
          username: `stu${String(i).padStart(2,'0')}`, 
          role: 'student', 
          fullName: `Estudiante ${i}` 
        });
        const newStudents = Array.from({ length: 12 }, (_, i) => makeStu(i + 1));
        users = [...users, ...newStudents];
        localStorage.setItem('smart-student-users', JSON.stringify(users));
        window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-users', newValue: JSON.stringify(users) }));
      }

      // Determinar alcance según filtros actuales
      const targetCourseId = adminCourse !== 'all' ? String(adminCourse) : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(0,-1).join('-') : undefined);
      const targetSectionId = adminSection !== 'all' ? String(adminSection) : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(-1)[0] : undefined);
      const targetLevel = selectedLevel !== 'all' ? selectedLevel : undefined;

      // Elegir secciones objetivo
      const secPool = sections.filter((s:any) => {
        const cid = String(s?.courseId || s?.course?.id || s?.courseId);
        const sid = String(s?.id || s?.sectionId);
        if (targetCourseId && cid !== targetCourseId) return false;
        if (targetSectionId && sid !== targetSectionId) return false;
        if (targetLevel) {
          const course = courses.find((c:any)=> String(c?.id) === cid);
          if ((course?.level as Level|undefined) !== targetLevel) return false;
        }
        return true;
      });
      
      if (secPool.length === 0) {
        // si no hay filtros/relación, toma hasta 3 secciones
        secPool.push(...sections.slice(0, Math.min(3, sections.length)));
      }

      // Usar estudiantes existentes
      const availableStudents = users.filter(u => u?.role === 'student');
      if (availableStudents.length === 0) return;

      const nowTs = Date.now();
      const day = 24*60*60*1000;
      // Calcular ventana temporal según filtros (semestre o periodo)
      let startTs = nowTs - 21*day;
      let endTs = nowTs;
      try {
        if (semester !== 'all') {
          const raw = localStorage.getItem('smart-student-semesters');
          if (raw) {
            const sem = JSON.parse(raw);
            const sel = semester === 'S1' ? sem?.first : sem?.second;
            const parseYmd = (s?: string): number | undefined => {
              if (!s) return undefined; 
              const [Y,M,D] = s.split('-').map(Number); 
              if (!Y||!M||!D) return undefined; 
              return new Date(Y,(M||1)-1,D||1).getTime();
            };
            const f = parseYmd(sel?.start); 
            const t2 = parseYmd(sel?.end);
            if (typeof f === 'number' && typeof t2 === 'number') {
              startTs = f; 
              endTs = Math.min(t2, nowTs);
            }
          }
        } else {
          const tw = getTimeWindow(period);
          if (typeof tw.from === 'number') {
            startTs = tw.from; 
            endTs = nowTs;
          }
        }
      } catch {}
      
      // Asegurar rango mínimo de 14 días
      if (endTs - startTs < 14*day) startTs = Math.max(0, endTs - 14*day);

      // Semilla estable
      let h = 2166136261;
      const seed = JSON.stringify({ targetCourseId, targetSectionId, targetLevel, n: subs.length });
      for (let i=0;i<seed.length;i++){ 
        h ^= seed.charCodeAt(i); 
        h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); 
      }
      const rnd = () => { 
        h^=h<<13; 
        h^=h>>>17; 
        h^=h<<5; 
        return ((h>>>0)%1000)/1000; 
      };

      const newSubs: any[] = [];
      // Catálogos enriquecidos para demo: asignaturas con temas
      const subjectCatalog: Array<{ name: string; topics: string[] }> = [
        { name: 'Lenguaje y Comunicación', topics: [
          'Comprensión lectora: textos informativos',
          'Narración: estructura y personajes',
          'Figuras retóricas: metáfora y símil',
          'Ortografía: uso de tildes',
          'Texto argumentativo: tesis y argumentos',
        ] },
        { name: 'Matemáticas', topics: [
          'Números enteros y operaciones',
          'Fracciones y decimales',
          'Ecuaciones lineales',
          'Funciones y gráficas',
          'Probabilidad y conteo básico',
          'Geometría: triángulos y polígonos',
          'Proporcionalidad y porcentajes',
        ] },
        { name: 'Ciencias Naturales', topics: [
          'Sistema Solar',
          'Planetas y satélites',
          'Fases de la Luna',
          'Estrellas y galaxias',
          'El día y la noche',
          'Sistema Respiratorio',
          'Sistema Digestivo',
          'Sistema Circulatorio',
          'Estados de la materia',
          'Cambios de estado',
          'Mezclas y soluciones',
          'Ciclo del agua',
          'Cadena alimentaria',
          'Partes de la planta',
        ] },
        { name: 'Historia, Geografía y Ciencias Sociales', topics: [
          'Pueblos originarios de Chile',
          'Proceso de Independencia de Chile',
          'La globalización y sus efectos',
          'Geografía física de Chile',
          'Economía: oferta y demanda',
        ] },
        { name: 'Física', topics: [
          'Cinemática: velocidad y aceleración',
          'Leyes de Newton',
          'Trabajo y energía',
          'Ondas y sonido',
          'Electricidad: corriente y voltaje',
        ] },
        { name: 'Química', topics: [
          'Tabla periódica y propiedades',
          'Enlaces iónicos y covalentes',
          'Reacciones químicas: balanceo',
          'Estequiometría básica',
          'Ácidos, bases y pH',
        ] },
        { name: 'Biología', topics: [
          'Genética mendeliana',
          'Sistema Nervioso',
          'Sistema Inmunológico',
          'Fotosíntesis y respiración celular',
          'Ecosistemas y biodiversidad',
          'Evolución: selección natural',
        ] },
        { name: 'Educación Ciudadana', topics: [
          'Derechos y deberes ciudadanos',
          'Poderes del Estado',
          'Participación ciudadana',
          'Constitución y principios',
          'Democracia y representación',
        ] },
        { name: 'Filosofía', topics: [
          'Ética y dilemas morales',
          'Teorías del conocimiento',
          'Lógica proposicional',
          'Filosofía antigua: Sócrates y Platón',
          'Filosofía moderna: Descartes y Kant',
        ] },
      ];
      
      const demoTasks = ['Tarea','Evaluación','Prueba','Quiz','Proyecto'];
      const perSection = 8; // reducir para evitar superar cuota
      
      secPool.forEach((sec:any, si:number) => {
        const cid = String(sec?.courseId || sec?.course?.id || sec?.courseId);
        const sid = String(sec?.id || sec?.sectionId);
        const base = targetLevel === 'media' ? 78 : 82;
        
        // Garantizar cobertura: primeros slots para assignment/evaluation/test
        const ensuredKinds = ['Tarea','Evaluación','Prueba'];
        for (let i=0;i<perSection;i++) {
          const spanDays = Math.max(14, Math.floor((endTs - startTs)/day) || 14);
          const ts = startTs + Math.floor((i/(perSection-1))*spanDays)*day + Math.floor(rnd()*day*0.6);
          const student = availableStudents[Math.floor(rnd()*availableStudents.length)];
          const score = Math.round(Math.max(35, Math.min(100, base + (rnd()-0.5)*18 + (rnd()<0.1?-15:0))));
          
          // Seleccionar asignatura y tema (asegurando cobertura y variedad)
          const subj = subjectCatalog[((i * 2) + si) % subjectCatalog.length];
          const subjectName = subj.name;
          const topic = subj.topics[(i + si) % subj.topics.length];
          
          // Patrón cíclico para los últimos elementos: alterna Tarea/Evaluación/Prueba
          const nearEnd = i >= perSection - 6;
          const patternKind = (i % 3 === 0) ? 'Tarea' : ((i % 3 === 1) ? 'Evaluación' : 'Prueba');
          const taskKind = i < ensuredKinds.length ? ensuredKinds[i] : (nearEnd ? patternKind : demoTasks[Math.floor(rnd()*demoTasks.length)]);
          
          // Clasificación: Prueba/Quiz = test (índigo); Evaluación/Examen = evaluation (morado); resto = assignment (naranja)
          const isTest = /prueba|quiz/i.test(taskKind);
          const isEval = !isTest && /evaluaci|examen/i.test(taskKind);
          const taskType = isTest ? 'test' : (isEval ? 'evaluation' : 'assignment');
          
          // Título = tema de la asignatura para que "Tipo - Tema" sea claro en Actividad reciente
          const taskTitle = topic;
          
          newSubs.push({
            id: `demo-${Date.now()}-${si}-${i}-${Math.floor(rnd()*1e6)}`,
            taskId: `demo-task-${si}-${Math.floor(i/3)}-${taskType}`,
            studentUsername: student?.username || student?.id || `stu-${i}`,
            courseId: cid,
            sectionId: sid,
            score, // 0-100
            isGraded: true,
            // Campos extra para mostrar en Actividad reciente
            subject: subjectName,
            taskType,
            taskTitle,
            timestamp: ts,
          });
        }
      });

      // Guardar y notificar con poda y reintento ante cuota
      const MAX_ITEMS = 700; // límite para mantener tamaño controlado
      // Unir y ordenar por timestamp, quedarnos con los más recientes
      let merged = [...subs, ...newSubs].sort((a,b)=> (a.timestamp||0) - (b.timestamp||0));
      if (merged.length > MAX_ITEMS) merged = merged.slice(merged.length - MAX_ITEMS);
      
      const saveWithPrune = () => {
        let attempt = 0;
        let data = merged;
        while (attempt < 5) {
          try {
            const json = JSON.stringify(data);
            localStorage.setItem('smart-student-submissions', json);
            return true;
          } catch (e:any) {
            // Podar 20% de los más antiguos y reintentar
            const cut = Math.max(10, Math.floor(data.length * 0.2));
            data = data.slice(cut);
            attempt++;
          }
        }
        return false;
      };
      
      const saved = saveWithPrune();
      if (!saved) {
        console.warn('[demo] No fue posible guardar todas las submissions por cuota. Se continuará con el estado previo.');
      }
      
      // Disparar evento storage manual para refrescar memos
      try {
        const nowVal = localStorage.getItem('smart-student-submissions') || '[]';
        window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-submissions', newValue: nowVal }));
      } catch {}
      
      // Forzar re-cálculo local
  // demoTick eliminado
    } catch (e) {
      console.error('[loadDemoAdminStatsData] error', e);
    }
  };

  return (
    <div className="relative">
      {showLoader && (
        <div className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-background/95 shadow-xl p-6">
            <div className="text-center mb-4">
              <div className="text-sm text-muted-foreground mb-1">{t('loadingStatistics','Cargando estadísticas')}</div>
              <div className="text-3xl font-bold text-primary">{Math.round(loadProgress)}%</div>
            </div>
            <Progress value={loadProgress} className="h-2 mb-4" />
            
            {/* Lista de etapas de carga */}
            <div className="space-y-2 text-sm">
              {/* Etapa 1: Tarjetas de datos */}
              <div className={`flex items-center gap-2 ${loadingStage >= 1 ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {loadingStageReady[1] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : loadingStage === 1 ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <div className="w-4 h-4 border-2 border-muted-foreground/30 rounded-full" />
                )}
                <span>1. {t('loadingSimpleCards', 'Tarjetas de datos simples')}</span>
              </div>
              
              {/* Etapa 2: Promedios */}
              <div className={`flex items-center gap-2 ${loadingStage >= 2 ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {loadingStageReady[2] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : loadingStage === 2 ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <div className="w-4 h-4 border-2 border-muted-foreground/30 rounded-full" />
                )}
                <span>2. {t('loadingAverages', 'Promedios aprobados y reprobados')}</span>
              </div>
              
              {/* Etapa 3: Gráfico Asistencia */}
              <div className={`flex items-center gap-2 ${loadingStage >= 3 ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {loadingStageReady[3] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : loadingStage === 3 ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <div className="w-4 h-4 border-2 border-muted-foreground/30 rounded-full" />
                )}
                <span>3. {t('loadingAttendanceChart', 'Gráfico Asistencia')}</span>
              </div>
              
              {/* Etapa 4: Comparación de Cursos */}
              <div className={`flex items-center gap-2 ${loadingStage >= 4 ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {loadingStageReady[4] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : loadingStage === 4 ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <div className="w-4 h-4 border-2 border-muted-foreground/30 rounded-full" />
                )}
                <span>4. {t('loadingComparisonChart', 'Comparación de Cursos')}</span>
              </div>
              
              {/* Etapa 5: Gráfico Periodo */}
              <div className={`flex items-center gap-2 ${loadingStage >= 5 ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {loadingStageReady[5] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : loadingStage === 5 ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <div className="w-4 h-4 border-2 border-muted-foreground/30 rounded-full" />
                )}
                <span>5. {t('loadingPeriodChart', 'Asistencia - Periodo')}</span>
              </div>
              
              {/* Etapa 6: Insights IA */}
              <div className={`flex items-center gap-2 ${loadingStage >= 6 ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {loadingStageReady[6] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : loadingStage === 6 ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <div className="w-4 h-4 border-2 border-muted-foreground/30 rounded-full" />
                )}
                <span>6. {t('loadingInsights', 'Insights Rápidos (análisis IA)')}</span>
              </div>
            </div>
            
            {/* Mensaje de etapa actual */}
            <div className="mt-4 pt-3 border-t border-border">
              <div className="text-xs text-muted-foreground text-center">
                {loadingStageMessages[loadingStage] || t('pleaseWaitData','Preparando tarjetas y gráficos...')}
              </div>
            </div>
          </div>
        </div>
      )}
      <div id="teacher-stats-container" className={`space-y-6 transition-all duration-300 ${showLoader ? 'blur-sm opacity-70 pointer-events-none select-none scale-[0.99]' : ''}`} aria-busy={showLoader}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[hsl(var(--custom-rose-100))] text-[hsl(var(--custom-rose-800))] dark:bg-[hsl(var(--custom-rose-700))] dark:text-white">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('statisticsPageTitle', 'Estadísticas')}</h1>
            <p className="text-muted-foreground">
              {user?.role === 'admin' 
                ? t('statisticsPageSubAdmin', 'Análisis y métricas de rendimiento académico institucional')
                : t('statisticsPageSub', 'Análisis y métricas de tu gestión como profesor')
              }
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
            {/* Selector de Año (solo Admin) */}
            {user?.role === 'admin' && (
              <div className="flex items-center gap-1 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded px-2 py-1 relative">
                <button
                  onClick={() => changeYear(-1)}
                  disabled={availableYears.indexOf(selectedYear) <= 0}
                  className={`text-xs px-2 py-0.5 rounded border bg-transparent ${availableYears.indexOf(selectedYear) <= 0 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-rose-100 dark:hover:bg-rose-800/40'} text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700`}
                  title={t('previousYear','Año anterior')}
                  aria-label={t('previousYear','Año anterior')}
                >&lt;</button>
                <span className="text-xs font-semibold select-none min-w-[3.5rem] text-center" title={t('selectedYear','Año seleccionado')}>
                  {selectedYear}
                </span>
                <button
                  onClick={() => changeYear(1)}
                  disabled={availableYears.indexOf(selectedYear) >= availableYears.length - 1}
                  className={`text-xs px-2 py-0.5 rounded border bg-transparent ${availableYears.indexOf(selectedYear) >= availableYears.length - 1 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-rose-100 dark:hover:bg-rose-800/40'} text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700`}
                  title={t('nextYear','Año siguiente')}
                  aria-label={t('nextYear','Año siguiente')}
                >&gt;</button>
                {yearChanging && (
                  <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-rose-700 dark:text-rose-300 select-none flex items-center gap-2">
                    <span>{t('loadingYear','Cargando año')} {pendingYear}</span>
                    <div className="w-16 h-1 bg-rose-200 dark:bg-rose-800 rounded overflow-hidden">
                      <div className="h-full bg-rose-600" style={{ width: `${Math.round(yearChangeProgress)}%` }} />
                    </div>
                  </div>
                )}
                {/* Dropdown rápida para saltar a un año específico */}
                {/* Dropdown de años eliminado según requerimiento */}
              </div>
            )}
          {/* Indicador de backend activo (visible para todos) */}
          {(() => {
            const useFB = isFirebaseEnabled();
            const isGreen = useFB && firebaseHealthy === true;
            const title = useFB
              ? (firebaseHealthy === true ? 'Conectado a Firebase' : 'Firebase habilitado, sin conexión')
              : (isAttendanceSQLConnected
                ? 'Conectado a SQL local (IndexedDB)'
                : 'Sin conexión - Modo local');
            return (
              <div className="hidden sm:flex items-center gap-1.5" title={title}>
                <div className={`w-2.5 h-2.5 rounded-full ${isGreen ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
              </div>
            );
          })()}
          <Button className="home-card-button-green w-auto flex items-center gap-2" onClick={exportPDF}>
            <Download className="w-4 h-4" /> {t('download', 'Descargar')}
          </Button>
        </div>
      </div>

      {/* Filtros ADMIN (compactos, color diferenciado) */}
      {user?.role === 'admin' && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2" data-section>
          {/* Helper local: Badge cuadrado clickable */}
          {/* Nota: usamos div Badge con role=button para estilo consistente */}
          {/* Semestre */}
          <Card className="p-0 border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20">
            <CardContent className="p-3 flex flex-col items-start gap-2">
              <div className="text-xs text-rose-900 dark:text-rose-300">{t('filterSemester','Semestre')}</div>
              <div className="w-full grid grid-cols-2 gap-1.5">
                {(['S1','S2'] as Semester[]).map(s => (
                  <Badge
                    key={s}
                    role="button"
                    onClick={() => {
                      const togglingOff = semester === s;
                      if (togglingOff) {
                        // al quitar semestre no cambiamos periodo (queda como estaba)
                        setSemester('all');
                      } else {
                        // al activar semestre forzamos periodo a 'all' para mostrar rango completo
                        setSemester(s);
                        setPeriod('all');
                      }
                    }}
                    className={`cursor-pointer select-none w-full justify-center py-2 border !rounded-md ${semester === s ? 'bg-rose-600 text-white border-transparent' : 'bg-transparent text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700'}`}
                  >{s === 'S1' ? t('firstSemesterShort','1er') : t('secondSemesterShort','2do')}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Nivel */}
          <Card className="p-0 border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20">
            <CardContent className="p-3 flex flex-col items-start gap-2">
              <div className="text-xs text-rose-900 dark:text-rose-300">{t('levels','Niveles')}</div>
              <div className="w-full grid grid-cols-2 gap-1.5">
                {(['basica','media'] as Array<Level>).map(lv => (
                  <Badge
                    key={lv}
                    role="button"
                    onClick={() => {
                      setSelectedLevel(selectedLevel === lv ? 'all' : lv);
                      // Al cambiar nivel, reiniciar curso/sección admin
                      setAdminCourse('all');
                      setAdminSection('all');
                      setAdminSectionLetter('');
                    }}
                    className={`cursor-pointer select-none w-full justify-center py-2 border !rounded-md ${selectedLevel === lv ? 'bg-rose-600 text-white border-transparent' : 'bg-transparent text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700'}`}
                  >{lv === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media')}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Curso (aparece cuando Nivel != Todos) */}
          {(selectedLevel !== 'all') && (
            <Card className="p-0 border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20">
              <CardContent className="p-3 flex flex-col items-start gap-2">
                <div className="text-xs text-rose-900 dark:text-rose-300">{t('course','Curso')}</div>
                {/* Básica: 1°-4° fila 1, desde 5° en fila 2. Media: 1 fila. */}
                {(() => {
                  try {
                    const y = selectedYear;
                    const adminKey = y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses';
                    const userKey = y ? `smart-student-courses-${y}` : 'smart-student-courses';
                    let allCourses = [
                      ...JSON.parse(localStorage.getItem(adminKey) || '[]'),
                      ...JSON.parse(localStorage.getItem(userKey) || '[]')
                    ];
                    
                    // Fallback para año actual: usar datos legacy si no hay datos por año
                    if (allCourses.length === 0 && y === new Date().getFullYear()) {
                      allCourses = [
                        ...JSON.parse(localStorage.getItem('smart-student-admin-courses') || '[]'),
                        ...JSON.parse(localStorage.getItem('smart-student-courses') || '[]')
                      ];
                    }
                    // Helper: extraer número de grado desde etiqueta o palabras
                    const wordToNum: Record<string, number> = {
                      // Formas completas
                      'primero': 1, 'primer': 1,
                      'segundo': 2,
                      'tercero': 3,
                      'cuarto': 4,
                      'quinto': 5,
                      'sexto': 6,
                      'septimo': 7, 'séptimo': 7,
                      'octavo': 8,
                      // Formas con ordinal abreviado y variantes ya existentes
                      '1ero': 1, '1er': 1, '1º': 1, '1°': 1, '1ro': 1,
                      '2do': 2, '2º': 2, '2°': 2,
                      '3ro': 3, '3º': 3, '3°': 3,
                      '4to': 4, '4º': 4, '4°': 4,
                      '5to': 5, '5º': 5, '5°': 5,
                      '6to': 6, '6º': 6, '6°': 6,
                      '7mo': 7, '7º': 7, '7°': 7,
                      '8vo': 8, '8º': 8, '8°': 8,
                    };
                    const extractGrade = (source: string): number | undefined => {
                      if (!source) return undefined;
                      // Captura números posiblemente seguidos de sufijo ordinal español abreviado (ro,do,to,mo,vo)
                      const m = source.match(/\b(\d{1,2})(?:ro|do|to|mo|vo)?\b/);
                      if (m) {
                        const n = parseInt(m[1], 10);
                        if (!isNaN(n)) return n;
                      }
                      const low = source.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                      for (const key of Object.keys(wordToNum)) {
                        const k = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                        if (low.includes(k)) return wordToNum[key];
                      }
                      return undefined;
                    };
                    const ordinalUnified = (n: number): string => ({
                      1: '1ro', 2: '2do', 3: '3ro', 4: '4to', 5: '5to', 6: '6to', 7: '7mo', 8: '8vo'
                    } as Record<number,string>)[n] || `${n}º`;

                    const withNorm = allCourses.filter(c => {
                      if (!c?.id) return false;
                      const lvl = c?.level as Level | undefined;
                      return lvl === selectedLevel;
                    }).map(c => {
                      const source = (c?.gradeName || c?.fullName || c?.displayName || c?.longName || c?.label || c?.name || '') as string;
                      const grade = extractGrade(source);
                      // Normalizar etiqueta: usar "1ro/2do/..." + "Básico/Medio" (según nivel seleccionado)
                      const normalized = grade
                        ? `${ordinalUnified(grade)} ${selectedLevel === 'basica' ? 'Básico' : 'Medio'}`
                        : (source
                            .replace(/Primero|Primer|1º|1°|1er/gi, '1ro')
                            .replace(/Segundo|2º|2°/gi, '2do')
                            .replace(/Tercero|3º|3°/gi, '3ro')
                            .replace(/Cuarto|4º|4°/gi, '4to')
                            .replace(/Quinto|5º|5°/gi, '5to')
                            .replace(/Sexto|6º|6°/gi, '6to')
                            .replace(/S[eé]ptimo|7º|7°/gi, '7mo')
                            .replace(/Octavo|8º|8°/gi, '8vo')
                            .replace(/Basico/gi, 'Básico')
                            .replace(/Media/gi, 'Medio')
                          );
                      return { id: String(c.id), label: normalized, grade } as { id: string; label: string; grade?: number };
                    });
                    // Deduplicar por etiqueta normalizada por render
                    const seenLabels = new Set<string>();
                    const filtered = withNorm.filter(item => {
                      const key = `${selectedLevel}:${String(item.label).trim().toLowerCase()}`;
                      if (seenLabels.has(key)) return false;
                      seenLabels.add(key);
                      return true;
                    });

                    const renderBtn = (c: { id: string; label: string }) => (
                      <button
                        key={c.id}
                        className={`text-[11px] px-2 py-0.5 rounded border truncate max-w-[9rem] whitespace-nowrap ${adminCourse === c.id ? 'bg-rose-600 text-white border-transparent' : 'bg-transparent text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700'}`}
                        onClick={() => { adminCourse === c.id ? (setAdminCourse('all'), setAdminSection('all'), setAdminSectionLetter('')) : (setAdminCourse(c.id), setAdminSection('all'), setAdminSectionLetter('')); }}
                        title={c.label}
                      >{c.label}</button>
                    );

                    if (selectedLevel === 'basica') {
                      const row1 = filtered.filter(c => (c.grade ?? 0) > 0 && (c.grade as number) <= 4).sort((a,b)=> (a.grade||0)-(b.grade||0) || a.label.localeCompare(b.label,'es'));
                      const row2 = filtered.filter(c => (c.grade ?? 0) >= 5).sort((a,b)=> (a.grade||0)-(b.grade||0) || a.label.localeCompare(b.label,'es'));
                      
                      if (row1.length === 0 && row2.length === 0) {
                        return (
                          <div className="text-[10px] text-muted-foreground italic">
                            {t('noCoursesLevel','No hay cursos para este nivel en el año seleccionado')}
                          </div>
                        );
                      }
                      
                      return (
                        <>
                          <div className="w-full grid grid-rows-1 grid-flow-col auto-cols-max gap-1.5 overflow-x-auto pb-1">
                            {row1.map(renderBtn)}
                          </div>
                          <div className="w-full grid grid-rows-1 grid-flow-col auto-cols-max gap-1.5 overflow-x-auto pt-1">
                            {row2.map(renderBtn)}
                          </div>
                        </>
                      );
                    }

                    // Media: una sola fila horizontal
                    if (filtered.length === 0) {
                      return (
                        <div className="text-[10px] text-muted-foreground italic">
                          {t('noCoursesLevel','No hay cursos para este nivel en el año seleccionado')}
                        </div>
                      );
                    }
                    
                    return (
                      <div className="w-full grid grid-rows-1 grid-flow-col auto-cols-max gap-1.5 overflow-x-auto pb-1">
                        {filtered.sort((a,b)=> (a.grade||0)-(b.grade||0) || a.label.localeCompare(b.label,'es')).map(renderBtn)}
                      </div>
                    );
                  } catch (error) {
                    console.error('Error loading courses for year', selectedYear, error);
                    // Fallback: mostrar cursos simples del adminCourses memo
                    return (
                      <div className="w-full grid grid-rows-1 grid-flow-col auto-cols-max gap-1.5 overflow-x-auto pb-1">
                        {adminCourses.filter(c => c?.id && c?.label).map(c => (
                          <button
                            key={c.id}
                            className={`text-[11px] px-2 py-0.5 rounded border truncate max-w-[9rem] whitespace-nowrap ${adminCourse === c.id ? 'bg-rose-600 text-white border-transparent' : 'bg-transparent text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700'}`}
                            onClick={() => { adminCourse === c.id ? (setAdminCourse('all'), setAdminSection('all'), setAdminSectionLetter('')) : (setAdminCourse(c.id), setAdminSection('all'), setAdminSectionLetter('')); }}
                            title={c.label}
                          >{c.label}</button>
                        ))}
                        {adminCourses.length === 0 && (
                          <div className="text-[10px] text-muted-foreground italic">
                            {t('noCoursesYear','Sin cursos para este año')}
                          </div>
                        )}
                      </div>
                    );
                  }
                })()}
              </CardContent>
            </Card>
          )}

          {/* Sección (aparece cuando Curso != Todos) */}
          {(selectedLevel !== 'all' && adminCourse !== 'all') && (
            <Card className="p-0 border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20">
              <CardContent className="p-3 flex flex-col items-start gap-2">
                <div className="text-xs text-rose-900 dark:text-rose-300">{t('filterSection','Sección')}</div>
                <div className="w-full grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(8rem,1fr))]">
                  {(() => {
                    // 🔍 DEBUG: Log all available sections for this course
                    const y = selectedYear;
                    const secKeyAdmin = y ? `smart-student-admin-sections-${y}` : 'smart-student-admin-sections';
                    const secKeyUser = y ? `smart-student-sections-${y}` : 'smart-student-sections';
                    const allSectionsRaw = [
                      ...JSON.parse(localStorage.getItem(secKeyAdmin) || '[]'),
                      ...JSON.parse(localStorage.getItem(secKeyUser) || '[]')
                    ];
                    return null;
                  })()}
                  {adminSections
                    .filter(s => s?.id && s?.label)
                    .filter(s => {
                      try {
                        const y = selectedYear;
                        const secKeyAdmin = y ? `smart-student-admin-sections-${y}` : 'smart-student-admin-sections';
                        const secKeyUser = y ? `smart-student-sections-${y}` : 'smart-student-sections';
                        const courseKeyAdmin = y ? `smart-student-admin-courses-${y}` : 'smart-student-admin-courses';
                        const courseKeyUser = y ? `smart-student-courses-${y}` : 'smart-student-courses';
                        const sections = [...JSON.parse(localStorage.getItem(secKeyAdmin) || '[]'), ...JSON.parse(localStorage.getItem(secKeyUser) || '[]')];
                        const courses = [...JSON.parse(localStorage.getItem(courseKeyAdmin) || '[]'), ...JSON.parse(localStorage.getItem(courseKeyUser) || '[]')];
                        const sec = sections.find((x: any) => String(x?.id || x?.sectionId) === String(s.id));
                        if (!sec) return false;
                        const courseId = sec?.courseId || (sec?.course && (sec.course.id || sec.courseId));
                        if (!courseId) return false;
                        if (adminCourse === 'all') return true; // should not happen given container condition
                        return String(courseId) === String(adminCourse);
                      } catch { return false; }
                    })
                    .map(s => (
                      <Badge
                        key={`${s.id}-${s.sectionLetter || s.label}`}
                        role="button"
                        onClick={() => {
                          const isDeselecting = adminSection === s.id && adminSectionLetter === s.sectionLetter;
                          if (isDeselecting) {
                            setAdminSection('all');
                            setAdminSectionLetter('');
                          } else {
                            setAdminSection(s.id);
                            setAdminSectionLetter(s.sectionLetter || '');
                          }
                        }}
                        className={`cursor-pointer select-none w-full justify-center py-2 border !rounded-md ${(adminSection === s.id && adminSectionLetter === s.sectionLetter) ? 'bg-rose-600 text-white border-transparent' : 'bg-transparent text-rose-700 dark:text-rose-200 border-rose-300 dark:border-rose-700'}`}
                      >{(s.label || '').replace(/.*\bSecci[óo]n\s*/i, '') || s.label}</Badge>
                    ))}
                  {adminSections.filter(s=>s?.id && s?.label).length === 0 && (
                    <div className="text-[10px] col-span-full text-muted-foreground italic">{t('noSectionsYear','Sin secciones para este año')}</div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Indicador discreto de sincronización SQL (solo si no hay timeout y aún está cargando) */}
      {statsAPI.cached && (!sqlGradesReady || !sqlAttendanceReady) && !showLoader && !sqlLoadTimeout && (
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-50/60 dark:bg-blue-950/20 rounded text-blue-500 dark:text-blue-400 text-[10px] mb-1 opacity-70">
          <svg className="animate-spin h-2.5 w-2.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>Sincronizando...</span>
        </div>
      )}

      {/* KPIs debajo de los filtros: ahora dinámicos para admin y profesor */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-2" data-section>
        <Card className="select-none">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
              <Users className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <div className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-300">{dynamicKPIs.studentsCount ?? preloadKPIs?.studentsCount ?? '—'}</div>
                {statsAPI.cached && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0 h-auto bg-green-50 text-green-600 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800 ml-1">
                    📋 Cache
                  </Badge>
                )}
              </div>
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{t('students','Estudiantes')}</div>
              {statsAPI.loading && (
                <div className="text-[9px] text-blue-500 animate-pulse mt-1">Cargando datos optimizados...</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="select-none">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
              <GraduationCap className="w-6 h-6" />
            </div>
            <div>
              <div className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-300">{dynamicKPIs.coursesCount}</div>
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{t('coursesLabel','Cursos')}</div>
            </div>
          </CardContent>
        </Card>

        {/* Nueva tarjeta para cantidad de secciones (por año seleccionado) */}
        <Card className="select-none">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
              <Layers className="w-6 h-6" />
            </div>
            <div>
              <div className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-300">{dynamicKPIs.sectionsCount ?? 0}</div>
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{t('sections','Secciones')}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="select-none">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
              <UserCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-300">{dynamicKPIs.teachersCount}</div>
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{t('userManagementTeachers','Profesores')}</div>
            </div>
          </CardContent>
        </Card>

        {(adminSection === 'all' && subjectFilter === 'all') || semester !== 'all' || selectedLevel !== 'all' || adminCourse !== 'all' || adminSection !== 'all' || period ? (
          <Card className="select-none" title={
            (() => {
              let courseName = '';
              let sectionName = '';
              
              if (adminSection !== 'all') {
                // Hay filtro de sección específica
                try {
                  const read = (key: string): any[] => { 
                    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } 
                  };
                  const sections = [...read('smart-student-admin-sections'), ...read('smart-student-sections')];
                  const section = sections.find((s: any) => String(s?.id) === adminSection);
                  sectionName = section?.name || section?.fullName || section?.displayName || `Sección ${adminSection}`;
                } catch {
                  sectionName = `Sección ${adminSection}`;
                }
              } else if (adminCourse !== 'all') {
                // Hay filtro de curso específico
                try {
                  const read = (key: string): any[] => { 
                    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } 
                  };
                  const courses = [...read('smart-student-admin-courses'), ...read('smart-student-courses')];
                  const course = courses.find((c: any) => String(c?.id) === adminCourse);
                  courseName = course?.name || course?.fullName || course?.displayName || `Curso ${adminCourse}`;
                } catch {
                  courseName = `Curso ${adminCourse}`;
                }
              }
              
              const levelText = selectedLevel === 'basica' ? 'Básica' : selectedLevel === 'media' ? 'Media' : '';
              const semesterText = semester !== 'all' ? semester : '';
              const periodText = period === '7d' ? 'últimos 7 días' : period === '30d' ? 'últimos 30 días' : period === '90d' ? 'últimos 90 días' : period === 'all' ? 'período completo' : '';
              
              if (adminSection !== 'all') {
                // Hay filtro de sección específica
                if (period !== 'all' && periodText) return `Asistencia ${sectionName} - ${periodText} (días lectivos)`;
                if (semesterText) return `Asistencia ${semesterText} - ${sectionName} (días lectivos del semestre)`;
                return `Asistencia anual - ${sectionName} (días lectivos del calendario)`;
              } else if (adminCourse !== 'all') {
                // Hay filtro de curso específico
                if (period !== 'all' && periodText) return `Asistencia ${courseName} - ${periodText} (días lectivos)`;
                if (semesterText) return `Asistencia ${semesterText} - ${courseName} (días lectivos del semestre)`;
                return `Asistencia anual - ${courseName} (días lectivos del calendario)`;
              } else if (selectedLevel !== 'all') {
                // Hay filtro de nivel pero no curso
                if (period !== 'all' && periodText) return `Asistencia nivel ${levelText} - ${periodText} (días lectivos)`;
                if (semesterText) return `Asistencia ${semesterText} nivel ${levelText} (días lectivos del semestre)`;
                return `Asistencia anual nivel ${levelText} (días lectivos del calendario)`;
              } else if (semesterText) {
                // Solo hay filtro de semestre
                if (period !== 'all' && periodText) return `Asistencia ${semesterText} - ${periodText} (días lectivos)`;
                return `Asistencia ${semesterText} (todos los estudiantes, días lectivos del semestre)`;
              } else if (period !== 'all' && periodText) {
                // Solo hay filtro de período
                return `Asistencia general - ${periodText} (días lectivos del calendario)`;
              } else {
                // Sin filtros específicos o período "Todo"
                return "Asistencia anual general (todos los estudiantes, días lectivos del calendario)";
              }
            })()
          }>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-300">
                  {/* Si no hay datos de asistencia para los filtros aplicados, mostrar 0% */}
                  {dynamicKPIs._hasAttendanceData === false 
                    ? '0%' 
                    : (typeof dynamicKPIs.attendancePct === 'number' && dynamicKPIs.attendancePct > 0 
                      ? `${dynamicKPIs.attendancePct.toFixed(2)}%` 
                      : (typeof preloadKPIs?.attendancePct === 'number' && preloadKPIs.attendancePct > 0 
                        ? `${preloadKPIs.attendancePct.toFixed(2)}%` 
                        : '—'))}
                </div>
                <div className="text-[11px] tracking-wide text-muted-foreground uppercase flex flex-col leading-tight">
                  <span>{t('cardAttendanceTitle','Asistencia')}</span>
                  {typeof dynamicKPIs.attendanceDaysPeriodTotal === 'number' && dynamicKPIs.attendanceDaysPeriodTotal > 0 && (
                    <span className="text-[10px] font-normal normal-case text-emerald-600 dark:text-emerald-300/80">
                      {dynamicKPIs.attendanceDaysPeriodTotal} días lectivos {period === '7d' ? '(7 días)' : period === '30d' ? '(30 días)' : period === '90d' ? '(90 días)' : 'año'}
                    </span>
                  )}
                  {/* Mensaje cuando no hay datos de asistencia */}
                  {(dynamicKPIs._hasAttendanceData === false || (dynamicKPIs.attendancePct === 0 && dynamicKPIs._hasAttendanceData !== true)) && (
                    <span className="text-[9px] font-normal normal-case text-amber-500 dark:text-amber-400">
                      {t('noAttendanceData', 'Sin datos de asistencia cargados')}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

  {/* Filtros generales (oculto completo para admin salvo período que ya está arriba) */}
  {user?.role !== 'admin' && (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-section>
        {/* Curso del profesor (solo no admin) */}
        <Card className="select-none">
          <CardContent className="p-4 flex flex-col items-start gap-2">
            <div className="text-sm text-muted-foreground">{t('course', 'Curso')}</div>
            <div className="w-full flex flex-wrap gap-2">
              <button
                className={`text-xs px-2 py-1 rounded border ${selectedCourse === 'all' ? 'bg-[hsl(var(--custom-rose-700))] text-white border-transparent' : 'bg-transparent text-muted-foreground border-muted'}`}
                onClick={() => setSelectedCourse('all')}
              >{t('all', 'Todos')}</button>
              {teacherCourses.map(tc => (
                <button
                  key={tc.id}
                  className={`text-xs px-2 py-1 rounded border truncate max-w-[10rem] ${selectedCourse === tc.id ? 'bg-[hsl(var(--custom-rose-700))] text-white border-transparent' : 'bg-transparent text-muted-foreground border-muted'}`}
                  onClick={() => setSelectedCourse(tc.id)}
                  title={tc.label}
                >{tc.label}</button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Niveles (solo no admin; admin usa barra superior) */}
        <Card className="select-none">
          <CardContent className="p-4 flex flex-col items-start gap-2">
            <div className="text-sm text-muted-foreground">{t('levels', 'Niveles')}</div>
            <div className="w-full grid grid-cols-2 gap-2">
              <Badge
                role="button"
                onClick={() => setSelectedLevel('all')}
                className={`cursor-pointer select-none w-full justify-center py-2 border !rounded-md ${selectedLevel === 'all' ? 'bg-[hsl(var(--custom-rose-700))] text-white border-transparent' : 'bg-transparent text-muted-foreground border-muted'}`}
              >{t('all', 'Todos')}</Badge>
              {availableLevels.map(lv => (
                <Badge
                  key={lv}
                  role="button"
                  onClick={() => setSelectedLevel(lv)}
                  className={`cursor-pointer select-none w-full justify-center py-2 border !rounded-md ${selectedLevel === lv ? 'bg-[hsl(var(--custom-rose-700))] text-white border-transparent' : 'bg-transparent text-muted-foreground border-muted'}`}
                >{lv === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media')}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>

      </div>
  )}

    {/* Se eliminó un bloque duplicado de filtros ADMIN para evitar textos duros en español.
      Los filtros compactos superiores ya cubren Semestre/Curso/Sección con i18n. */}

      {/* Top KPIs (según requisitos admin) */}
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" data-section>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('approvedStudents', 'Estudiantes Aprobados')}</CardTitle>
          </CardHeader>
          <CardContent>
            {user?.role === 'admin' && subjectFilter !== 'all' ? (
              <div className="text-center py-4">
                <div className="text-2xl font-bold text-muted-foreground">—</div>
                <div className="text-xs text-muted-foreground mt-1">{t('removeFiltersToSeeApproved', 'Quita todos los filtros para ver estudiantes aprobados')}</div>
              </div>
            ) : (
              <>
                {(() => {
                  // Admin: cuando hay filtros activos, usar datos de studentAgg (calificaciones reales)
                  if (user?.role === 'admin') {
                    // 🔧 CORREGIDO: Usar studentAgg.totalStudents (estudiantes CON calificaciones)
                    // NO usar dynamicKPIs.studentsCount (estudiantes del catálogo)
                    const hasGradesData = studentAgg.totalStudents > 0;
                    
                    if (!hasGradesData) {
                      // No hay datos de calificaciones para los filtros seleccionados
                      return (
                        <div className="text-center py-2">
                          <div className="text-2xl font-bold text-muted-foreground">—</div>
                          <div className="text-[9px] text-amber-500">{t('noGradesData', 'Sin datos de calificaciones')}</div>
                        </div>
                      );
                    }
                    
                    // Usar los valores calculados de studentAgg
                    const approvedVal = studentAgg.approvedCount;
                    
                    return <div className="text-5xl font-extrabold text-emerald-400">{approvedVal > 0 ? approvedVal : '—'}</div>;
                  }

                  const approvedVal = stats.approvedCount ?? 0;
                  return <div className="text-5xl font-extrabold text-emerald-400">{approvedVal > 0 ? approvedVal : '—'}</div>;
                })()}
                {user?.role === 'admin' && studentAgg.totalStudents > 0 && (()=>{
                  const filterParts: string[] = [];
                  if (semester !== 'all') filterParts.push(semester === 'S1' ? t('firstSemester','1er Sem') : t('secondSemester','2do Sem'));
                  if (selectedLevel !== 'all') filterParts.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
                  if (adminCourse !== 'all') filterParts.push((adminCourses.find(c=> c.id === adminCourse)?.label) || t('course','Curso'));
                  if (adminSection !== 'all') filterParts.push((adminSections.find(s=> s.id === adminSection)?.label || t('section','Sección')).replace(/.*\bSecci[óo]n\s*/i,'Sección '));
                  if (period !== 'all' && selectedYear === 2025) filterParts.push(period);
                  // 🔧 CORREGIDO: Usar studentAgg.totalStudents (estudiantes con calificaciones)
                  const totalVal = studentAgg.totalStudents;
                  return (
                    <div className="mt-1 text-xs text-muted-foreground leading-snug">
                      <div className="whitespace-nowrap overflow-hidden text-ellipsis">≥ {getGradingConfig().passPercent ?? 60}% • {t('total','Total')}: {totalVal}</div>
                      {filterParts.length > 0 && (
                        <div className="whitespace-nowrap overflow-hidden text-ellipsis">{filterParts.join(' • ')}</div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('failedStudents', 'Estudiantes Reprobados')}</CardTitle>
          </CardHeader>
          <CardContent>
            {user?.role === 'admin' && subjectFilter !== 'all' ? (
              <div className="text-center py-4">
                <div className="text-2xl font-bold text-muted-foreground">—</div>
                <div className="text-xs text-muted-foreground mt-1">{t('removeFiltersToSeeFailures', 'Quita todos los filtros para ver estudiantes reprobados')}</div>
              </div>
            ) : (
              <>
                {(() => {
                  // Admin: usar studentAgg.failedCount directamente (ya está filtrado)
                  if (user?.role === 'admin') {
                    // 🔧 CORREGIDO: Verificar si hay datos de calificaciones
                    const hasGradesData = studentAgg.totalStudents > 0;
                    
                    if (!hasGradesData) {
                      return (
                        <div className="text-center py-2">
                          <div className="text-2xl font-bold text-muted-foreground">—</div>
                          <div className="text-[9px] text-amber-500">{t('noGradesData', 'Sin datos de calificaciones')}</div>
                        </div>
                      );
                    }
                    
                    const failedVal = studentAgg.failedCount;
                    return <div className="text-5xl font-extrabold text-blue-400">{failedVal > 0 ? failedVal : '—'}</div>;
                  }
                  
                  const failedVal = stats.failedCount ?? 0;
                  return <div className="text-5xl font-extrabold text-blue-400">{failedVal > 0 ? failedVal : '—'}</div>;
                })()}
                {user?.role === 'admin' && studentAgg.totalStudents > 0 && (()=>{
                  const filterParts: string[] = [];
                  if (semester !== 'all') filterParts.push(semester === 'S1' ? t('firstSemester','1er Sem') : t('secondSemester','2do Sem'));
                  if (selectedLevel !== 'all') filterParts.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
                  if (adminCourse !== 'all') filterParts.push((adminCourses.find(c=> c.id === adminCourse)?.label) || t('course','Curso'));
                  if (adminSection !== 'all') filterParts.push((adminSections.find(s=> s.id === adminSection)?.label || t('section','Sección')).replace(/.*\bSecci[óo]n\s*/i,'Sección '));
                  if (period !== 'all' && selectedYear === 2025) filterParts.push(period);
                  // 🔧 CORREGIDO: Usar studentAgg.totalStudents
                  const totalVal = studentAgg.totalStudents;
                  return (
                    <div className="mt-1 text-xs text-muted-foreground leading-snug">
                      <div className="whitespace-nowrap overflow-hidden text-ellipsis">&lt; {getGradingConfig().passPercent ?? 60}% • {t('total','Total')}: {totalVal}</div>
                      {filterParts.length > 0 && (
                        <div className="whitespace-nowrap overflow-hidden text-ellipsis">{filterParts.join(' • ')}</div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('avgAllStudents', 'Promedio Todos Estudiantes')}</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              // 🔧 CORREGIDO: Verificar si hay datos de calificaciones antes de mostrar promedio
              if (user?.role === 'admin') {
                const hasGradesData = studentAgg.totalStudents > 0;
                
                if (!hasGradesData) {
                  return (
                    <div className="text-center py-2">
                      <div className="text-2xl font-bold text-muted-foreground">—</div>
                      <div className="text-[9px] text-amber-500">{t('noGradesData', 'Sin datos de calificaciones')}</div>
                    </div>
                  );
                }
                
                const avgVal = typeof studentAgg.overallAvgPct === 'number' ? studentAgg.overallAvgPct : undefined;
                return (
                  <div className="text-5xl font-extrabold text-blue-300">
                    {typeof avgVal === 'number' ? `${avgVal.toFixed(1)}%` : '—'}
                  </div>
                );
              }
              
              // Non-admin
              const avgVal = typeof stats.avgScore20 === 'number' ? stats.avgScore20 * 5 : undefined;
              return (
                <div className="text-5xl font-extrabold text-blue-300">
                  {typeof avgVal === 'number' ? `${avgVal.toFixed(1)}%` : '—'}
                </div>
              );
            })()}
            {user?.role === 'admin' && studentAgg.totalStudents > 0 && (()=>{
              const filterParts: string[] = [];
              if (semester !== 'all') filterParts.push(semester === 'S1' ? t('firstSemester','1er Semestre') : t('secondSemester','2do Semestre'));
              if (selectedLevel !== 'all') filterParts.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
              if (adminCourse !== 'all') filterParts.push((adminCourses.find(c=> c.id === adminCourse)?.label) || t('course','Curso'));
              if (adminSection !== 'all') filterParts.push((adminSections.find(s=> s.id === adminSection)?.label || t('section','Sección')).replace(/.*\bSecci[óo]n\s*/i,'Sección '));
              if (period !== 'all' && selectedYear === 2025) filterParts.push(period);
              // 🔧 CORREGIDO: Usar studentAgg.totalStudents
              const totalVal = studentAgg.totalStudents;
              return (
                <div className="mt-1 text-xs text-muted-foreground leading-snug">
                  <div className="whitespace-nowrap overflow-hidden text-ellipsis">{t('overallAverageTotalPrefix','Promedio General • Total:')} {totalVal}</div>
                  {filterParts.length > 0 && (
                    <div className="whitespace-nowrap overflow-hidden text-ellipsis">{filterParts.join(' • ')}</div>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('topStudentAvg', 'Promedio Estudiantes Destacados')}</CardTitle>
          </CardHeader>
          <CardContent>
            {prioritizeCharts ? (
              <div className="h-12 rounded-md bg-muted/40 animate-pulse" />
            ) : (
              <>
                {(() => {
                  // 🔧 CORREGIDO: Verificar si hay datos de calificaciones antes de mostrar promedio destacados
                  if (user?.role === 'admin') {
                    const hasGradesData = studentAgg.totalStudents > 0;
                    
                    if (!hasGradesData) {
                      return (
                        <div className="text-center py-2">
                          <div className="text-2xl font-bold text-muted-foreground">—</div>
                          <div className="text-[9px] text-amber-500">{t('noGradesData', 'Sin datos de calificaciones')}</div>
                        </div>
                      );
                    }
                    
                    return (
                      <div className="text-5xl font-extrabold text-fuchsia-300">
                        {typeof studentAgg.standoutAvgPct === 'number' ? `${studentAgg.standoutAvgPct.toFixed(1)}%` : '—'}
                      </div>
                    );
                  }
                  
                  // Non-admin
                  return (
                    <div className="text-5xl font-extrabold text-fuchsia-300">
                      {typeof stats.topStudentAvg20 === 'number' ? `${(stats.topStudentAvg20*5).toFixed(1)}%` : '—'}
                    </div>
                  );
                })()}
              </>
            )}
            {user?.role === 'admin' && studentAgg.totalStudents > 0 && (()=>{
              const filterParts: string[] = [];
              if (semester !== 'all') filterParts.push(semester === 'S1' ? t('firstSemester','1er Semestre') : t('secondSemester','2do Semestre'));
              if (selectedLevel !== 'all') filterParts.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
              if (adminCourse !== 'all') filterParts.push((adminCourses.find(c=> c.id === adminCourse)?.label) || t('course','Curso'));
              if (adminSection !== 'all') filterParts.push((adminSections.find(s=> s.id === adminSection)?.label || t('section','Sección')).replace(/.*\bSecci[óo]n\s*/i,'Sección '));
              if (period !== 'all' && selectedYear === 2025) filterParts.push(period);
              const baseLine = studentAgg && (studentAgg as any).standoutIsFallbackTop
                ? t('bestAvailableAvgNoStandouts','Mejor promedio disponible • Sin destacados ≥ 90%')
                : `${t('gte90','≥ 90%')} • ${t('standouts','Destacados')}: ${studentAgg.standoutCount}`;
              return prioritizeCharts ? (
                <div className="mt-2 h-8 rounded bg-muted/30 animate-pulse" />
              ) : (
                <div className="mt-1 text-xs text-muted-foreground leading-snug">
                  <div className="whitespace-nowrap overflow-hidden text-ellipsis">{baseLine}</div>
                  {filterParts.length > 0 && (
                    <div className="whitespace-nowrap overflow-hidden text-ellipsis">{filterParts.join(' • ')}</div>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {/* Grid unificado de gráficos - se reorganiza automáticamente */}
      {/* 🚀 OPTIMIZACIÓN: Carga escalonada por chartsLoadPhase */}
      {(() => {
        const visibleCount = [showAttendanceChart, showQuickInsights, showComparisonChart, showPeriodChart].filter(Boolean).length;
        const gridCols = visibleCount === 0 ? 'grid-cols-1' : visibleCount === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2';
        return (
          <div className={`grid gap-4 ${gridCols} items-stretch`} data-section>
            {/* Gráfico temporal de asistencia conectado a Calendario - con Suspense para carga diferida */}
            {showAttendanceChart && chartsLoadPhase >= 2 && (
              <Suspense fallback={<AttendanceChartSkeleton />}>
                <LazyAttendanceTrendCard
                  period={period}
                  teacherUsername={user?.username || ''}
                  filters={(() => {
                    // Calcular nombre del curso para filtrado flexible
                    let courseName: string | undefined;
                    let sectionLetter: string | undefined;
                    
                    if (debouncedAdminCourse !== 'all') {
                      try {
                        const courses = [
                          ...JSON.parse(localStorage.getItem(`smart-student-admin-courses${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-admin-courses')||'[]'),
                          ...JSON.parse(localStorage.getItem(`smart-student-courses${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-courses')||'[]')
                        ];
                        const c = courses.find((x:any)=> String(x?.id||x?.courseId) === String(debouncedAdminCourse));
                        courseName = c?.shortName || c?.label || c?.gradeName || c?.displayName || c?.fullName || c?.name || '';
                      } catch {}
                    }
                    
                    if (debouncedAdminSection !== 'all') {
                      try {
                        const sections = [
                          ...JSON.parse(localStorage.getItem(`smart-student-admin-sections${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-admin-sections')||'[]'),
                          ...JSON.parse(localStorage.getItem(`smart-student-sections${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-sections')||'[]')
                        ];
                        const s = sections.find((x:any)=> String(x?.id||x?.sectionId) === String(debouncedAdminSection));
                        sectionLetter = (s?.shortName || s?.label || s?.name || '').replace(/.*\bSecci[óo]n\s*/i, '').trim();
                        if (!sectionLetter) sectionLetter = s?.letter;
                      } catch {}
                    }
                    
                    return {
                      semester: debouncedSemester !== 'all' ? debouncedSemester : undefined,
                      courseId: debouncedAdminCourse !== 'all' ? debouncedAdminCourse : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(0,-1).join('-') : undefined),
                      sectionId: debouncedAdminSection !== 'all' ? debouncedAdminSection : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(-1)[0] : undefined),
                      level: debouncedSelectedLevel !== 'all' ? debouncedSelectedLevel : undefined,
                      courseName,
                      sectionLetter,
                    };
                  })()}
                  blocked={attendanceBlockingFilters}
                  year={selectedYear}
                  sqlAttendanceByYear={sqlAttendanceByYear}
                  isAttendanceSQLConnected={isAttendanceSQLConnected}
                  preloadStats={preloadStats}
                  onChangePeriod={(p)=> setPeriod(p)}
                  titleSummary={(() => {
                    // Objetivo: "2do Semestre • 1ro Básico A" evitando repetir Nivel si ya está en el nombre del curso.
                    const bullets: string[] = [];
                    const semStr = semester !== 'all' ? (semester === 'S1' ? t('firstSemester', '1er Semestre') : t('secondSemester', '2do Semestre')) : '';
                    if (semStr) bullets.push(semStr.replace(' Semestre',' Sem'));

                    // Resolver etiquetas curso y sección
                    let courseLabel = '';
                    if (adminCourse !== 'all') {
                      try {
                        const courses = [
                          ...JSON.parse(localStorage.getItem(`smart-student-admin-courses${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-admin-courses')||'[]'),
                          ...JSON.parse(localStorage.getItem(`smart-student-courses${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-courses')||'[]')
                        ];
                        const c = courses.find((x:any)=> String(x?.id||x?.courseId) === String(adminCourse));
                        courseLabel = c?.shortName || c?.label || c?.gradeName || c?.displayName || c?.fullName || c?.name || '';
                      } catch {}
                    } else if (selectedCourse !== 'all') {
                      const tc = teacherCourses.find(t=> t.id === selectedCourse);
                      courseLabel = tc?.label || '';
                    }

                    // Obtener sección (sin palabra sección) y anexarla directo al curso
                    let secSuffix = '';
                    if (adminSection !== 'all') {
                      try {
                        const sections = [
                          ...JSON.parse(localStorage.getItem(`smart-student-admin-sections${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-admin-sections')||'[]'),
                          ...JSON.parse(localStorage.getItem(`smart-student-sections${selectedYear?'-'+selectedYear:''}`)||localStorage.getItem('smart-student-sections')||'[]')
                        ];
                        const s = sections.find((x:any)=> String(x?.id||x?.sectionId) === String(adminSection));
                        const secName = (s?.shortName || s?.label || s?.name || '').replace(/.*\bSecci[óo]n\s*/i, '');
                        if (secName) secSuffix = secName;
                      } catch {}
                    }

                    // Nivel solo si NO hay curso o el label no contiene 'básic'/'media'
                    if (!courseLabel && selectedLevel !== 'all') {
                      bullets.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
                    } else if (courseLabel) {
                      const lower = courseLabel.toLowerCase();
                      if (selectedLevel !== 'all' && !/básic|basic|medio|media/.test(lower)) {
                        bullets.push(selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media'));
                      }
                    }

                    if (courseLabel) {
                      bullets.push(`${courseLabel}${secSuffix ? ` ${secSuffix}` : ''}`.trim());
                    }

                    // Periodo (2025) al final si aplica
                    if (period !== 'all' && selectedYear === 2025) bullets.push(period);

                    return bullets.join(' • ');
                  })()}
                />
              </Suspense>
            )}
            {/* Skeleton mientras se carga el gráfico de asistencia */}
            {showAttendanceChart && chartsLoadPhase < 2 && <AttendanceChartSkeleton />}

        {showQuickInsights && chartsLoadPhase >= 3 && (
          <Suspense fallback={<InsightsSkeleton />}>
            <LazyInsightsCard
              insights={insights}
              aiInsights={aiInsights}
              isGeneratingInsights={isGeneratingInsights}
              insightsSync={insightsSync}
              prioritizeCharts={prioritizeCharts}
              onRefreshInsights={handleRefreshInsights}
            />
          </Suspense>
        )}
        {/* Skeleton mientras se cargan los insights */}
        {showQuickInsights && chartsLoadPhase < 3 && <InsightsSkeleton />}

        {/* Comparación de Cursos (líneas) - con Suspense para carga diferida */}
        {/* 🔧 CORREGIDO: Usar periodYear cuando comparisonType='asistencia' para sincronizar con gráfico Asistencia-Periodo */}
        {showComparisonChart && chartsLoadPhase >= 4 && (
          <Suspense fallback={<CourseComparisonSkeleton />}>
            <CourseComparisonChart 
              data={stats.comparisonDataPct ?? []} 
              filters={{
                courseSectionId: selectedCourse !== 'all' ? selectedCourse : undefined,
                level: debouncedSelectedLevel !== 'all' ? debouncedSelectedLevel as Level : undefined,
                courseId: debouncedAdminCourse !== 'all' ? debouncedAdminCourse : undefined,
                sectionId: debouncedAdminSection !== 'all' ? debouncedAdminSection : undefined,
                sectionLetter: debouncedAdminSectionLetter || undefined,  // 🔧 NUEVO: Pasar letra de sección
                semester: debouncedSemester !== 'all' ? debouncedSemester as Exclude<Semester, 'all'> : undefined,
              }}
              period={period}
              year={comparisonType === 'asistencia' ? periodYear : selectedYear}
              comparisonType={comparisonType}
              setComparisonType={setComparisonType}
              sqlGrades={sqlGradesByYear}
              isSQLConnected={isSQLConnected}
              sqlAttendance={sqlAttendanceByYear}
              isAttendanceSQLConnected={isAttendanceSQLConnected}
              preloadStats={preloadStats}
              loaderDone={!showLoader}
            />
          </Suspense>
        )}
        {/* Skeleton mientras se carga el gráfico de comparación */}
        {showComparisonChart && chartsLoadPhase < 4 && <CourseComparisonSkeleton />}

        {/* Calificaciones/Asistencia por Fecha (línea) - con Suspense para carga diferida */}
        {showPeriodChart && chartsLoadPhase >= 5 && (
          <Suspense fallback={<PeriodChartSkeleton />}>
            <Card className="relative overflow-hidden w-full">
              <CardHeader className="pt-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-lg font-semibold text-foreground">
                      {comparisonType === 'notas' 
                        ? t('gradesOverTimePeriod', 'Calificaciones - Periodo') 
                        : t('attendanceOverTimePeriod', 'Asistencia - Periodo')
                      }
                    </CardTitle>
                    <div className="mt-2 text-sm text-muted-foreground/80">
                  {(() => {
                    // Construir subtítulo dinámico con formato unificado
                    const parts: string[] = [];
                    
                    // 0. Promedios mensuales siempre primero
                    parts.push(t('monthlyAveragesPercent', 'Promedios mensuales (0–100%)'));
                    
                    // 1. Semestre (si existe)
                    if (semester !== 'all') {
                      const semLabel = semester === 'S1' ? t('firstSemester','1er Semestre') : t('secondSemester','2do Semestre');
                      parts.push(semLabel);
                    }
                    
                    // 2. Nivel/Curso/Sección (buscar información detallada)
                    try {
                      const courses: any[] = [];
                      const sections: any[] = [];
                      
                      // Cargar datos por año
                      const yearKeys = Object.keys(localStorage).filter(k => /^(smart-student-(admin-)?(courses|sections))-\d{4}$/.test(k));
                      yearKeys.forEach(k => {
                        try {
                          const arr = JSON.parse(localStorage.getItem(k) || '[]');
                          if (/courses-\d{4}$/.test(k) && Array.isArray(arr)) courses.push(...arr);
                          if (/sections-\d{4}$/.test(k) && Array.isArray(arr)) sections.push(...arr);
                        } catch {}
                      });
                      
                      if (adminSection !== 'all') {
                        // Si hay sección, mostrar curso completo + sección
                        const section = sections.find((s:any) => String(s?.id||s?.sectionId) === String(adminSection));
                        if (section) {
                          const courseId = section.courseId || (section.course && (section.course.id || section.courseId));
                          const course = courses.find((c:any) => String(c?.id) === String(courseId));
                          
                          if (course) {
                            // Formato: "1ro Básico A"
                            const gradeName = course.gradeName || course.name || course.label || '';
                            const sectionLetter = (section.name || section.label || section.displayName || '').replace(/.*\bSecci[óo]n\s*/i, '') || '';
                            const courseWithSection = `${gradeName}${sectionLetter ? ` ${sectionLetter}` : ''}`.trim();
                            if (courseWithSection) parts.push(courseWithSection);
                          }
                        }
                      } else if (adminCourse !== 'all') {
                        // Si hay curso pero no sección, mostrar solo el curso
                        const course = courses.find((c:any) => String(c?.id) === String(adminCourse));
                        if (course) {
                          const courseName = course.gradeName || course.name || course.label || '';
                          if (courseName) parts.push(courseName);
                        }
                      } else if (selectedLevel !== 'all') {
                        // Si solo hay nivel, mostrar Básica o Media
                        const levelStr = selectedLevel === 'basica' ? t('levelBasic','Básica') : t('levelHigh','Media');
                        parts.push(levelStr);
                      }
                    } catch {}
                  
                  const subtitle = parts.join(' • ');
                  return <span>{subtitle}</span>;
                })()}
                  </div>
                </div>
                
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Selector de año - Solo muestra años anteriores disponibles en el sistema */}
                  {availablePeriodYears.length > 0 ? (
                    <YearNavigator 
                      year={periodYear} 
                      onChange={setPeriodYear} 
                      minYear={Math.min(...availablePeriodYears)} 
                      maxYear={Math.max(...availablePeriodYears)} 
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground px-2 py-1 border rounded bg-muted/30">
                      {new Date().getFullYear()}
                    </span>
                  )}
                  
                  {/* Botón de zoom */}
                  <button
                    type="button"
                    onClick={() => setPeriodZoomY(z => !z)}
                    className={`inline-flex items-center justify-center rounded-lg border w-8 h-8 text-xs font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary ${
                      periodZoomY 
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90' 
                        : 'border-border/50 bg-background/60 text-foreground hover:border-primary/50 hover:bg-accent/50'
                    }`}
                    title={periodZoomY ? t('restoreScale','Restaurar escala') : t('zoomToData','Zoom a los datos')}
                    aria-label={periodZoomY ? t('restoreScale','Restaurar escala') : t('zoomToData','Zoom a los datos')}
                  >
                    {periodZoomY ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Para asistencia: reutilizar AttendanceTrendCard con el año anterior */}
              {comparisonType === 'asistencia' ? (
                /* Mostrar indicador de carga si los datos de periodYear aún no están disponibles */
                !sqlAttendanceReadyForPeriodYear ? (
                  <div className="flex flex-col">
                    <div className="relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4 h-[300px]">
                      <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                        <svg className="animate-spin h-10 w-10 mb-4 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span className="text-sm">Cargando datos de asistencia {periodYear}...</span>
                        <span className="mt-1 text-xs text-muted-foreground/70">Los datos se mostrarán en unos segundos</span>
                      </div>
                    </div>
                  </div>
                ) : (
                <div className="flex flex-col">
                  <Suspense fallback={<AttendanceChartSkeleton />}>
                  <LazyAttendanceTrendCard
                    period="all"
                    teacherUsername={user?.username || ''}
                    filters={{
                      semester: debouncedSemester !== 'all' ? debouncedSemester : undefined,
                      courseId: debouncedAdminCourse !== 'all' ? debouncedAdminCourse : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(0,-1).join('-') : undefined),
                      sectionId: debouncedAdminSection !== 'all' ? debouncedAdminSection : (selectedCourse !== 'all' ? selectedCourse.split('-').slice(-1)[0] : undefined),
                      level: debouncedSelectedLevel !== 'all' ? debouncedSelectedLevel : undefined,
                      // 🔧 NUEVO: Pasar nombre y letra para matching por nombre entre años
                      courseName: debouncedAdminCourse !== 'all' 
                        ? (adminCourses.find(c => c.id === debouncedAdminCourse)?.label || '') 
                        : (selectedCourse !== 'all' 
                            ? adminCourses.find(c => c.id === selectedCourse.split('-').slice(0,-1).join('-'))?.label 
                            : undefined),
                      sectionLetter: debouncedAdminSection !== 'all'
                        ? (adminSections.find(s => s.id === debouncedAdminSection)?.sectionLetter || '')
                        : (selectedCourse !== 'all'
                            ? adminSections.find(s => s.id === selectedCourse.split('-').slice(-1)[0])?.sectionLetter
                            : undefined),
                    }}
                    blocked={false}
                    year={periodYear}
                    sqlAttendanceByYear={sqlAttendanceByYear}
                    isAttendanceSQLConnected={isAttendanceSQLConnected}
                    preloadStats={null}
                    externalZoomY={periodZoomY}
                    onZoomChange={setPeriodZoomY}
                    hideHeader={true}
                  />
                  </Suspense>
                </div>
                )
              ) : (
                <GradesOverTimeChart 
                  monthlyPctByKey={stats.monthlyPctByKey || {}} 
                  semester={semester !== 'all' ? (semester as Exclude<Semester,'all'>) : undefined} 
                  comparisonType={comparisonType}
                  displayYear={periodYear}
                  onYearChange={setPeriodYear}
                  filters={{
                    semester: semester !== 'all' ? (semester as Exclude<Semester,'all'>) : undefined,
                    level: selectedLevel !== 'all' ? (selectedLevel as Level) : undefined,
                    courseId: adminCourse !== 'all' ? adminCourse : undefined,
                    sectionId: adminSection !== 'all' ? adminSection : undefined,
                    sectionLetter: adminSectionLetter || undefined,
                  }}
                  zoomY={periodZoomY}
                  sqlGrades={sqlGradesByYear}
                  isSQLConnected={isSQLConnected}
                  sqlAttendance={sqlAttendanceByYear}
                  isAttendanceSQLConnected={isAttendanceSQLConnected}
                />
              )}
              </CardContent>
            </Card>
          </Suspense>
        )}
          </div>
        );
      })()}

      {/* Controles al final */}
      {user?.role === 'admin' && (
        <div className="flex items-center justify-center gap-4 p-4 bg-gray-50 dark:bg-gray-900/20 border border-gray-200 dark:border-gray-800 rounded-lg mt-6" data-section>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('controls', 'Controles')}:
            </span>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Control para gráfico de asistencia */}
            <Button
              variant={showAttendanceChart ? "default" : "outline"}
              size="sm"
              onClick={() => setShowAttendanceChart(!showAttendanceChart)}
              className="flex items-center gap-2"
            >
              <Activity className="w-4 h-4" />
              {t('attendanceChart', 'Gráfico de Asistencia')}
            </Button>
            
            {/* Control para Insights Rápidos */}
            <Button
              variant={showQuickInsights ? "default" : "outline"}
              size="sm"
              onClick={() => setShowQuickInsights(!showQuickInsights)}
              className="flex items-center gap-2"
            >
              <BarChart3 className="w-4 h-4" />
              {t('quickInsights', 'Insights Rápidos')}
            </Button>
            
            {/* Control para gráfico de comparación */}
            <Button
              variant={showComparisonChart ? "default" : "outline"}
              size="sm"
              onClick={() => setShowComparisonChart(!showComparisonChart)}
              className="flex items-center gap-2"
            >
              <TrendingUp className="w-4 h-4" />
              {t('comparisonChart', 'Comparación Cursos')}
            </Button>
            
            {/* Control para gráfico de período */}
            <Button
              variant={showPeriodChart ? "default" : "outline"}
              size="sm"
              onClick={() => setShowPeriodChart(!showPeriodChart)}
              className="flex items-center gap-2"
            >
              <Clock className="w-4 h-4" />
              {comparisonType === 'notas' 
                ? t('gradesOverTimePeriod', 'Calificaciones - Periodo') 
                : t('attendanceOverTimePeriod', 'Asistencia - Periodo')
              }
            </Button>
          </div>
        </div>
      )}
    </div>
  </div>
  );
}
