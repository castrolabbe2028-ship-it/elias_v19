"use client";

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/language-context';
import {
  Settings as SettingsIcon,
  Users,
  Shield,
  Database,
  Key,
  RefreshCw,
  Download,
  Upload,
  AlertTriangle,
  CheckCircle,
  UserPlus,
  GraduationCap,
  Crown,
  Mail,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { LocalStorageManager, UsernameGenerator, EducationCodeGenerator, EducationAutomation } from '@/lib/education-utils';
import { getGradingConfig, toPercentFromConfigured } from '@/lib/grading';
import { getAllAvailableSubjects, getSubjectsForLevel, SubjectColor, getSubjectColor } from '@/lib/subjects-colors';
import { SystemConfig } from '@/types/education';
import { validateRut, cleanRut } from '@/lib/rut';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Progress } from '@/components/ui/progress';
import { UserFormDialog } from './UserFormDialog';
import NewYearDialog from './NewYearDialog';
import { useGradesSQL } from '@/hooks/useGradesSQL';
import GradesImportProgress from '@/components/admin/GradesImportProgress';
import GradesDeleteProgress from '@/components/admin/GradesDeleteProgress';
import { useAttendanceSQL } from '@/hooks/useAttendanceSQL';
// ✅ Nuevas importaciones para respaldo SQL completo en exportación
import { isSupabaseEnabled, isFirebaseEnabled, getCurrentProvider } from '@/lib/sql-config';
import { firestoreDB } from '@/lib/firestore-database';
import { sqlDB } from '@/lib/idb-sql';
// Tipado de progreso reutilizable para modales de carga (export/import)
import type { UploadProgress } from '@/hooks/useGradesSQL';
// 🔌 Bridge: expone utilidades SQL en window para scripts en /public
import { initializeSQL as __initializeSQL, isSQLConnected as __isSQLConnected, getSQLStatus as __getSQLStatus } from '@/lib/sql-init';
import { setForceIDB as __setForceIDB, isSupabaseEnabled as __isSupabaseEnabled } from '@/lib/sql-config';
import { sqlDatabase as __sqlDatabase } from '@/lib/sql-database';

export default function Configuration() {
  const { toast } = useToast();
  const { translate } = useLanguage();
  // Hooks de estado y refs necesarios antes de handlers que los usan
  const [config, setConfig] = useState<SystemConfig>({
    allowMultipleTeachersPerSubject: false,
    maxStudentsPerSection: 45,
    autoGenerateUsernames: true,
    defaultPasswordLength: 8,
    grading: undefined
  });
  const [isLoading, setIsLoading] = useState(false);
  const [selectedYear, setSelectedYear] = useState<number>(() => {
    const saved = Number(localStorage.getItem('admin-selected-year') || '');
    return Number.isFinite(saved) && saved > 0 ? saved : new Date().getFullYear();
  });
  const [availableYears, setAvailableYears] = useState<number[]>(() => LocalStorageManager.listYears());
  const [showGradesProgress, setShowGradesProgress] = useState(false);
  const [gradesProgress, setGradesProgress] = useState<{ current: number; total: number; created: number; errors: number; phase: string }>({ current: 0, total: 0, created: 0, errors: 0, phase: 'Esperando archivo' });
  const gradesImportCancelRef = useRef(false);
  // Estados para ventanas de progreso de Exportar / Importar
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportProgress, setExportProgress] = useState<UploadProgress | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importProgress, setImportProgress] = useState<UploadProgress | null>(null);
  
  // ====== SQL: estados y handlers aislados ======
  const {
    isConnected: isSQLConnected,
    uploadProgress: sqlProgress,
    isUploading: isSQLUploading,
    deleteProgress: sqlDeleteProgress,
    gradesCount,
    totalGrades,
    uploadGradesToSQL,
    uploadActivitiesToSQL,
    deleteGradesByYear: deleteSQLByYear,
    deleteAllGrades: deleteAllSQLGrades,
    clearAllSQLData,
    resetProgress,
    resetDeleteProgress,
    countGradesByYear,
    countAllGrades,
  } = useGradesSQL();
  const [showSQLModal, setShowSQLModal] = useState(false);
  // Overrides locales para reflejar contadores de Firebase obtenidos vía API Admin
  const [firebaseYearCountOverride, setFirebaseYearCountOverride] = useState<number | null>(null);
  const [firebaseTotalOverride, setFirebaseTotalOverride] = useState<number | null>(null);
  // Estados para Asistencia SQL
  const {
    isConnected: isAttendanceSQLConnected,
    uploadProgress: attSQLProgress,
    isUploading: isAttSQLUploading,
    deleteProgress: attDeleteProgress,
    attendanceCount: attYearCount,
    totalAttendance: attTotal,
    uploadAttendanceToSQL,
    deleteAttendanceByYear: deleteAttendanceSQLByYear,
    resetProgress: resetAttProgress,
    resetDeleteProgress: resetAttDeleteProgress,
    countAttendanceByYear,
    countAllAttendance,
    getAttendanceByYear: getAttendanceByYearSQL,
    clearAllAttendance,
  } = useAttendanceSQL();
  const [showAttendanceSQLModal, setShowAttendanceSQLModal] = useState(false);
  
  // Detección del proveedor de base de datos (Firebase/Supabase/IDB)
  const [dbProvider, setDbProvider] = useState<string>('');
  useEffect(() => {
    setDbProvider(getCurrentProvider());
  }, []);
  
  // Progreso de reinicio del sistema (eliminación)
  const [showResetProgressModal, setShowResetProgressModal] = useState(false);
  const [resetSystemProgress, setResetSystemProgress] = useState<{ phase: string; current: number; total: number }>({
    phase: 'Preparando…',
    current: 0,
    total: 13,
  });
  const [showResetConfirmDialog, setShowResetConfirmDialog] = useState(false);
  const [isResettingSystem, setIsResettingSystem] = useState(false);

  // Interceptor defensivo: normaliza a snake_case cualquier request REST a Supabase
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const g = window as any;
    if (g.__SB_FETCH_PATCHED__) return; // evitar duplicados
    try {
      const originalFetch = window.fetch.bind(window);
      const toSnake = (k: string) => k
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/__/g, '_')
        .toLowerCase();
      const normalizeObject = (obj: any, allowed?: Set<string>) => {
        if (!obj || typeof obj !== 'object') return obj;
        const out: any = {};
        for (const [k, v] of Object.entries(obj)) {
          const sk = toSnake(k);
          if (!allowed || allowed.has(sk)) out[sk] = v;
        }
        return out;
      };
      const allowedByTable: Record<string, Set<string>> = {
        grades: new Set(['id','test_id','student_id','student_name','score','course_id','section_id','subject_id','title','graded_at','year','type','created_at','updated_at']),
        activities: new Set(['id','task_type','title','subject_id','subject_name','course_id','section_id','created_at','start_at','open_at','due_date','status','assigned_by_id','assigned_by_name','year']),
        attendance: new Set(['id','date','course_id','section_id','student_id','status','present','comment','created_at','updated_at','year'])
      };
      const fixColumnsParam = (url: URL, table: keyof typeof allowedByTable) => {
        const raw = url.searchParams.get('columns');
        if (!raw) return;
        let txt = raw;
        try { txt = decodeURIComponent(raw); } catch { /* si ya viene decodificado */ }
        // Extraer columnas entre comillas o por coma
        let cols: string[] = [];
        const quoted = Array.from(txt.matchAll(/"([^"]+)"/g)).map(m => m[1]);
        if (quoted.length > 0) cols = quoted; else cols = txt.split(',').map(s => s.replace(/^["']|["']$/g,'').trim()).filter(Boolean);
        const snaked = cols.map(toSnake);
        const allowed = allowedByTable[table];
        const filtered = snaked.filter(c => allowed.has(c));
        const rebuilt = filtered.map(c => `"${c}"`).join(',');
        const before = txt;
        url.searchParams.set('columns', rebuilt);
        if (filtered.some(c => /[A-Z]/.test(c)) || /[A-Z]/.test(before)) {
          console.info(`[SQL-Guard] columns normalizado (${table}):`, before, '→', rebuilt);
        }
      };
      (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          const url = new URL(typeof input === 'string' ? input : (input as any).url, window.location.href);
          const isSB = /\.supabase\.co\/rest\/v1\//.test(url.href);
          if (isSB) {
            const m = url.pathname.match(/\/rest\/v1\/(grades|activities|attendance)/);
            const table = (m?.[1] || '') as keyof typeof allowedByTable;
            if (table && init && init.method && /POST|PATCH|PUT/i.test(init.method)) {
              // Normalizar body si es JSON array/objeto
              const ctype = (init.headers as any)?.['Content-Type'] || (init.headers as any)?.['content-type'] || '';
              if (ctype.includes('application/json') && init.body) {
                try {
                  const text = typeof init.body === 'string' ? init.body : (init.body as any);
                  const data = typeof text === 'string' ? JSON.parse(text) : text;
                  if (Array.isArray(data)) {
                    const allowed = allowedByTable[table];
                    const fixed = data.map(o => normalizeObject(o, allowed));
                    init = { ...init, body: JSON.stringify(fixed) };
                  } else if (data && typeof data === 'object') {
                    const allowed = allowedByTable[table];
                    const fixed = normalizeObject(data, allowed);
                    init = { ...init, body: JSON.stringify(fixed) };
                  }
                } catch {}
              }
              // Arreglar columns= en la URL si viniera en camelCase
              if (table) fixColumnsParam(url, table);
              const res = await originalFetch(url.toString(), init);
              return res;
            }
          }
        } catch {}
        return originalFetch(input as any, init);
      };
      g.__SB_FETCH_PATCHED__ = true;
      console.info('[SQL-Guard] fetch interceptor activo: normalización snake_case para grades/activities/attendance');
    } catch (e) {
      console.warn('[SQL-Guard] No se pudo activar interceptor fetch', e);
    }
  }, []);

  // Bridge global: hacer disponibles funciones SQL para scripts en /public
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const g: any = window;
        g.sqlGlobal = g.sqlGlobal || {};
        Object.assign(g.sqlGlobal, {
          initializeSQL: __initializeSQL,
          isSQLConnected: __isSQLConnected,
          getSQLStatus: __getSQLStatus,
          setForceIDB: __setForceIDB,
          isSupabaseEnabled: __isSupabaseEnabled,
          isFirebaseEnabled: isFirebaseEnabled,
          getCurrentProvider: getCurrentProvider,
          sqlDatabase: __sqlDatabase
        });
        // Pequeño log para confirmar bridge
        if (!g.__SQL_BRIDGE_READY__) {
          g.__SQL_BRIDGE_READY__ = true;
          console.info('[SQL-Bridge] Funciones SQL expuestas en window.sqlGlobal');
          console.info('[SQL-Bridge] Proveedor detectado:', getCurrentProvider());
        }
      }
    } catch (e) {
      console.warn('[SQL-Bridge] No se pudo exponer el bridge global', e);
    }
  }, []);

  // Cargar contadores de calificaciones SQL al inicio y cuando cambie el año
  useEffect(() => {
    if (isSQLConnected) {
      countGradesByYear(selectedYear);
      countAllGrades();
    }
    if (isAttendanceSQLConnected) {
      countAttendanceByYear(selectedYear);
      countAllAttendance();
    }
  }, [isSQLConnected, isAttendanceSQLConnected, selectedYear, countGradesByYear, countAllGrades, countAttendanceByYear, countAllAttendance]);

  
  // Utilidades auxiliares reintroducidas (stubs simplificados) para evitar errores de compilación tras refactor
  const safeGet = <T,>(key: string, fallback: T): T => {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return (v ?? fallback) as T; } catch { return fallback; }
  };
  const computeAttendanceSummary = (attendance: any[], year: number) => {
    // Calcular días hábiles (lunes-viernes) con registros y total de estudiantes únicos.
    // attendance esperada: { studentId, date|day|timestamp, present, year }
    const byDay = new Map<string, { present: number; total: number; students: Set<string> }>();
    const studentsAll = new Set<string>();
    const normYear = String(year);
    for (const r of attendance) {
      if (String(r.year) !== normYear) continue;
      const sid = String(r.studentId || r.sid || '').trim();
      if (!sid) continue;
      const tsRaw = r.timestamp || r.ts || r.date || r.day || r.fecha;
      let ts: number | null = null;
      if (typeof tsRaw === 'number') ts = tsRaw; else if (typeof tsRaw === 'string') {
        const n = Number(tsRaw); if (isFinite(n) && n > 10000000000) ts = n; else {
          const d = new Date(tsRaw); if (isFinite(d.getTime())) ts = d.getTime();
        }
      }
      if (!ts) continue;
      const d = new Date(ts);
      if (d.getFullYear() !== Number(year)) continue;
      const dow = d.getDay(); // 0=Domingo 6=Sabado
      if (dow === 0 || dow === 6) continue; // excluir fines de semana
      const dayKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      let entry = byDay.get(dayKey);
      if (!entry) { entry = { present: 0, total: 0, students: new Set() }; byDay.set(dayKey, entry); }
      if (!entry.students.has(sid)) { entry.total++; entry.students.add(sid); }
      if (r.present || r.asistencia === true || r.presente === true) {
        entry.present++;
      }
      studentsAll.add(sid);
    }
    const days = byDay.size;
    let present = 0, total = 0;
    for (const e of byDay.values()) { present += e.present; total += e.total; }
    const studentsCount = studentsAll.size;
    const percent = total ? (present / total) * 100 : 0;
    return { days, studentsCount, total, present, percent };
  };
  const inferYearFromRows = (rows: any[]): number | null => {
    for (const r of rows) { const y = Number(r?.year || r?.Year || r?.YEAR); if (y > 2000 && y < 3000) return y; }
    return null;
  };
  // Helper de traducción mejorado: si translate devuelve la misma clave, usar fallback
  const t = (k: string, fallback?: string) => {
    try {
      const val = translate ? translate(k) : undefined;
      if (val == null || val === '' || val === k) return fallback || k;
      return val;
    } catch { return fallback || k; }
  };
  const downloadGradesTemplate = () => {
    const headers = ['nombre','rut','curso','seccion','asignatura','tipo','fecha','nota'];
    const blob = new Blob([headers.join(',')+'\n'], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'plantilla-calificaciones.csv'; a.click();
  };

  // Normalizador de texto para arreglar mojibake de UTF-8 mal decodificado (ej: MatemÃ¡ticas → Matemáticas)
  const fixMojibake = (val: any): string => {
    try {
      let s = String(val ?? '');
      if (!s) return s;
      const map: Record<string, string> = {
        'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú',
        'Ã': 'Á', 'Ã‰': 'É', 'Ã': 'Í', 'Ã“': 'Ó', 'Ãš': 'Ú',
        'Ã±': 'ñ', 'Ã‘': 'Ñ', 'Ã¼': 'ü', 'Ãœ': 'Ü',
        'Â¿': '¿', 'Â¡': '¡', 'Â°': '°', 'Âº': 'º', 'Âª': 'ª',
      };
      // Reemplazar todas las apariciones conocidas
      const pattern = /(Ã¡|Ã©|Ã­|Ã³|Ãº|Ã|Ã‰|Ã|Ã“|Ãš|Ã±|Ã‘|Ã¼|Ãœ|Â¿|Â¡|Â°|Âº|Âª)/g;
      s = s.replace(pattern, (m) => map[m] || m);
      // Limpiezas adicionales comunes en CSVs con doble-espaciado
      s = s.replace(/\s+/g, ' ').trim();
      return s;
    } catch { return String(val ?? ''); }
  };

  // Parseo robusto de fechas disponible para todos los handlers (incluye serial Excel)
  const parseFechaCSV = (raw?: string | number): string => {
    try {
      if (raw == null) return new Date().toISOString();
      if (typeof raw === 'number' && isFinite(raw)) {
        // Serial de Excel ~ días desde 1899-12-30
        if (raw > 40000 && raw < 80000) {
          const epoch = new Date(Date.UTC(1899, 11, 30));
          const dt = new Date(epoch.getTime() + raw * 86400000);
          if (isFinite(dt.getTime())) return dt.toISOString();
        }
      }
      const val = String(raw).trim();
      if (!val) return new Date().toISOString();
      // DD-MM-YYYY o DD/MM/YYYY
      let m = val.match(/^([0-3]?\d)[\/\-]([0-1]?\d)[\/\-](\d{4})$/);
      if (m) {
        const d = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10) - 1;
        const y = parseInt(m[3], 10);
        const dt = new Date(y, mm, d, 12, 0, 0, 0);
        if (isFinite(dt.getTime())) return dt.toISOString();
      }
      // YYYY-MM-DD o YYYY/MM/DD
      m = val.match(/^(\d{4})[\-\/]([0-1]?\d)[\-\/]([0-3]?\d)$/);
      if (m) {
        const y = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10) - 1;
        const d = parseInt(m[3], 10);
        const dt = new Date(y, mm, d, 12, 0, 0, 0);
        if (isFinite(dt.getTime())) return dt.toISOString();
      }
      // Fallback: Date.parse
      const nat = new Date(val);
      if (isFinite(nat.getTime())) return nat.toISOString();
      return new Date().toISOString();
    } catch { return new Date().toISOString(); }
  };

  // ====== Funciones SQL para carga masiva ======
  const parseCSVforSQL = (text: string) => {
    // Normalizar saltos de línea SIN eliminar tildes/ñ (preservar nombres originales)
    // Cualquier corrección de mojibake se hará a nivel de campo con fixMojibake
    const cleanText = text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    const lines = cleanText.split('\n').filter(l => l.trim());
    
    // 🔧 DETECTAR DELIMITADOR AUTOMÁTICAMENTE
    const detectDelimiter = (line: string): string => {
      const delimiters = [';', ',', '\t', '|'];
      let maxCount = 0;
      let bestDelimiter = ',';
      
      for (const delim of delimiters) {
        const count = line.split(delim).length - 1;
        if (count > maxCount) {
          maxCount = count;
          bestDelimiter = delim;
        }
      }
      
      return bestDelimiter;
    };
    
    // Detectar delimitador de la primera línea
    const delimiter = lines.length > 0 ? detectDelimiter(lines[0]) : ',';
    console.log(`🔧 Delimitador CSV detectado: "${delimiter}" (${delimiter === ';' ? 'punto y coma' : delimiter === ',' ? 'coma' : delimiter === '\t' ? 'tabulador' : 'otro'})`);
    
    // Parser CSV mejorado que maneja comillas y caracteres especiales
    const parseCSVLine = (line: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      let i = 0;
      
      while (i < line.length) {
        const char = line[i];
        const nextChar = line[i + 1];
        
        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            // Comilla escapada
            current += '"';
            i += 2;
          } else {
            // Inicio o fin de comillas
            inQuotes = !inQuotes;
            i++;
          }
        } else if (char === delimiter && !inQuotes) {
          // Separador de columna (usa el delimitador detectado)
          result.push(current.trim());
          current = '';
          i++;
        } else {
          current += char;
          i++;
        }
      }
      
      // Agregar el último campo
      result.push(current.trim());
      
      // Limpiar comillas de los campos
      return result.map(field => {
        field = field.trim();
        if (field.startsWith('"') && field.endsWith('"')) {
          field = field.slice(1, -1).replace(/""/g, '"');
        }
        return field;
      });
    };
    
    if (lines.length === 0) {
      throw new Error('El archivo CSV está vacío');
    }
    
    // Parsear headers
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
    
    // Validar que hay headers
    if (headers.length === 0) {
      throw new Error('No se encontraron columnas en el archivo CSV');
    }
    
    // Parsear filas de datos
    const rows = lines.slice(1).map((line, index) => {
      const fields = parseCSVLine(line);
      const row: any = {};
      
      // Mapear campos a headers
      headers.forEach((header, i) => {
        row[header] = fields[i] || '';
      });
      
      // Validar que la fila tiene al menos algunos datos
      const hasData = Object.values(row).some(val => String(val).trim() !== '');
      if (!hasData && line.trim() !== '') {
        console.warn(`Fila ${index + 2} parece estar vacía o mal formateada: "${line}"`);
      }
      
      return row;
    });
    
    console.log(`📊 CSV parseado: ${headers.length} columnas, ${rows.length} filas`);
    console.log(`📋 Headers encontrados:`, headers);
    console.log(`📄 Primeras 3 filas:`, rows.slice(0, 3));
    
    return { headers, rows };
  };

  // Helper global: parsear JSON de localStorage con fallback sin lanzar excepción
  const safeParseLS = <T,>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const val = JSON.parse(raw);
      return (val ?? fallback) as T;
    } catch {
      return fallback;
    }
  };

  // Sondeo en segundo plano para refrescar contadores desde Firebase después de cargas largas
  // Útil cuando el proxy corta la respuesta (Content-Type nulo) pero el servidor sigue procesando.
  const getFirebaseCounters = async (year: number) => {
    try {
      const res = await fetch(`/api/firebase/grade-counters?year=${encodeURIComponent(year)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data?.yearCount === 'number') setFirebaseYearCountOverride(Number(data.yearCount));
      if (typeof data?.totalGrades === 'number') setFirebaseTotalOverride(Number(data.totalGrades));
      return { yearCount: Number(data?.yearCount || 0), total: Number(data?.totalGrades || 0) };
    } catch (e) {
      console.warn('[Counters] No se pudo obtener contadores desde API Firebase:', e);
      // Fallback a método actual
      const yr = await countGradesByYear(year);
      const tt = await countAllGrades();
      const yc = yr?.count ?? 0;
      const tot = tt?.total ?? 0;
      setFirebaseYearCountOverride(null);
      setFirebaseTotalOverride(null);
      return { yearCount: yc, total: tot };
    }
  };

  const pollGradesCountersAfterUpload = async (opts?: { timeoutMs?: number; intervalMs?: number }) => {
    const timeoutMs = opts?.timeoutMs ?? 12 * 60 * 1000; // 12 minutos
    const intervalMs = opts?.intervalMs ?? 15 * 1000; // 15s
    const start = Date.now();

    try {
      // Medir baseline
  const baseline = await getFirebaseCounters(selectedYear);
  let lastYear = baseline.yearCount;
  let lastTotal = baseline.total;

      console.log(`🔎 [Sondeo] Iniciando verificación de contadores. Baseline año ${selectedYear}: ${lastYear}, total: ${lastTotal}`);
      toast({ title: 'Verificando carga en segundo plano', description: 'Actualizando contadores desde Firebase...', variant: 'default' });

      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
  const now = await getFirebaseCounters(selectedYear);
  const y = now.yearCount;
  const t = now.total;
        console.log(`🔁 [Sondeo] Año ${selectedYear}: ${y} (antes ${lastYear}) • Total: ${t} (antes ${lastTotal})`);

        // Si detectamos incremento, damos por buena la carga
        if (y > lastYear || t > lastTotal) {
          toast({ title: 'Carga detectada en Firebase', description: `Año ${selectedYear}: ${y} • Total: ${t}`, variant: 'default' });
          console.log('✅ [Sondeo] Cambios detectados en contadores. Sincronizando a LocalStorage...');
          
          // 🔧 Sincronizar calificaciones desde Firebase a LocalStorage
          try {
            const { firestoreDB } = await import('@/lib/firestore-database');
            const grades = await firestoreDB.getGradesByYear(selectedYear);
            if (grades && grades.length > 0) {
              LocalStorageManager.setTestGradesForYear(selectedYear, grades, { preferSession: false });
              console.log(`✅ [Sondeo] Sincronizadas ${grades.length} calificaciones a LocalStorage`);
            }
          } catch (syncError) {
            console.error('⚠️ [Sondeo] Error sincronizando a LocalStorage:', syncError);
          }
          
          // Emitir evento para actualizar UI
          try { 
            window.dispatchEvent(new CustomEvent('sqlGradesUpdated', { 
              detail: { year: selectedYear, skipFirebaseReload: true } 
            })); 
          } catch {}
          
          return true;
        }
      }

      // Tiempo agotado, informar pero no como error crítico
      toast({ title: 'Verificación finalizada', description: 'No se detectaron cambios automáticos. Puedes usar "Actualizar" para forzar la lectura desde Firebase.', variant: 'default' });
      console.warn('⏱️ [Sondeo] Tiempo agotado sin cambios en contadores.');
      return false;
    } catch (e) {
      console.error('⚠️ [Sondeo] Error durante la verificación de contadores:', e);
      return false;
    }
  };

  const handleUploadGradesSQL = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target?.files?.[0]; 
    if (!file) return;
    
    try {
      setShowSQLModal(true);
      
      // 🔥 NUEVO: Detectar si Firebase está habilitado
      const useFirebase = process.env.NEXT_PUBLIC_USE_FIREBASE === 'true';
      
      if (useFirebase) {
        console.log('🔥 Firebase habilitado - Usando API para carga masiva');
        
        // Declarar la variable aquí para que esté disponible en todo el bloque
        let progressUnsubscribe: (() => void) | undefined = undefined;
        
        try {
          // Usar API endpoint con Firebase Admin SDK
          const formData = new FormData();
          formData.append('file', file);
          formData.append('year', String(selectedYear));
          
          // Generar un jobId único para monitorear el progreso
          const jobId = `import-grades-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          formData.append('jobId', jobId);
          
          console.log('📤 Preparando envío de archivo:', {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            year: selectedYear,
            jobId
          });
          
          // Inicializar con valores seguros para evitar NaN
          setGradesProgress({ current: 0, total: 100, created: 0, errors: 0, phase: 'Subiendo archivo a servidor...' });
          
          // 🔥 NUEVO: Configurar listener de progreso en tiempo real desde Firestore
          const setupProgressListener = async () => {
            try {
              // ✅ Verificar permisos de Firebase antes de intentar crear listener
              const { doc, onSnapshot, setDoc } = await import('firebase/firestore');
              const { getFirestoreInstance } = await import('@/lib/firebase-config');
              
              const db = getFirestoreInstance();
              if (!db) {
                console.warn('⚠️ Firestore no disponible para monitoreo de progreso');
                return;
              }
              
              console.log(`🎯 Configurando listener para documento: imports/${jobId}`);
              
              // Crear documento inicial para asegurar que existe
              const progressRef = doc(db, `imports/${jobId}`);
              
              // ✅ Intentar crear documento, ignorar si no hay permisos
              try {
                await setDoc(progressRef, {
                  processed: 0,
                  total: 0,
                  errors: 0,
                  percent: 0,
                  status: 'initializing',
                  message: 'Iniciando carga...',
                  createdAt: new Date().toISOString()
                });
                
                console.log('✅ Documento inicial creado en Firestore');
              } catch (permError: any) {
                if (permError.message?.includes('permission') || permError.code === 'permission-denied') {
                  console.warn('⚠️ Sin permisos para crear documento de progreso en Firestore (continuando sin monitoreo en tiempo real)');
                  return; // Salir sin configurar listener
                }
                throw permError; // Re-lanzar otros errores
              }
              
              progressUnsubscribe = onSnapshot(progressRef, (snapshot) => {
                console.log(`📡 Snapshot recibido: exists=${snapshot.exists()}, metadata.hasPendingWrites=${snapshot.metadata.hasPendingWrites}`);
                
                if (snapshot.exists()) {
                  const data = snapshot.data();
                  console.log('📊 RAW DATA desde Firestore:', JSON.stringify(data, null, 2));
                  
                  // Calcular el porcentaje real basado en los datos recibidos
                  const processed = Number(data.processed) || 0;
                  // El servidor puede escribir 'total' o 'totalRows'
                  const totalFromData = Number(data.total) || Number(data.totalRows) || 0;
                  const safTotal = totalFromData > 0 ? Math.max(totalFromData, processed) : (processed > 0 ? processed : 1);
                  const percent = data.percent || (safTotal > 0 ? Math.round((processed / safTotal) * 100) : 0);
                  
                  console.log(`🔢 Valores parseados: processed=${processed}, totalFromData=${totalFromData}, safTotal=${safTotal}, percent=${percent}`);
                  
                  const saved = Number((data as any).saved) || processed;
                  setGradesProgress({
                    current: saved,
                    total: safTotal,
                    created: saved,
                    errors: Number(data.errors) || 0,
                    phase: data.message || data.status || 'Procesando...'
                  });
                  
                  console.log(`📈 UI actualizada: ${percent}% (${processed}/${safTotal} registros, ${data.errors || 0} errores)`);
                  
                  // Si se completó, detener el listener después de un momento
                  if (data.status === 'completed' || data.status === 'failed') {
                    console.log('✅ Carga completada, cerrando listener en 2s...');
                    setTimeout(() => {
                      const unsub = progressUnsubscribe;
                      if (unsub && typeof unsub === 'function') {
                        try {
                          // @ts-ignore - TypeScript inference issue with callback cleanup
                          unsub();
                        } catch (err) {
                          console.warn('⚠️ Error al detener listener:', err);
                        }
                      }
                      progressUnsubscribe = undefined;
                    }, 2000);
                  }
                }
              }, (error) => {
                console.error('❌ Error en listener de progreso:', error);
              });
            } catch (error: any) {
              console.error('❌ Error configurando listener de progreso:', error);
              // ✅ Si es error de permisos, ignorar y continuar
              if (error.message?.includes('permission') || error.message?.includes('insufficient permissions') || error.code === 'permission-denied') {
                console.warn('⚠️ Sin permisos de Firebase (continuando sin monitoreo en tiempo real)');
              }
              // No lanzar error - el listener es opcional, la carga puede continuar sin él
            }
          };
          
          // Iniciar listener antes de enviar el archivo (NO bloquea si falla)
          // Usamos .catch() para que el error no detenga la carga principal
          setupProgressListener().catch((err) => {
            console.warn('⚠️ No se pudo configurar el listener de progreso en tiempo real:', err?.message || err);
            console.warn('⚠️ La carga continuará sin monitoreo en tiempo real');
          });
          
          console.log('📡 Enviando fetch a /api/firebase/bulk-upload-grades...');
          
          // Crear AbortController para timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
            console.error('⏱️ Request timeout después de 15 minutos');
          }, 900000); // 15 minutos timeout para archivos grandes (110K registros)
          
          let response;
          try {
            response = await fetch('/api/firebase/bulk-upload-grades', {
              method: 'POST',
              body: formData,
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
          } catch (fetchError: any) {
            clearTimeout(timeoutId);
            console.error('❌ Error en fetch:', fetchError);
            console.error('❌ Tipo de error:', fetchError.constructor?.name);
            console.error('❌ Mensaje:', fetchError.message);
            
            if (fetchError.name === 'AbortError') {
              throw new Error('La carga tomó demasiado tiempo y fue cancelada (timeout de 15 minutos). Para archivos muy grandes (>100K registros), considera dividirlos en partes más pequeñas.');
            }
            
            throw new Error(`Error de red al conectar con el servidor: ${fetchError.message}`);
          }
          
          console.log('📨 Respuesta recibida, status:', response.status);
          console.log('📨 Response headers:', {
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length')
          });

          // NOTA: En entornos con proxy (Codespaces) puede faltar Content-Type
          // No fallar por Content-Type nulo; intentamos parsear texto igualmente.
          const contentType = response.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            console.warn('⚠️ Respuesta sin Content-Type JSON. Intentando parseo por texto de todas formas...');
          }
          
          // 🔥 CRÍTICO: Clonar la respuesta antes de leerla para evitar "body stream already read"
          const responseClone = response.clone();
          
          if (!response.ok) {
            let errorMessage = 'Error al procesar la carga';
            let errorDetails = null;
            
            try {
              // Intentar parsear como JSON
              const error = await responseClone.json();
              errorMessage = error.error || error.message || errorMessage;
              errorDetails = error.details || null;
              console.error('❌ Error del servidor (JSON):', error);
            } catch (jsonError) {
              // Si falla JSON, intentar como texto
              try {
                const textError = await response.text();
                const textErrorPreview = (textError || '').slice(0, 200);
                
                // Detectar escenarios de proxy/gateway sin cuerpo utilizable
                const status = response.status;
                const isGatewayTimeoutLike = [0, 408, 499, 500, 502, 503, 504].includes(status);
                const noContent = !textError || textError.trim().length === 0;
                const ct = response.headers.get('content-type');
                const missingCT = !ct || ct.trim() === '';

                if ((isGatewayTimeoutLike && (noContent || missingCT)) || (missingCT && noContent)) {
                  console.warn('⚠️ Respuesta no OK sin cuerpo y/o sin Content-Type. Status:', status, 'Content-Type:', ct);
                  console.warn('⚠️ Asumiendo procesamiento en servidor. Iniciando sondeo, manteniendo modal abierto...');
                  toast({ title: 'Procesando en servidor', description: 'No se recibió respuesta. Verificando contadores desde Firebase...', variant: 'default' });
                  // Mantener la ventana de progreso abierta y actualizar el texto de fase
                  setGradesProgress(prev => ({
                    ...prev,
                    phase: 'Procesando en servidor... Monitoreando progreso desde Firebase'
                  }));
                  void pollGradesCountersAfterUpload();
                  // Limpiar input de archivo pero NO cerrar el modal
                  e.target.value = '';
                  return; // No lanzar error: dejamos que el listener/sondeo actualicen el estado
                }

                // Si hay contenido textual, usarlo como mensaje de error (solo log de warning, no error)
                if (textErrorPreview) {
                  console.warn('⚠️ Respuesta de texto:', textErrorPreview);
                } else {
                  console.warn('⚠️ Respuesta vacía recibida');
                }
                errorMessage = textError || errorMessage;
              } catch (textError) {
                console.warn('⚠️ No se pudo leer la respuesta:', textError);
              }
            }
            
            const fullErrorMessage = errorDetails 
              ? `${errorMessage}\n\nDetalles: ${errorDetails}`
              : errorMessage;
            
            throw new Error(fullErrorMessage);
          }
          
          console.log('📦 Parseando respuesta exitosa...');
          let result: any = null;
          let responseText = '';
          try {
            responseText = await response.text();
            console.log('📝 Respuesta en texto (primeros 200 chars):', responseText.substring(0, 200));
            if (responseText && responseText.trim().length > 0) {
              try { result = JSON.parse(responseText); } catch {}
            }
          } catch (parseError: any) {
            console.warn('⚠️ No se pudo leer el cuerpo de la respuesta:', parseError?.message || parseError);
          }

          if (!result) {
            // En ausencia de JSON válido, asumir procesamiento en servidor y activar sondeo
            console.warn('⚠️ Respuesta sin JSON válido. Mantener modal abierto para monitoreo de progreso...');
            setGradesProgress(prev => ({ ...prev, phase: 'Procesando en servidor... Monitoreando progreso...' }));
            // NO cerrar el modal - el listener de Firestore se encargará de actualizarlo
            e.target.value = '';
            return;
          }
          
          // 🔥 CAMBIO: No cerrar el modal inmediatamente - esperar a que el listener confirme finalización
          console.log('✅ Respuesta recibida del servidor:', result);
          setGradesProgress({ 
            current: (result.saved ?? result.processed) || 0, 
            total: (result.saved ?? result.processed) || 1, 
            created: (result.saved ?? result.processed) || 0, 
            errors: result.totalErrors || 0, 
            phase: 'Completado - Sincronizando datos...' 
          });
          
          toast({
            title: result.totalErrors > 0 ? 'Carga parcial completada' : 'Carga completada',
            description: result.message,
            variant: result.totalErrors > 0 ? 'destructive' : 'default'
          });
          
          // 🔥 IMPORTANTE: Actualizar contadores desde Firebase
          console.log('🔄 Actualizando contadores desde Firebase...');
          try {
            await getFirebaseCounters(selectedYear);
            console.log('✅ Contadores de Firebase actualizados correctamente');
          } catch (countError) {
            console.error('⚠️ Error al actualizar contadores:', countError);
            // No fallar si los contadores no se actualizan
          }
          
          // 🔧 IMPORTANTE: Sincronizar calificaciones desde Firebase a LocalStorage
          console.log('💾 Sincronizando calificaciones desde Firebase a LocalStorage...');
          try {
            const { firestoreDB } = await import('@/lib/firestore-database');
            const grades = await firestoreDB.getGradesByYear(selectedYear);
            if (grades && grades.length > 0) {
              LocalStorageManager.setTestGradesForYear(selectedYear, grades, { preferSession: false });
              console.log(`✅ Sincronizadas ${grades.length} calificaciones a LocalStorage`);
            } else {
              console.warn('⚠️ No se encontraron calificaciones en Firebase para sincronizar');
            }
          } catch (syncError) {
            console.error('⚠️ Error sincronizando a LocalStorage:', syncError);
          }
          
          // 🔧 Emitir evento para que la UI se actualice
          try { 
            window.dispatchEvent(new CustomEvent('sqlGradesUpdated', { 
              detail: { year: selectedYear, added: result.saved, skipFirebaseReload: true } 
            })); 
            console.log('📢 Evento sqlGradesUpdated emitido');
          } catch {}
          
          // Cerrar el modal después de un breve delay para que el usuario vea el 100%
          setTimeout(() => {
            setShowSQLModal(false);
            const unsub = progressUnsubscribe;
            if (unsub && typeof unsub === 'function') {
              try {
                // @ts-ignore - TypeScript inference issue with callback cleanup
                unsub();
              } catch (err) {
                console.warn('⚠️ Error al detener listener:', err);
              }
            }
          }, 2000);
          
          e.target.value = '';
          return;
        } catch (firebaseError: any) {
          const errorMsg = firebaseError?.message || 'Error desconocido al procesar el archivo';
          const isEmptyError = !errorMsg || errorMsg.trim() === '';
          
          if (!isEmptyError) {
            console.error('❌ Error en carga Firebase:', firebaseError);
          }
          
          toast({
            title: 'Error en carga masiva',
            description: isEmptyError ? 'Error de red o timeout. Verificando contadores en servidor...' : errorMsg,
            variant: 'destructive'
          });
          
          // Limpiar listener de progreso si existe
          const unsub = progressUnsubscribe;
          if (unsub && typeof unsub === 'function') {
            try {
              // @ts-ignore - TypeScript inference issue with callback cleanup
              unsub();
            } catch (err) {
              console.warn('⚠️ Error al limpiar listener:', err);
            }
          }
          
          // Incluso con error de respuesta, el servidor podría seguir procesando.
          // Activamos sondeo para reflejar cambios si ocurren.
          try {
            console.warn('🔁 Activando verificación de contadores tras error de respuesta...');
            void pollGradesCountersAfterUpload();
          } catch {}
          
          setShowSQLModal(false);
          
          // Solo lanzar el error si tiene contenido significativo
          if (!isEmptyError) {
            throw firebaseError;
          }
        }
      }
      
      // 📦 Modo SQL local (IndexedDB) - código original
      // Leer archivo con codificación UTF-8
      const text = await file.text();
      console.log(`📁 Archivo cargado: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
      
      const { headers, rows } = parseCSVforSQL(text);
      // Helper robusto para parsear JSON desde localStorage sin fallar
      const safeParseLS = <T,>(key: string, fallback: T): T => {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return fallback;
          const val = JSON.parse(raw);
          return (val ?? fallback) as T;
        } catch {
          return fallback;
        }
      };

      // Construir catálogos por año seleccionado para mapear a IDs internos
      const norm = (s: any) => String(s || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\bsecci[oó]n\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      const year = selectedYear;
  const courses = LocalStorageManager.getCoursesForYear(year) || [];
  const sections = LocalStorageManager.getSectionsForYear(year) || [];
  let subjects = LocalStorageManager.getSubjectsForYear(year) || [];
      const students = LocalStorageManager.getStudentsForYear(year) || [];
      const studentAssignments = LocalStorageManager.getStudentAssignmentsForYear(year) || [];
      const courseByName = new Map<string, any>(courses.map((c: any) => [norm(c.name), c] as const));
      const sectionsByCourse = new Map<string, any[]>(courses.map((c: any) => [String(c.id), sections.filter((s: any) => String(s.courseId) === String(c.id))]));
      const subjectByName = new Map<string, any>(subjects.map((s: any) => [norm(s.name), s] as const));

      // Asegurar que una asignatura exista en el catálogo del año; crearla si falta
      const ensureSubjectForYear = (nameRaw: string, courseId?: string | null) => {
        const name = fixMojibake(String(nameRaw || '').trim());
        if (!name) return null as any;
        const key = norm(name);
        let found = subjectByName.get(key);
        if (found) return found;
        try {
          const color = getSubjectColor(name);
          const now = new Date();
          const newSubject = {
            id: crypto.randomUUID(),
            uniqueCode: EducationCodeGenerator.generateSubjectCode(),
            name,
            abbreviation: color.abbreviation,
            description: `Asignatura generada automáticamente desde importación (${name})`,
            courseId: courseId ? String(courseId) : (courses[0]?.id ? String(courses[0].id) : ''),
            color: color.color,
            bgColor: color.bgColor,
            textColor: color.textColor,
            createdAt: now,
            updatedAt: now,
          } as any;
          subjects = [...subjects, newSubject];
          LocalStorageManager.setSubjectsForYear(year, subjects);
          subjectByName.set(key, newSubject);
          return newSubject;
        } catch {
          return null as any;
        }
      };
      const cleanRUT = (rut: string) => {
        try { return cleanRut(rut) || String(rut).replace(/\./g, '').toLowerCase(); } catch { return String(rut).replace(/\./g, '').toLowerCase(); }
      };
      const studentByRut = new Map<string, any>(students.map((s: any) => [cleanRUT(String(s.rut || '')), s] as const));
      const studentByName = new Map<string, any>(students.map((s: any) => [norm(s.displayName || s.name || s.username), s] as const));
      const sectionForStudent = (sid: string): string | null => {
        const asg = studentAssignments.find((a: any) => String(a.studentId) === String(sid) || String(a.studentUsername) === String(sid));
        return asg?.sectionId ? String(asg.sectionId) : null;
      };
      
      // Función helper mejorada para obtener valores
      const get = (obj: any, keys: string[]): string => {
        // Primero intentar coincidencia exacta (case-insensitive)
        for (const searchKey of keys) {
          const exactKey = Object.keys(obj).find(k => 
            String(k).toLowerCase().trim() === searchKey.toLowerCase()
          );
          if (exactKey && obj[exactKey]) {
            return String(obj[exactKey]).trim();
          }
        }
        
        // Si no hay coincidencia exacta, intentar con includes()
        const key = Object.keys(obj).find(k => 
          keys.some(searchKey => 
            String(k).toLowerCase().trim().includes(searchKey.toLowerCase())
          )
        );
        const value = key ? String(obj[key]).trim() : '';
        return value;
      };
      
      console.log(`🔍 Procesando ${rows.length} filas...`);
      console.log(`📚 Contexto del sistema:`);
      console.log(`  - Año seleccionado: ${year}`);
      console.log(`  - ${courses.length} cursos disponibles`);
      console.log(`  - ${students.length} estudiantes disponibles`);
      console.log(`  - ${subjects.length} asignaturas disponibles`);
      
      // 🚨 DIAGNÓSTICO: Ver headers reales del CSV
      if (rows.length > 0) {
        console.log(`🔬 HEADERS DEL CSV (primera fila):`, Object.keys(rows[0]));
        console.log(`🔬 VALORES DE LA PRIMERA FILA:`, rows[0]);
        console.log(`🔬 VALORES DE LA SEGUNDA FILA:`, rows[1]);
      }
      
      if (courses.length === 0) {
        console.error('❌ ERROR CRÍTICO: No hay cursos registrados para el año', year);
        toast({
          title: 'Error: Sin cursos',
          description: `No hay cursos registrados para el año ${year}. Crea cursos primero.`,
          variant: 'destructive'
        });
        setShowSQLModal(false);
        return;
      }
      
      if (students.length === 0) {
        console.error('❌ ERROR CRÍTICO: No hay estudiantes registrados para el año', year);
        toast({
          title: 'Error: Sin estudiantes',
          description: `No hay estudiantes registrados para el año ${year}. Importa estudiantes primero.`,
          variant: 'destructive'
        });
        setShowSQLModal(false);
        return;
      }
      
      console.log(`📋 Primeros 3 cursos:`, courses.slice(0, 3).map((c: any) => c.name));
      console.log(`👨‍🎓 Primeros 3 estudiantes:`, students.slice(0, 3).map((s: any) => s.name));
      
      // Para cargas masivas +100K, mostrar progreso y permitir que el navegador respire
      if (rows.length > 100000) {
        console.log(`⚡ [CARGA MASIVA] Detectadas ${rows.length} filas. Activando modo optimizado...`);
        toast({
          title: 'Carga masiva detectada',
          description: `Procesando ${rows.length.toLocaleString()} registros. Esto puede tomar varios minutos...`,
          duration: 5000
        });
      }

      // 1) Preproceso: normalizar filas y agrupar por actividad base (día/tipo/asignatura/curso/sección + hint opcional)
      type RowInfo = {
        rowNumber: number;
        student: any;
        courseId: string | null;
        sectionId: string | null;
        subjectId: string | null;
        subjectName: string;
        tipoNorm: 'tarea' | 'prueba' | 'evaluacion';
        fechaISO: string;
        dayKey: string;
        score: number;
        titleHint?: string;
        professorName?: string;
      };
      const groups = new Map<string, { baseKey: string; rows: RowInfo[] }>();
      const rowErrors: string[] = [];

      // Procesar filas con liberación de event loop para evitar congelamiento del navegador
      const BATCH_PROCESS_SIZE = 1000; // Procesar 1000 filas antes de liberar el event loop
      
      for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_PROCESS_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_PROCESS_SIZE, rows.length);
        const batchRows = rows.slice(batchStart, batchEnd);
        
        // Procesar el batch
        batchRows.forEach((row: any, batchIndex: number) => {
          const index = batchStart + batchIndex;
          const rowNumber = index + 2;
        // Campos base
        const nombre = get(row, ['nombre', 'name', 'estudiante', 'student', 'alumno']);
        const rut = get(row, ['rut', 'id', 'cedula', 'identificacion']);
        const curso = get(row, ['curso', 'course', 'grade', 'nivel', 'grado']);
        const seccion = get(row, ['seccion', 'sección', 'section', 'sala']);
        const asignatura = fixMojibake(get(row, ['asignatura', 'subject', 'materia', 'subject_name']));
        const fecha = get(row, ['fecha', 'date', 'timestamp']);
        const tipo = get(row, ['tipo', 'type', 'categoria', 'category']);
        const nota = get(row, ['nota', 'score', 'calificacion', 'grade', 'puntos', 'calificación']);
        const profesor = fixMojibake(get(row, ['profesor', 'teacher', 'docente', 'prof']));
        const titleHintRaw = get(row, ['actividad', 'titulo', 'título', 'detalle', 'descripcion', 'descripción', 'unidad', 'nro', 'numero', 'bloque', 'periodo', 'bloque_horario', 'hora']);

        if (index < 3) {
          console.log(`📝 Fila ${rowNumber}:`, { nombre, rut, curso, seccion, asignatura, fecha, tipo, nota, profesor, titleHintRaw });
          console.log(`📋 Headers del CSV:`, Object.keys(row));
          console.log(`📋 Valores completos de la fila:`, row);
        }

        // Validaciones básicas
        if (!nombre && !rut) { 
          if (index < 5) console.log(`❌ Fila ${rowNumber}: Falta Nombre o RUT`); 
          rowErrors.push(`Fila ${rowNumber}: Falta Nombre o RUT`); 
          return; 
        }
        if (!curso || !asignatura || !nota) { 
          if (index < 5) console.log(`❌ Fila ${rowNumber}: Falta Curso=${curso}, Asignatura=${asignatura}, Nota=${nota}`); 
          rowErrors.push(`Fila ${rowNumber}: Falta Curso/Asignatura/Nota`); 
          return; 
        }

        // Nota → 0..100 (robusto)
        const notaStrOrig = String(nota).trim();
        let s = notaStrOrig;
        // Detectar fracción o porcentaje
        const mFrac = s.match(/^(\d+(?:[\.,]\d+)?)\s*\/\s*(\d+(?:[\.,]\d+)?)/);
        const mPct = s.match(/(\d+(?:[\.,]\d+)?)\s*%/);
        let scoreNum: number | null = null;
        if (mFrac) {
          const num = parseFloat(mFrac[1].replace(',','.'));
          const den = parseFloat(mFrac[2].replace(',','.'));
          scoreNum = den > 0 ? (num/den)*100 : null;
        } else if (mPct) {
          scoreNum = parseFloat(mPct[1].replace(',','.'));
        } else {
          // Normalizar separadores: si hay . y , elegir el último como decimal
          const lastDot = s.lastIndexOf('.');
          const lastComma = s.lastIndexOf(',');
          if (lastDot !== -1 && lastComma !== -1) {
            if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
            else s = s.replace(/,/g, '');
          } else if (lastComma !== -1) {
            s = s.replace(/,/g, '.');
          }
          s = s.replace(/[^0-9.\-]/g, '');
          const raw = parseFloat(s);
          if (isFinite(raw)) {
            const conv = toPercentFromConfigured(raw);
            scoreNum = conv != null && isFinite(conv) ? conv : raw;
          }
        }
        if (scoreNum == null || !isFinite(scoreNum)) { rowErrors.push(`Fila ${rowNumber}: Nota inválida: ${notaStrOrig}`); return; }
        if (scoreNum > 1000) { rowErrors.push(`Fila ${rowNumber}: Nota inválida (demasiado alta): ${scoreNum}`); return; }
        if (scoreNum < 0 || scoreNum > 100) { rowErrors.push(`Fila ${rowNumber}: Nota fuera de rango (0-100): ${scoreNum}`); return; }

        // Fecha → ISO (robusto)
        const fechaISO = parseFechaCSV(fecha);
        const d = new Date(fechaISO);
        const dayKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

        // Mapear IDs
        const courseObj = curso ? courseByName.get(norm(curso)) : null;
        if (!courseObj) { rowErrors.push(`Fila ${rowNumber}: Curso no encontrado: ${curso}`); return; }
        const secs = sectionsByCourse.get(String(courseObj.id)) || [];
        const secObj = seccion ? secs.find((s: any) => norm(s.name) === norm(seccion)) : null;
        let subjObj = asignatura ? subjectByName.get(norm(asignatura)) : null;
        if (!subjObj && asignatura) {
          subjObj = ensureSubjectForYear(asignatura, courseObj?.id);
        }
        const studentObj = (function(){
          if (rut) {
            const byRut = studentByRut.get(cleanRUT(rut));
            if (byRut) return byRut;
          }
          return studentByName.get(norm(nombre));
        })();
        if (!studentObj) { rowErrors.push(`Fila ${rowNumber}: Estudiante no encontrado (${nombre || rut})`); return; }

        const sectionId = secObj?.id ? String(secObj.id) : (sectionForStudent(String(studentObj.id)) || null);
        const tipoNorm = ((tipo || 'tarea').toLowerCase().includes('tarea') ? 'tarea' : (String(tipo||'').toLowerCase().includes('prueba') ? 'prueba' : 'evaluacion')) as RowInfo['tipoNorm'];
        const titleHint = titleHintRaw ? norm(titleHintRaw) : '';
        const baseKey = `${tipoNorm}|${norm(asignatura)}|${courseObj?.id || ''}|${sectionId || ''}|${dayKey}|${titleHint}`;

        const info: RowInfo = {
          rowNumber,
          student: studentObj,
          courseId: courseObj?.id ? String(courseObj.id) : null,
          sectionId,
          subjectId: subjObj?.id ? String(subjObj.id) : (asignatura || null),
          subjectName: asignatura || (subjObj?.name ?? 'General'),
          tipoNorm,
          fechaISO,
          dayKey,
          score: Math.round(scoreNum * 100) / 100,
          titleHint: titleHint || undefined,
          professorName: profesor || undefined,
        };

        if (!groups.has(baseKey)) groups.set(baseKey, { baseKey, rows: [] });
        groups.get(baseKey)!.rows.push(info);
        });
        
        // Liberar el event loop cada BATCH_PROCESS_SIZE filas para evitar congelamiento
        if (batchEnd < rows.length) {
          // Mostrar progreso
          if (batchEnd % 10000 === 0 || batchEnd === rows.length) {
            console.log(`📊 Procesadas ${batchEnd}/${rows.length} filas (${((batchEnd/rows.length)*100).toFixed(1)}%)`);
          }
          // Pequeña pausa para liberar el navegador
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      
      console.log(`✅ Todas las ${rows.length} filas procesadas`);

      // 2) Para cada grupo base, crear instancias secuenciales por ocurrencia (i1, i2, ...)
      const grades: any[] = [];
      const activities: any[] = [];
      groups.forEach(({ baseKey, rows }) => {
        // Hash base + construir mapa por estudiante
        const hash = (() => { let h = 0; for (const c of baseKey) { h = (h*31 + c.charCodeAt(0)) >>> 0; } return h.toString(36); })();
        const byStudent = new Map<string, RowInfo[]>();
        rows.forEach(r => {
          const sid = String(r.student.id);
          if (!byStudent.has(sid)) byStudent.set(sid, []);
          byStudent.get(sid)!.push(r);
        });
        // Orden por fecha de fila (aunque todas comparten día, mantiene consistencia)
        byStudent.forEach(list => list.sort((a,b)=> a.fechaISO.localeCompare(b.fechaISO)));
        const maxOcc = Math.max(1, ...Array.from(byStudent.values()).map(v => v.length));
        for (let occ = 1; occ <= maxOcc; occ++) {
          const testId = occ === 1 ? `sql-${hash}` : `sql-${hash}-i${occ}`;
          let activityCreated = false;
          byStudent.forEach((list, studentId) => {
            const r = list[occ-1];
            if (!r) return;
            const student = r.student;
            const rec = {
              id: `${testId}-${student.id}`,
              testId,
              studentId: String(student.id),
              studentName: student.displayName || student.name || student.username,
              score: r.score,
              courseId: r.courseId,
              sectionId: r.sectionId,
              subjectId: r.subjectId,
                title: `${r.tipoNorm}: ${r.subjectName}` + (occ>1 ? ` #${occ}` : ''),
              gradedAt: r.fechaISO,
              year: selectedYear,
              type: r.tipoNorm,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            grades.push(rec);
            if (!activityCreated) {
              activities.push({
                id: testId,
                taskType: r.tipoNorm,
                title: `${r.tipoNorm}: ${r.subjectName}` + (occ>1 ? ` #${occ}` : ''),
                subjectId: r.subjectId,
                subjectName: r.subjectName,
                courseId: r.courseId,
                sectionId: r.sectionId,
                createdAt: r.fechaISO,
                startAt: r.fechaISO,
                openAt: r.fechaISO,
                dueDate: r.fechaISO,
                status: r.tipoNorm === 'evaluacion' ? 'completed' : 'finished',
                assignedById: 'system',
                assignedByName: r.professorName || 'System',
                year: selectedYear,
              });
              activityCreated = true;
            }
          });
        }
      });

      if (rowErrors.length) {
        console.warn(`⚠️ Filas con error: ${rowErrors.length}`);
        console.warn(`📋 Primeros 10 errores:`, rowErrors.slice(0, 10));
      }
      console.log(`✅ ${grades.length} calificaciones procesadas correctamente`);
      console.log(`🫧 ${activities.length} actividades generadas`);
      
      if (grades.length === 0) {
        toast({
          title: 'No se procesaron calificaciones',
          description: `No se pudieron procesar las calificaciones. Errores: ${rowErrors.length}. Revisa la consola para más detalles.`,
          variant: 'destructive'
        });
        setShowSQLModal(false);
        return;
      }

      // 3) Enviar a SQL: primero actividades, luego calificaciones
      console.log(`📤 Enviando ${activities.length} actividades y ${grades.length} calificaciones a SQL...`);
      
      // Enviar directamente sin chunking en el componente - el hook maneja la optimización
      if (activities.length > 0) {
        await uploadActivitiesToSQL(activities as any);
      }
      
      if (grades.length > 0) {
        await uploadGradesToSQL(grades as any);
      }
      
      // 🔧 IMPORTANTE: Guardar también en LocalStorage para que aparezcan en la UI inmediatamente
      try {
        console.log(`💾 Guardando ${grades.length} calificaciones en LocalStorage...`);
        const existingGrades = LocalStorageManager.getTestGradesForYear(selectedYear) || [];
        const existingIds = new Set(existingGrades.map((g: any) => g.id));
        
        // Solo agregar calificaciones que no existen
        const newGrades = grades.filter((g: any) => !existingIds.has(g.id));
        const mergedGrades = [...existingGrades, ...newGrades];
        
        LocalStorageManager.setTestGradesForYear(selectedYear, mergedGrades, { preferSession: false });
        console.log(`✅ Guardadas ${newGrades.length} nuevas calificaciones en LocalStorage (total: ${mergedGrades.length})`);
      } catch (lsError) {
        console.warn('⚠️ Error guardando en LocalStorage:', lsError);
      }
      
      // Emitir evento para que la UI se actualice
      try { 
        window.dispatchEvent(new CustomEvent('sqlGradesUpdated', { 
          detail: { year: selectedYear, added: grades.length, skipFirebaseReload: true } 
        })); 
      } catch {}
      
      try { window.dispatchEvent(new CustomEvent('sqlActivitiesUpdated', { detail: { year: selectedYear, added: activities.length } })); } catch {}
      toast({
        title: rowErrors.length ? 'Carga parcial completada' : 'Carga completada',
        description: `Calificaciones importadas: ${grades.length}. Errores: ${rowErrors.length}`,
        variant: rowErrors.length ? 'destructive' : 'default'
      });
      
    } catch (e: any) {
      console.error('❌ Error en carga SQL:', e);
      toast({ 
        title: 'Error en carga SQL', 
        description: e?.message || 'Revisa el formato del archivo CSV', 
        variant: 'destructive' 
      });
      setShowSQLModal(false);
    } finally {
      e.target.value = '';
    }
  };
  const exportStudentAssignmentsExcel = async () => {
    // Genera un CSV de "asignaciones": una fila por estudiante matriculado en una sección
    // para cada asignatura asignada a esa sección vía profesor.
    try {
      const year = selectedYear;
      const students = LocalStorageManager.getStudentsForYear(year) || [];
      const teachers = LocalStorageManager.getTeachersForYear(year) || [];
      const courses = LocalStorageManager.getCoursesForYear(year) || [];
      const sections = LocalStorageManager.getSectionsForYear(year) || [];
      const teacherAssignments = LocalStorageManager.getTeacherAssignmentsForYear(year) || [];

      // Mapas de ayuda
  const courseById = new Map<string, any>(courses.map((c:any)=> [String(c.id), c]));
  const sectionById = new Map<string, any>(sections.map((s:any)=> [String(s.id), s]));
  const teacherById = new Map<string, any>(teachers.map((t:any)=> [String(t.id), t]));

      // Índice: estudiantes por sección
  const studentsBySection = new Map<string, any[]>();
      for (const s of students) {
        if (!s.sectionId) continue;
        if (!studentsBySection.has(s.sectionId)) studentsBySection.set(s.sectionId, []);
        studentsBySection.get(s.sectionId)!.push(s);
      }

      // Filas del CSV
      const headers = ['Nombre','RUT','Curso','Sección','Asignatura','Profesor'];
      const rows: string[][] = [];

      // Para cada asignación profesor-sección-asignatura, emitir una fila por estudiante de esa sección
      for (const a of teacherAssignments) {
  const section = sectionById.get(String(a.sectionId)) as any;
  const course = section ? (courseById.get(String(section.courseId)) as any) : null;
  const teacher = teacherById.get(String(a.teacherId)) as any;
        const subject = a.subjectName || '';
        if (!section || !course || !teacher) continue;

  const studentsInSection = studentsBySection.get(String(section.id)) || [];
        for (const st of studentsInSection) {
          rows.push([
            st.name || '',
            st.rut || '',
            course.name || '',
            section.name || '',
            subject,
            teacher.name || teacher.username || ''
          ]);
        }
      }

      // Si no hay filas, avisar
      if (rows.length === 0) {
        toast({
          title: t('noAssignmentsFound','Sin asignaciones'),
          description: t('noAssignmentsFoundDesc','No se encontraron asignaciones de profesores o estudiantes en secciones para este año.'),
          variant: 'destructive'
        });
        return;
      }

      // Exportar como XLSX con columnas separadas
      const XLSX = await import('xlsx');
      const aoa = [headers, ...rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Opcional: auto-filtro y anchos de columna
      ws['!autofilter'] = { ref: `A1:F${rows.length + 1}` } as any;
      ws['!cols'] = [
        { wch: 22 }, // Nombre
        { wch: 14 }, // RUT
        { wch: 14 }, // Curso
        { wch: 9 },  // Sección
        { wch: 22 }, // Asignatura
        { wch: 22 }, // Profesor
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `Asignaciones ${year}`);
      XLSX.writeFile(wb, `asignaciones-${year}.xlsx`);

      toast({
        title: t('downloadAssignments','Descargar Asignaciones'),
        description: (t('assignmentsGenerated','Asignaciones generadas') + `: ${rows.length}`),
      });
    } catch (e) {
      console.error('[EXPORT ASSIGNMENTS] Error:', e);
      toast({ title: t('error','Error'), description: t('couldNotExport','No se pudo generar el archivo de asignaciones'), variant: 'destructive' });
    }
  };

  // === Nueva: Importar Calificaciones desde CSV a smart-student-test-grades ===
  const handleBulkGradesUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      // Leer archivo CSV
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      if (lines.length === 0) return;
      
      // Parsear CSV manualmente para manejar comas dentro de comillas
      const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      };
      
      // Obtener headers y datos
      const headers = parseCSVLine(lines[0]);
      const rows: any[] = lines.slice(1).map(line => {
        const values = parseCSVLine(line);
        const row: any = {};
        headers.forEach((header, index) => {
          row[header] = values[index] || '';
        });
        return row;
      });

  // === OPTIMIZADO: procesamiento batch + Map O(1) para deduplicación ===
  const startTime = performance.now();
  gradesImportCancelRef.current = false;
  setGradesProgress({ current: 0, total: rows.length, created: 0, errors: 0, phase: 'Procesando' });
  setShowGradesProgress(true);

  const normalize = (s: string) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[º°]/g, '').replace(/(\d+)\s*(ro|do|to)/g, '$1')
    .replace(/\s+/g, ' ').trim();
  const get = (obj: any, aliases: string[]) => {
    const key = Object.keys(obj).find(k => aliases.includes(String(k).trim().toLowerCase()));
    return key ? String(obj[key]).trim() : '';
  };

  const year = selectedYear;
  const courses = LocalStorageManager.getCoursesForYear(year) || [];
  const sections = LocalStorageManager.getSectionsForYear(year) || [];
  let subjects = LocalStorageManager.getSubjectsForYear(year) || [];
  const students = LocalStorageManager.getStudentsForYear(year) || [];

  const courseByName = new Map<string, any>(courses.map((c: any) => [normalize(c.name), c] as const));
  const sectionsByCourse = new Map<string, any[]>(courses.map((c: any) => [String(c.id), sections.filter((s: any) => s.courseId === c.id)]));
  const subjectByName = new Map<string, any>(subjects.map((s: any) => [normalize(s.name), s] as const));

  // Asegurar que una asignatura exista en el catálogo del año; crearla si falta (flujo LocalStorage)
  const ensureSubjectForYear = (nameRaw: string, courseId?: string | null) => {
    const name = fixMojibake(String(nameRaw || '').trim());
    if (!name) return null as any;
    const key = normalize(name);
    let found = subjectByName.get(key);
    if (found) return found;
    try {
      const color = getSubjectColor(name);
      const now = new Date();
      const newSubject = {
        id: crypto.randomUUID(),
        uniqueCode: EducationCodeGenerator.generateSubjectCode(),
        name,
        abbreviation: color.abbreviation,
        description: `Asignatura generada automáticamente desde importación (${name})`,
        courseId: courseId ? String(courseId) : (courses[0]?.id ? String(courses[0].id) : ''),
        color: color.color,
        bgColor: color.bgColor,
        textColor: color.textColor,
        createdAt: now,
        updatedAt: now,
      } as any;
      subjects = [...subjects, newSubject];
      LocalStorageManager.setSubjectsForYear(year, subjects);
      subjectByName.set(key, newSubject);
      try { window.dispatchEvent(new CustomEvent('subjectsChanged', { detail: { year, added: 1, name } })); } catch {}
      return newSubject;
    } catch {
      return null as any;
    }
  };
  const studentByRut = new Map<string, any>(students.map((s: any) => [String(s.rut || '').replace(/\./g, '').toLowerCase(), s] as const));
  const studentByName = new Map<string, any>(students.map((s: any) => [normalize(s.name), s] as const));

  let existing: any[] = [];
  try { existing = LocalStorageManager.getTestGradesForYear(year) || []; } catch { existing = []; }
  const updatedGrades: any[] = [...existing];
  const gradeIndex = new Map<string, number>();
  updatedGrades.forEach((g: any, i: number) => gradeIndex.set(`${g.testId}-${g.studentId}`, i));

  let created = 0; const errors: string[] = [];
  const generatedTasks: any[] = [];
  const generatedEvaluations: any[] = [];
  const generatedTests: any[] = [];
  const taskKey = (o: { tipo: string; subj: string; courseId: string; sectionId: string | null; fecha: string; seq?: number }) =>
    `${o.tipo}::${normalize(o.subj)}::${o.courseId}::${o.sectionId || ''}::${o.fecha}${o.seq ? `::seq${o.seq}` : ''}`;
  const taskBaseMap = new Map<string, any>();
  const evaluationDaySeq = new Map<string, number>();
  const activityDaySeq = new Map<string, number>();

  const parseFecha = (raw: any): number => {
    if (!raw && raw !== 0) return Date.now();
    if (typeof raw === 'number' && isFinite(raw)) {
      if (raw > 40000 && raw < 80000) { // serial Excel
        const epoch = new Date(Date.UTC(1899, 11, 30));
        return epoch.getTime() + raw * 86400000;
      }
      return raw;
    }
    const str = String(raw).trim();
    if (!str) return Date.now();
    const mDMY = str.match(/^([0-3]?\d)[\/\-]([0-1]?\d)[\/\-](\d{4})$/);
    if (mDMY) {
      const d = parseInt(mDMY[1], 10);
      const mth = parseInt(mDMY[2], 10) - 1;
      const y = parseInt(mDMY[3], 10);
      const dt = new Date(y, mth, d, 12, 0, 0, 0);
      if (isFinite(dt.getTime())) return dt.getTime();
    }
    const mYMD = str.match(/^(\d{4})[\/\-]([0-1]?\d)[\/\-]([0-3]?\d)$/);
    if (mYMD) {
      const y = parseInt(mYMD[1], 10);
      const mth = parseInt(mYMD[2], 10) - 1;
      const d = parseInt(mYMD[3], 10);
      const dt = new Date(y, mth, d, 12, 0, 0, 0);
      if (isFinite(dt.getTime())) return dt.getTime();
    }
    const nat = new Date(str);
    if (isFinite(nat.getTime())) return nat.getTime();
    return Date.now();
  };

  const BATCH = 400; // tamaño de lote (ajustable según rendimiento)
  for (let start = 0; start < rows.length; start += BATCH) {
    if (gradesImportCancelRef.current) { setGradesProgress(p => ({ ...p, phase: 'Cancelado' })); break; }
    const slice = rows.slice(start, start + BATCH);
    for (let sIdx = 0; sIdx < slice.length; sIdx++) {
      const idx = start + sIdx;
      const row = slice[sIdx];
      const i = idx + 2;
      try {
        const nombre = get(row, ['nombre','name']);
        const rutRaw = get(row, ['rut']);
        const curso = get(row, ['curso','course']);
        const seccion = get(row, ['seccion','sección','section']);
  const asignatura = fixMojibake(get(row, ['asignatura','materia','subject']));
        const tipo = get(row, ['tipo','type']);
        const fecha = get(row, ['fecha','date']);
        const notaRaw = get(row, ['nota','grade','score']);
        // Leer tema/topic del CSV si existe (campo opcional)
        const tema = fixMojibake(get(row, ['tema','topic','theme']) || '');
        if (!nombre && !rutRaw) { errors.push(`Fila ${i}: Falta Nombre o RUT`); continue; }
        if (!curso || !asignatura || !notaRaw) { errors.push(`Fila ${i}: Falta Curso/Asignatura/Nota`); continue; }
        const course: any = courseByName.get(normalize(curso));
        if (!course) { errors.push(`Fila ${i}: Curso no encontrado: ${curso}`); continue; }
        const secs: any[] = sectionsByCourse.get(String(course.id)) || [];
        const section: any = seccion ? secs.find((s: any) => normalize(s.name) === normalize(seccion)) : null;
        let subject: any = subjectByName.get(normalize(asignatura));
        if (!subject && asignatura) {
          subject = ensureSubjectForYear(asignatura, String(course.id));
        }
        const student: any = rutRaw
          ? studentByRut.get(String(rutRaw).replace(/\./g, '').toLowerCase())
          : studentByName.get(normalize(nombre));
        if (!student) { errors.push(`Fila ${i}: Estudiante no encontrado (${nombre || rutRaw})`); continue; }
        let pct: number | null = null;
        const mFrac = notaRaw.match?.(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
        const mPct = notaRaw.match?.(/(\d+(?:\.\d+)?)\s*%/);
        if (mFrac) { const num = parseFloat(mFrac[1]); const den = parseFloat(mFrac[2]); pct = den > 0 ? (num/den)*100 : null; }
        else if (mPct) { pct = parseFloat(mPct[1]); }
        else { const raw = Number((notaRaw as string).replace?.(',', '.') || notaRaw); if (isFinite(raw)) pct = toPercentFromConfigured(raw) ?? null; }
        if (pct == null || !isFinite(pct)) { errors.push(`Fila ${i}: Nota inválida: ${notaRaw}`); continue; }
        pct = Math.max(0, Math.min(100, pct));
        const gradedAt = parseFecha(fecha);
        const d = new Date(gradedAt); const dayKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const tipoNormPre = (tipo || 'tarea').toLowerCase();
        const stableBase = `${tipoNormPre}|${normalize(asignatura)}|${course.id}|${section ? section.id : ''}|${dayKey}`;
        let testId: string;
        const hash = (() => { let h = 0; for (let c of stableBase) { h = (h*31 + c.charCodeAt(0)) >>> 0; } return h.toString(36); })();
        if (tipoNormPre === 'evaluacion') {
          const seq = (evaluationDaySeq.get(stableBase) || 0) + 1; evaluationDaySeq.set(stableBase, seq); testId = `imp-${hash}-e${seq}`;
        } else { const seq = (activityDaySeq.get(stableBase) || 0) + 1; activityDaySeq.set(stableBase, seq); testId = seq === 1 ? `imp-${hash}` : `imp-${hash}-i${seq}`; }
        const rec: any = {
          id: `${testId}-${student.id}`,
          testId,
          studentId: String(student.id),
          studentName: student.displayName || student.name || student.username,
          score: pct,
          courseId: String(course.id),
          sectionId: section ? String(section.id) : (student.sectionId || null),
          subjectId: subject?.id || subject?.name || asignatura,
          // Usar tema si existe, de lo contrario fallback al formato anterior
          title: tema || (tipo ? `${tipo} ${asignatura}` : asignatura),
          gradedAt,
          // Campo opcional 'topic' para UI/burbujas
          ...(tema ? { topic: tema } : {})
        };
        const gKey = `${rec.testId}-${rec.studentId}`;
        const existingIdx = gradeIndex.get(gKey);
        if (existingIdx != null) {
          // Update existente (preservar id original si difiere)
          const ex = updatedGrades[existingIdx];
            updatedGrades[existingIdx] = { ...rec, id: ex.id };
        } else {
          gradeIndex.set(gKey, updatedGrades.length);
          updatedGrades.push(rec);
          created++;
        }
        // Actividades (solo una creación por key)
        const tipoNorm = tipoNormPre;
        const activityDateIso = new Date(gradedAt).toISOString();
        let key: string;
        if (tipoNorm === 'evaluacion') key = `evaluacion-individual::${testId}`; else {
          const seqForBase = activityDaySeq.get(stableBase) || 1;
          key = taskKey({ tipo: tipoNorm, subj: asignatura, courseId: String(course.id), sectionId: section ? String(section.id) : null, fecha: activityDateIso.slice(0,10), seq: seqForBase > 1 ? seqForBase : undefined });
        }
        if (!taskBaseMap.has(key)) {
          // Intentar recuperar un nombre de profesor de la fila original si existe en headers
          const headersLower = headers.map(h => String(h).toLowerCase());
          const profIdx = headersLower.findIndex(h => h.includes('profesor') || h.includes('teacher') || h.includes('docente'));
          const profName = profIdx >= 0 ? String((rows as any)[i-2]?.[headers[profIdx]] || '').trim() : '';
          // Usar tema si existe, de lo contrario fallback al formato anterior
          const activityTitle = tema || `${tipoNorm} ${asignatura}`.trim();
          const activityTopic = tema || asignatura;
          const baseCommon = { id: testId, title: activityTitle, description: `Generado por importación masiva (${asignatura})`, subject: asignatura, subjectName: asignatura, subjectId: subject?.id || null, course: course.name, courseId: course.id, sectionId: section ? String(section.id) : null, assignedById: 'system', assignedByName: profName || 'System', assignedTo: 'course', createdAt: activityDateIso, openAt: activityDateIso, startAt: activityDateIso, dueDate: activityDateIso, status: tipoNorm === 'evaluacion' ? 'completed' : 'finished', priority: 'medium', ...(tema ? { topic: tema } : {}) };
          if (tipoNorm === 'evaluacion') { const evalTask = { ...baseCommon, taskType: 'evaluacion', evaluationResults: {} }; taskBaseMap.set(key, evalTask); generatedEvaluations.push(evalTask); }
          else if (tipoNorm === 'prueba') { const pruebaTask = { ...baseCommon, taskType: 'prueba', topic: activityTopic }; taskBaseMap.set(key, pruebaTask); generatedTests.push(pruebaTask); }
          else { const tareaTask = { ...baseCommon, taskType: 'tarea', topic: activityTopic }; taskBaseMap.set(key, tareaTask); generatedTasks.push(tareaTask); }
        }
        if (tipoNormPre === 'evaluacion') {
          const taskBase = taskBaseMap.get(key);
          if (taskBase) {
            if (!taskBase.evaluationResults) taskBase.evaluationResults = {};
            taskBase.evaluationResults[student.username || student.id] = { score: (pct / 100) * 10, totalQuestions: 10, completionPercentage: pct, completedAt: activityDateIso };
          }
        }
      } catch (err) {
        errors.push(`Fila ${i}: Error inesperado`);
      }
    }
    // Actualizar progreso al finalizar lote
    setGradesProgress(p => ({ ...p, current: Math.min(start + BATCH, rows.length), created, errors: errors.length }));
    await new Promise(r => setTimeout(r, 0)); // ceder al event loop
  }

  if (!gradesImportCancelRef.current) {
    // Guardar resultados - USAR LOCALSTORAGE PERMANENTE PARA PERSISTIR ENTRE SESIONES
    LocalStorageManager.setTestGradesForYear(year, updatedGrades, { preferSession: false });
    try { const key = LocalStorageManager.keyForTestGrades(year); window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(updatedGrades) })); } catch {}
  }
  const elapsed = (performance.now() - startTime).toFixed(0);
  console.log(`[IMPORT GRADES] Filas: ${rows.length} Nuevas/Actualizadas: ${created} Tiempo(ms): ${elapsed}`);
  // Generar actividades
  try {
    if (generatedTasks.length) {
      const prev = safeParseLS<any[]>('smart-student-tasks', []);
      const merged = [...prev, ...generatedTasks];
      localStorage.setItem('smart-student-tasks', JSON.stringify(merged));
      window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-tasks', newValue: JSON.stringify(merged) }));
    }
    if (generatedEvaluations.length) {
      const prev = safeParseLS<any[]>('smart-student-evaluations', []);
      const merged = [...prev, ...generatedEvaluations];
      localStorage.setItem('smart-student-evaluations', JSON.stringify(merged));
      window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-evaluations', newValue: JSON.stringify(merged) }));
      const evalResults: any[] = [];
      generatedEvaluations.forEach(ev => { Object.entries(ev.evaluationResults || {}).forEach(([u, r]: any) => evalResults.push({ taskId: ev.id, studentUsername: u, percentage: r.completionPercentage, completedAt: r.completedAt })); });
      if (evalResults.length) {
        const prevRes = safeParseLS<any[]>('smart-student-evaluation-results', []);
        const mergedRes = [...prevRes, ...evalResults];
        localStorage.setItem('smart-student-evaluation-results', JSON.stringify(mergedRes));
        window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-evaluation-results', newValue: JSON.stringify(mergedRes) }));
      }
    }
    if (generatedTests.length) {
      const prev = safeParseLS<any[]>('smart-student-tests', []);
      const merged = [...prev, ...generatedTests];
      localStorage.setItem('smart-student-tests', JSON.stringify(merged));
      window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-tests', newValue: JSON.stringify(merged) }));
    }
  } catch (e) {
    console.warn('No se pudieron generar actividades desde calificaciones importadas', e);
  }

  try { 
    window.dispatchEvent(new CustomEvent('taskNotificationsUpdated')); 
    setTimeout(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-evaluation-results', newValue: localStorage.getItem('smart-student-evaluation-results') }));
    }, 100);
  } catch {}

  setGradesProgress(p => ({ ...p, phase: gradesImportCancelRef.current ? 'Cancelado' : 'Completado', current: p.total, created, errors: errors.length }));
  toast({ title: gradesImportCancelRef.current ? 'Importación cancelada' : 'Importación completa', description: `Notas procesadas: ${created}. Errores: ${errors.length}` , variant: errors.length ? 'destructive' : 'default' });
  if (errors.length) console.warn('[GRADES IMPORT] Detalles:', errors);
  return; // FIN OPTIMIZADO
    } catch (e) {
      console.error('Error en importación de calificaciones:', e);
      toast({ title: 'Error al importar', description: 'Revisa el archivo CSV y su formato', variant: 'destructive' });
      setGradesProgress(p => ({ ...p, phase: 'Error' }));
    } finally {
      try { event.target.value = ''; } catch {}
    }
  };
  // (Estados principales definidos al inicio para disponibilidad en handlers previos)
  // const [showResetDialog, setShowResetDialog] = useState(false); // ✅ ELIMINADO: Sección Reiniciar Sistema removida
  // ✅ Confirmación para botón Reiniciar Sistema en Configuración
  // const [showResetConfirm, setShowResetConfirm] = useState(false); // ✅ ELIMINADO: Sección Reiniciar Sistema removida
  // Worker para importación de asistencia
  const attendanceWorkerRef = useRef<Worker | null>(null);
  // Diálogo de resumen al completar importación de asistencia
  const [showAttendanceComplete, setShowAttendanceComplete] = useState(false);
  const [attendanceComplete, setAttendanceComplete] = useState<{ yearLabel: string; days: number; students: number; percent: number; total: number; present: number }>({ yearLabel: '', days: 0, students: 0, percent: 0, total: 0, present: 0 });
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showCreateUserDialog, setShowCreateUserDialog] = useState(false);
  // Confirmaciones (modales) para borrado en Carga Masiva
  const [showConfirmDeleteActivities, setShowConfirmDeleteActivities] = useState(false);
  const [showConfirmDeleteAttendance, setShowConfirmDeleteAttendance] = useState(false);
  const [showConfirmDeleteAllSQL, setShowConfirmDeleteAllSQL] = useState(false);
  const [showConfirmDeleteAttendanceSQL, setShowConfirmDeleteAttendanceSQL] = useState(false);
  const [showDeleteSQLProgress, setShowDeleteSQLProgress] = useState(false);
  const [isDeletingAllGrades, setIsDeletingAllGrades] = useState(false); // true = eliminar TODO, false = solo año
  // Progreso local para borrado cuando se usa Firebase en lugar de SQL
  const [firebaseDeleteProgress, setFirebaseDeleteProgress] = useState<any | null>(null);
  const [showAttendanceDeleteSQLProgress, setShowAttendanceDeleteSQLProgress] = useState(false);
  // Nuevo: confirmación de importación dentro del proyecto (no Chrome)
  const [showImportConfirmDialog, setShowImportConfirmDialog] = useState(false);
  const [pendingImportData, setPendingImportData] = useState<any | null>(null);
  const [pendingImportInput, setPendingImportInput] = useState<HTMLInputElement | null>(null);
  const [refreshUsers, setRefreshUsers] = useState(0); // State to trigger user list refresh
  // Estado para carga masiva por Excel
  const [isExcelProcessing, setIsExcelProcessing] = useState(false);
  // Resumen visible del último resultado de importación por Excel
  const [excelImportSummary, setExcelImportSummary] = useState<{
    admins: number;
    teachers: number;
    students: number;
    guardians: number;
    studentsUpdated?: number;
    errors: number;
    errorMessages?: string[];
    timestamp: string;
  } | null>(null);
  // Control de ventana emergente para el resumen de carga Excel
  const [showExcelSummaryDialog, setShowExcelSummaryDialog] = useState(false);
  // Progreso visual para importación de asistencia
  const [showAttendanceProgress, setShowAttendanceProgress] = useState(false);
  const [attendanceProgress, setAttendanceProgress] = useState({ current: 0, total: 0, created: 0, errors: 0 });
  // Progreso importación calificaciones
  // (Estado de progreso de calificaciones ya declarado arriba)
  // Contadores de registros del año
  const [gradeCount, setGradeCount] = useState(0);
  const [attendanceCount, setAttendanceCount] = useState(0);

  // Diálogo para crear nuevo año (in-app, no ventana del navegador)
  const [showNewYearDialog, setShowNewYearDialog] = useState(false);

  // Tick para forzar rerender cuando cambie el calendario en otra pestaña/página
  const [calendarTick, setCalendarTick] = useState(0);

  // Form state for creating new user
  const [createUserFormData, setCreateUserFormData] = useState({
    name: '',
    email: '',
    role: 'student' as 'student' | 'teacher' | 'admin' | 'guardian',
    rut: '',
    username: '',
    password: '',
    confirmPassword: '',
    autoGenerate: true,
    courseId: '',
    section: '',
    subject: '',
    selectedSubjects: [] as string[],
    // Guardian-specific fields
    phone: '',
    studentIds: [] as string[],
    relationship: 'tutor' as 'mother' | 'father' | 'tutor' | 'other'
  });

  // Data states for form dropdowns
  const [availableCourses, setAvailableCourses] = useState<any[]>([]);
  const [availableSections, setAvailableSections] = useState<any[]>([]);
  const [availableSubjects, setAvailableSubjects] = useState<any[]>([]);

  // Load configuration on component mount and when selectedYear changes
  useEffect(() => {
    loadConfiguration();
  }, [selectedYear, calendarTick]);

  // Persistir y propagar cambios de año
  useEffect(() => {
    try { localStorage.setItem('admin-selected-year', String(selectedYear)); } catch {}
    setAvailableYears(LocalStorageManager.listYears());
  }, [selectedYear]);

  // Recalcular contadores al cambiar de año (OPTIMIZADO - NO BLOQUEANTE)
  useEffect(() => {
    // Usar setTimeout para no bloquear el render
    const timeoutId = setTimeout(() => {
      try { 
        const grades = LocalStorageManager.getTestGradesForYear(selectedYear) || [];
        setGradeCount(grades.length); 
      } catch { 
        setGradeCount(0); 
      }
      try { 
        const attendance = LocalStorageManager.getAttendanceForYear(selectedYear) || [];
        setAttendanceCount(attendance.length); 
      } catch { 
        setAttendanceCount(0); 
      }
    }, 0);
    
    return () => clearTimeout(timeoutId);
  }, [selectedYear]);

  // Escuchar cambios relevantes en storage
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (!e.key) return;
      const gradeKey = (() => { try { return LocalStorageManager.keyForTestGrades(selectedYear); } catch { return ''; } })();
      if (e.key === gradeKey) {
        try { setGradeCount((LocalStorageManager.getTestGradesForYear(selectedYear) || []).length); } catch {}
      } else if (e.key.includes('attendance') || e.key.startsWith('smart-student-attendance')) {
        try { setAttendanceCount((LocalStorageManager.getAttendanceForYear(selectedYear) || []).length); } catch {}
      }
    };
    try { window.addEventListener('storage', handler); } catch {}
    try { window.addEventListener('attendanceChanged', handler as any); } catch {}
    return () => {
      try { window.removeEventListener('storage', handler); } catch {}
      try { window.removeEventListener('attendanceChanged', handler as any); } catch {}
    };
  }, [selectedYear]);

  // Escuchar cambios del calendario (evento propio y eventos de storage)
  useEffect(() => {
    const onCalendarUpdated = (e: any) => {
      try {
        const y = Number(e?.detail?.year);
        if (!y || y === selectedYear) setCalendarTick((x) => x + 1);
      } catch { setCalendarTick((x) => x + 1); }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith('admin-calendar-')) {
        setCalendarTick((x) => x + 1);
      }
    };
    try { window.addEventListener('calendarUpdated', onCalendarUpdated as any); } catch {}
    try { window.addEventListener('storage', onStorage); } catch {}
    return () => {
      try { window.removeEventListener('calendarUpdated', onCalendarUpdated as any); } catch {}
      try { window.removeEventListener('storage', onStorage); } catch {}
    };
  }, [selectedYear]);

  // Recalcular estadísticas del sistema cuando cambien datos relevantes (OPTIMIZADO)
  useEffect(() => {
    const updateStats = () => {
      try {
        // Usar setTimeout para no bloquear el render
        setTimeout(() => {
          try {
            setSystemStats(getSystemStatistics());
          } catch (error) {
            console.warn('Error recalculando estadísticas del sistema:', error);
          }
        }, 0);
      } catch (error) {
        console.warn('Error iniciando recálculo de estadísticas:', error);
      }
    };

    // Escuchar eventos de cambio de datos
    const onDataChanged = () => updateStats();
    
    try { window.addEventListener('attendanceChanged', onDataChanged); } catch {}
    try { window.addEventListener('dataImported', onDataChanged); } catch {}
    try { window.addEventListener('coursesChanged', onDataChanged); } catch {}
    try { window.addEventListener('sectionsChanged', onDataChanged); } catch {}
    try { window.addEventListener('usersChanged', onDataChanged); } catch {}
    
    // Recalcular después de un delay para no bloquear el mount inicial
    setTimeout(() => updateStats(), 100);
    
    return () => {
      try { window.removeEventListener('attendanceChanged', onDataChanged); } catch {}
      try { window.removeEventListener('dataImported', onDataChanged); } catch {}
      try { window.removeEventListener('coursesChanged', onDataChanged); } catch {}
      try { window.removeEventListener('sectionsChanged', onDataChanged); } catch {}
      try { window.removeEventListener('usersChanged', onDataChanged); } catch {}
    };
  }, [selectedYear, attendanceCount, gradeCount, calendarTick]);

  // ✅ NUEVO: Cargar scripts de corrección dinámica automáticamente (NO BLOQUEANTE)
  useEffect(() => {
    const cargarScriptsCorrecion = () => {
      console.log('🚀 [CONFIGURACIÓN ADMIN] Iniciando carga de sistema de corrección...');
      
      try {
        // Verificar si ya están cargados los scripts
        if (typeof window.regenerarAsignacionesDinamicas !== 'function' ||
            typeof window.exportarBBDDConAsignaciones !== 'function' ||
            typeof window.validarAsignacionesManualmente !== 'function') {
          
          console.log('📥 [CARGA AUTOMÁTICA] Preparando scripts de corrección...');
          
          // Cargar script principal de solución completa de forma NO BLOQUEANTE
          const scriptSolucion = document.createElement('script');
          scriptSolucion.src = '/solucion-completa-ejecutar.js';
          scriptSolucion.async = true; // ✅ Asegurar carga asíncrona
          scriptSolucion.onerror = () => {
            console.warn('⚠️ [CARGA] No se pudo cargar desde archivo, ejecutando funciones básicas...');
            setTimeout(() => crearFuncionesBasicasCorrecion(), 0);
          };
          scriptSolucion.onload = () => {
            console.log('✅ [CARGA EXITOSA] Sistema de corrección dinámica cargado');
          };
          
          // Verificar después de 3 segundos si se cargó, si no, crear funciones básicas
          setTimeout(() => {
            if (typeof window.regenerarAsignacionesDinamicas !== 'function') {
              console.log('⚠️ [FALLBACK] Creando funciones básicas de corrección...');
              crearFuncionesBasicasCorrecion();
            }
          }, 3000);
          
          document.head.appendChild(scriptSolucion);
        } else {
          console.log('✅ [YA CARGADO] Sistema de corrección ya disponible');
        }
      } catch (error) {
        console.error('❌ [ERROR CARGA] Error cargando scripts:', error);
        setTimeout(() => crearFuncionesBasicasCorrecion(), 0);
      }
    };
    
    // Cargar scripts de forma asíncrona sin bloquear la UI
    setTimeout(() => cargarScriptsCorrecion(), 100);
  }, []);

  // ✅ NUEVA FUNCIÓN: Crear funciones básicas de corrección si no se pueden cargar los scripts
  const crearFuncionesBasicasCorrecion = () => {
    console.log('🔧 [FUNCIONES BÁSICAS] Creando funciones de corrección básicas...');
    
    // Función básica de regeneración
    if (typeof window.regenerarAsignacionesDinamicas !== 'function') {
      window.regenerarAsignacionesDinamicas = function() {
        try {
          const usuarios = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
          const cursos = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
          const secciones = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
          
          const estudiantes = usuarios.filter((u: any) => u.role === 'student' || u.role === 'estudiante');
          const asignaciones: any[] = [];
          
          estudiantes.forEach((estudiante: any) => {
            if (estudiante.courseId && estudiante.sectionId) {
              asignaciones.push({
                id: `${estudiante.id}-${estudiante.sectionId}-${Date.now()}-${Math.random()}`,
                studentId: estudiante.id,
                courseId: estudiante.courseId,
                sectionId: estudiante.sectionId,
                assignedAt: new Date().toISOString(),
                isActive: true
              });
            }
          });
          
          localStorage.setItem('smart-student-student-assignments', JSON.stringify(asignaciones));
          
          return {
            exito: true,
            asignacionesCreadas: asignaciones.length,
            mensaje: 'Corrección básica aplicada'
          };
        } catch (error) {
          return {
            exito: false,
            asignacionesCreadas: 0,
            mensaje: 'Error en corrección básica'
          };
        }
      };
    }
    
    // Función básica de validación
    if (typeof window.validarAsignacionesManualmente !== 'function') {
      window.validarAsignacionesManualmente = function() {
        try {
          const usuarios = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
          const asignaciones = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
          
          const estudiantes = usuarios.filter((u: any) => u.role === 'student' || u.role === 'estudiante');
          const problemas = [];
          
          const estudiantesSinAsignacion = estudiantes.filter((e: any) => 
            !asignaciones.some((a: any) => a.studentId === e.id)
          );
          
          if (estudiantesSinAsignacion.length > 0) {
            problemas.push({
              tipo: 'Estudiantes sin asignación',
              cantidad: estudiantesSinAsignacion.length
            });
          }
          
          return {
            esValido: problemas.length === 0,
            problemas,
            estadisticas: {
              usuarios: usuarios.length,
              estudiantes: estudiantes.length,
              asignaciones: asignaciones.length
            }
          };
        } catch (error) {
          return {
            esValido: false,
            problemas: [{ tipo: 'Error de validación', cantidad: 1 }],
            estadisticas: {}
          };
        }
      };
    }
    
    console.log('✅ [FUNCIONES BÁSICAS] Funciones básicas de corrección creadas');
  };

  const loadConfiguration = () => {
    try {
      const storedConfig = LocalStorageManager.getConfig();
      if (Object.keys(storedConfig).length > 0) {
        setConfig({ ...config, ...storedConfig });
      }
      // Asegurar que grading tenga defaults visibles en UI
      try {
        const g = getGradingConfig();
        setConfig(prev => ({ ...prev, grading: { ...g } } as any));
      } catch (e) {
        console.warn('Error cargando configuración de calificaciones:', e);
      }
      
      // Load available options for form dropdowns (per year) de manera diferida
      setTimeout(() => {
        try {
          const courses = LocalStorageManager.getCoursesForYear(selectedYear);
          const sections = LocalStorageManager.getSectionsForYear(selectedYear);
          const subjects = LocalStorageManager.getSubjectsForYear(selectedYear);
          
          // Get subjects with colors from the subjects-colors library
          const subjectsWithColors = getAllAvailableSubjects();
          
          setAvailableCourses(courses);
          setAvailableSections(sections);
          setAvailableSubjects(subjectsWithColors);
        } catch (e) {
          console.warn('Error cargando opciones de formularios:', e);
        }
      }, 0);
    } catch (error) {
      console.error('Error loading configuration:', error);
    }
  };

  const saveConfiguration = async () => {
    setIsLoading(true);
    try {
      LocalStorageManager.setConfig(config);
      
      // Update section max capacity in all existing sections
  const sections = LocalStorageManager.getSectionsForYear(selectedYear);
  const updatedSections = sections.map((section: any) => ({
        ...section,
        maxStudents: config.maxStudentsPerSection
      }));
      LocalStorageManager.setSectionsForYear(selectedYear, updatedSections);

      // Notificar guardado exitoso
      toast({
        title: translate('configSavedTitle') || 'Configuration Saved',
        description: translate('configSavedDescription') || 'Changes have been applied successfully and section capacities have been updated',
        variant: 'default',
      });
    } catch (error) {
      toast({
        title: translate('error') || 'Error',
        description: translate('configSaveErrorDescription') || 'No se pudo guardar la configuración',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Helper: calcular días hábiles disponibles según calendario admin
  const computeAvailableDaysForYear = (year: number): number => {
    try {
      const raw = localStorage.getItem(`admin-calendar-${year}`);
      let cfg: any = null;
      try { cfg = raw ? JSON.parse(raw) : null; } catch { cfg = raw; }
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { /* ignore */ } }
      cfg = cfg && typeof cfg === 'object' ? cfg : { holidays: [], summer: {}, winter: {} };
      const pad = (n: number) => String(n).padStart(2, '0');
      const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const inRange = (date: Date, range?: { start?: string; end?: string }) => {
        if (!range?.start || !range?.end) return false;
        const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const parseLocal = (ymd: string) => {
          const [y, m, d] = ymd.split('-').map(Number);
          return new Date(y, (m || 1) - 1, d || 1);
        };
        const a = parseLocal(range.start).getTime();
        const b = parseLocal(range.end).getTime();
        const [min, max] = a <= b ? [a, b] : [b, a];
        return t >= min && t <= max;
      };
      const start = new Date(year, 0, 1);
      const end = new Date(year, 11, 31);
      let count = 0;
      const d = new Date(start);
      while (d <= end) {
        const dow = d.getDay();
        const isWeekday = dow >= 1 && dow <= 5; // L-V
        if (
          isWeekday &&
          !inRange(d, cfg.summer) &&
          !inRange(d, cfg.winter) &&
          !(Array.isArray(cfg.holidays) && cfg.holidays.includes(keyOf(d)))
        ) {
          count++;
        }
        d.setDate(d.getDate() + 1);
      }
      return count;
    } catch { return 0; }
  };

  // Recalcular tarjeta "Asistencia %" usando SQL por año cuando esté disponible (después de calendarTick)
  useEffect(() => {
    if (!isAttendanceSQLConnected) return;
    let cancelled = false;
    const recalcFromSQL = async () => {
      try {
        const rows = await getAttendanceByYearSQL(selectedYear);
        // Contar presentes + tarde como "asistencia efectiva"
        const present = (rows || []).filter((r: any) => 
          r.present === true || 
          r.status === 'present' || 
          r.status === 'late'
        ).length;
        const total = (rows || []).length;
        // Calcular porcentaje basado en registros cargados (presentes+tarde / total)
        const percent = total > 0 ? Math.round((present / total) * 100) : 0;
        if (!cancelled) {
          setSystemStats((prev: any) => ({
            ...prev,
            attendancePercent: percent,
            attendancePresent: present,
            attendanceTotal: total,
          }));
        }
      } catch (e) {
        console.warn('[CONFIG] No se pudo recalcular Asistencia % desde SQL:', e);
      }
    };
    recalcFromSQL();
    const onSqlUpdated = () => recalcFromSQL();
    try { window.addEventListener('sqlAttendanceUpdated', onSqlUpdated as any); } catch {}
    return () => {
      cancelled = true;
      try { window.removeEventListener('sqlAttendanceUpdated', onSqlUpdated as any); } catch {}
    };
  }, [isAttendanceSQLConnected, selectedYear, calendarTick, getAttendanceByYearSQL]);

  const getSystemStatistics = () => {
    try {
      const students = LocalStorageManager.getStudentsForYear(selectedYear);
      const teachers = LocalStorageManager.getTeachersForYear(selectedYear);
      const courses = LocalStorageManager.getCoursesForYear(selectedYear);
      const sections = LocalStorageManager.getSectionsForYear(selectedYear);
      const subjects = LocalStorageManager.getSubjectsForYear(selectedYear);
      const studentAssignments = LocalStorageManager.getStudentAssignmentsForYear(selectedYear);

      // Obtener datos adicionales
      const administrators = JSON.parse(localStorage.getItem('smart-student-administrators') || '[]');

      // Conteo de asignaturas únicas por año (por nombre)
      const uniqueSubjectsCount = (() => {
        try {
          const names = new Set<string>();
          (subjects || []).forEach((s: any) => {
            const n = String(s?.name || '').trim().toLowerCase();
            if (n) names.add(n);
          });
          // Fallback: si no hay catálogo por año, inferir de asignaciones de profesores
          if (names.size === 0) {
            const tas = LocalStorageManager.getTeacherAssignmentsForYear(selectedYear) || [];
            (tas || []).forEach((a: any) => {
              const n = String(a?.subjectName || '').trim().toLowerCase();
              if (n) names.add(n);
            });
          }
          return names.size;
        } catch {
          return Array.isArray(subjects) ? subjects.length : 0;
        }
      })();

  // Asistencia (global, filtrada por año)
    let attendanceAll = LocalStorageManager.getAttendanceForYear(selectedYear);
  let attSummary = { days: 0, studentsCount: 0, total: attendanceAll.length, present: attendanceAll.filter((a: any)=> (a.present === true || a.status === 'present')).length, percent: 0 } as any;
  
    // Debug adicional para verificar estructura de datos de asistencia
    if (attendanceAll.length > 0) {
      console.log('[DEBUG ESTRUCTURA ASISTENCIA]', {
        totalRecords: attendanceAll.length,
        sampleRecord: attendanceAll[0],
  presentValues: attendanceAll.slice(0, 10).map((a: any) => ({ present: a.present, type: typeof a.present })),
        presentCount: attendanceAll.filter((a: any) => a.present === true).length,
        presentStringTrue: attendanceAll.filter((a: any) => a.present === 'true').length,
        presentString1: attendanceAll.filter((a: any) => a.present === '1').length,
        presentNumber1: attendanceAll.filter((a: any) => a.present === 1).length,
      });
    }
      if (!attSummary.total) {
        const sum = LocalStorageManager.getAttendanceSummary(selectedYear);
        if (sum) {
          const percent = sum.total ? Math.round((sum.present / sum.total) * 100) : 0;
          attSummary = { days: sum.days, studentsCount: sum.students, total: sum.total, present: sum.present, percent } as any;
        }
      }

      // Protección post-reinicio: si no hay usuarios ni asignaciones del año, la asistencia debe ser 0%
      try {
        const noUsers = (students?.length || 0) + (teachers?.length || 0) === 0;
        const noStudentAssignments = (studentAssignments?.length || 0) === 0;
        if (noUsers && noStudentAssignments) {
          // Mostrar 0% y limpiar posibles artefactos huérfanos de asistencia de ese año
          attSummary = { days: 0, studentsCount: 0, total: 0, present: 0, percent: 0 } as any;
          // Limpieza profunda de asistencia (todas las representaciones)
          // IMPORTANTE: NO disparar evento para evitar recursión infinita
          try {
            const deepClearAttendanceYear = (year: number) => {
              const yearKey = `smart-student-attendance-${year}`;
              const summaryKey = `smart-student-attendance-summary-${year}`;
              const globalKey = 'smart-student-attendance';
              // 1. Clave per-year y artefactos chunked/shards
              const removeArtifacts = (baseKey: string) => {
                try { localStorage.removeItem(baseKey); } catch {}
                const suffixes = ['__parts','__where','__meta'];
                suffixes.forEach(s => { try { localStorage.removeItem(baseKey + s); } catch {} });
                let idx = 0; // part shards
                while (localStorage.getItem(`${baseKey}__part_${idx}`) !== null) { try { localStorage.removeItem(`${baseKey}__part_${idx}`); } catch {}; idx++; }
                idx = 0; // shard style
                while (localStorage.getItem(`${baseKey}__shard_${idx}`) !== null) { try { localStorage.removeItem(`${baseKey}__shard_${idx}`); } catch {}; idx++; }
              };
              removeArtifacts(yearKey);
              // 2. Clave compacta (exceptions-v1/v2) puede residir dentro de yearKey o global; asegurar ambos
              try { LocalStorageManager.clearAttendanceForYear(year); } catch {}
              // 3. Resumen local & session
              try { localStorage.removeItem(summaryKey); } catch {}
              try { sessionStorage.removeItem(summaryKey); } catch {}
              // 4. Si la asistencia global incluye filas de otros años, reescribir filtrando
              try {
                const globalRaw = localStorage.getItem(globalKey);
                if (globalRaw) {
                  try {
                    const arr = JSON.parse(globalRaw);
                    if (Array.isArray(arr)) {
                      const filtered = arr.filter((r:any)=> Number(r.year) !== Number(year));
                      if (filtered.length === 0) localStorage.removeItem(globalKey); else localStorage.setItem(globalKey, JSON.stringify(filtered));
                    }
                  } catch { /* ignore corrupt */ }
                }
              } catch {}
              // 5. Cualquier clave residual que contenga el patrón attendance-year en nombre extendido
              try {
                const pattern = new RegExp(`^smart-student-attendance-${year}(__|$)`);
                const toRemove: string[] = [];
                for (let i=0;i<localStorage.length;i++) {
                  const k = localStorage.key(i); if (!k) continue; if (pattern.test(k)) toRemove.push(k);
                }
                toRemove.forEach(k=> { try { localStorage.removeItem(k); } catch {} });
              } catch {}
              // 6. NO disparar evento aquí para evitar recursión infinita
              // El evento se disparará cuando sea necesario desde otras funciones
            };
            deepClearAttendanceYear(selectedYear);
          } catch {}
        }
      } catch {}

      // Porcentaje anual ajustado por calendario: capacidad = días hábiles x estudiantes asignados
      const availableDays = computeAvailableDaysForYear(selectedYear);
      const assignedStudentsCount = students.filter((s: any) => s.courseId && s.sectionId).length;
      const capacity = availableDays * assignedStudentsCount;
      const calendarAwarePercent = capacity > 0 ? Math.round((attSummary.present / capacity) * 100) : 0;

      // Debug temporal para verificar valores de asistencia
      console.log('[DEBUG ASISTENCIA]', {
        selectedYear,
        attendanceAllLength: attendanceAll.length,
        attSummaryTotal: attSummary.total,
        attSummaryPresent: attSummary.present,
        availableDays,
        assignedStudentsCount,
        capacity,
        calendarAwarePercent,
        studentsTotal: students.length,
        sampleAttendance: attendanceAll.slice(0, 3)
      });

      return {
        totalUsers: students.length + teachers.length + administrators.length,
        students: students.length,
        teachers: teachers.length,
        administrators: administrators.length,
        courses: courses.length,
        sections: sections.length,
        subjects: uniqueSubjectsCount,
        // que corresponden a asignaciones de profesores (profesor-sección-asignatura)
        assignments: (LocalStorageManager.getTeacherAssignmentsForYear(selectedYear) || []).length,
        teacherAssignments: (LocalStorageManager.getTeacherAssignmentsForYear(selectedYear) || []).length,
        assignedStudents: students.filter((s: any) => s.courseId && s.sectionId).length,
        assignedTeachers: teachers.filter((t: any) => t.assignedSections && t.assignedSections.length > 0).length,
        attendancePercent: calendarAwarePercent,
        attendancePresent: attSummary.present,
        attendanceTotal: attSummary.total,
        availableDays,
        capacity,
      };
    } catch (error) {
      return {
        totalUsers: 0,
        students: 0,
        teachers: 0,
        administrators: 0,
        courses: 0,
        sections: 0,
        subjects: 0,
        assignments: 0,
        teacherAssignments: 0,
        assignedStudents: 0,
        assignedTeachers: 0,
        attendancePercent: 0,
        attendancePresent: 0,
        attendanceTotal: 0,
        availableDays: 0,
        capacity: 0,
      };
    }
  };

  // Estado reactivo para estadísticas del sistema (después de la definición de getSystemStatistics)
  const [systemStats, setSystemStats] = useState(() => getSystemStatistics());

  // Recalcular tarjeta de asistencia y estadísticas al cambiar el año o tras eventos relevantes
  useEffect(() => {
    setSystemStats(getSystemStatistics());
  }, [selectedYear]);
  useEffect(() => {
    const recalc = () => setSystemStats(getSystemStatistics());
    try {
      window.addEventListener('attendanceChanged', recalc as any);
      window.addEventListener('studentAssignmentsChanged', recalc as any);
      window.addEventListener('teacherAssignmentsChanged', recalc as any);
      window.addEventListener('yearsChanged', recalc as any);
      window.addEventListener('dataImported', recalc as any);
    } catch {}
    return () => {
      try {
        window.removeEventListener('attendanceChanged', recalc as any);
        window.removeEventListener('studentAssignmentsChanged', recalc as any);
        window.removeEventListener('teacherAssignmentsChanged', recalc as any);
        window.removeEventListener('yearsChanged', recalc as any);
        window.removeEventListener('dataImported', recalc as any);
      } catch {}
    };
  }, []);

  // ✅ Helper: obtener todas las configuraciones del Calendario Admin desde localStorage
  const getAllAdminCalendarConfigs = () => {
    const configs: Record<string, any> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('admin-calendar-')) {
          const year = key.replace('admin-calendar-', '');
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          try {
            configs[year] = JSON.parse(raw);
          } catch {
            // Si no es JSON válido, guardar como string crudo
            configs[year] = raw;
          }
        }
      }
    } catch (e) {
      console.warn('No se pudieron leer configuraciones del calendario admin:', e);
    }
    return configs;
  };

  // ✅ Helper: recolectar todas las pruebas creadas por profesores (por usuario) desde localStorage
  const collectAllTestsByUser = () => {
    const prefix = 'smart-student-tests';
    const out: Record<string, any[]> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key === prefix || key.startsWith(prefix + '_')) {
          try {
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(arr)) out[key] = arr;
          } catch {
            // ignorar
          }
        }
      }
    } catch (e) {
      console.warn('[EXPORT] No se pudieron recolectar pruebas por usuario:', e);
    }
    return out;
  };

  // ✅ Helper: recolectar historial de revisión de pruebas por testId
  const collectAllTestReviews = () => {
    const prefix = 'smart-student-test-reviews_';
    const out: Record<string, any[]> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith(prefix)) {
          try {
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(arr)) out[key] = arr;
          } catch {
            // ignorar
          }
        }
      }
    } catch (e) {
      console.warn('[EXPORT] No se pudieron recolectar historiales de revisión:', e);
    }
    return out;
  };

  // ✅ Helper: recolectar presentaciones (slides) compartidas por profesor por usuario
  // Estructura: { 'smart-student-slides-<username>': SlideItem[] (solo shared:true y con courseId/sectionId) }
  const collectAllSharedSlidesByUser = () => {
    const prefix = 'smart-student-slides-';
    const out: Record<string, any[]> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith(prefix)) {
          try {
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(arr)) {
              const shared = arr.filter((it: any) => it && it.shared === true && it.courseId && it.sectionId);
              if (shared.length > 0) out[key] = shared;
            }
          } catch {
            // ignorar
          }
        }
      }
    } catch (e) {
      console.warn('[EXPORT] No se pudieron recolectar presentaciones compartidas:', e);
    }
    return out;
  };

  // ✅ Helper: filtrar comunicaciones creadas por profesores y dirigidas a estudiantes/curso-sección
  const collectTeacherCommunications = () => {
    try {
      const all = JSON.parse(localStorage.getItem('smart-student-communications') || '[]');
      if (!Array.isArray(all)) return [] as any[];
  const savedYear = Number(localStorage.getItem('admin-selected-year') || '');
  const y = Number.isFinite(savedYear) && savedYear > 0 ? savedYear : new Date().getFullYear();
  const teachers = LocalStorageManager.getTeachersForYear(y) || [];
      const teacherIds = new Set((teachers || []).map((t: any) => t.id));
      const teacherUsernames = new Set((teachers || []).map((t: any) => t.username));
      const isTeacherSender = (c: any) => (
        (c && (teacherIds.has(c.senderId) || teacherIds.has(c.sender))) ||
        (c && (teacherUsernames.has(c.createdBy) || teacherUsernames.has(c.senderName)))
      );
      // Por diseño, las comunicaciones válidas son type 'course' o 'student'
      return all.filter((c: any) => (c && (c.type === 'course' || c.type === 'student') && isTeacherSender(c)));
    } catch (e) {
      console.warn('[EXPORT] No se pudieron recolectar comunicaciones:', e);
      return [] as any[];
    }
  };

  // =============================
  // EXPORTACIÓN SISTEMA + SQL
  // Ahora incluye respaldo de calificaciones / actividades / asistencia en SQL (Supabase o IndexedDB)
  // =============================
  const exportSystemData = async () => {
    try {
      // === Modal de progreso: iniciar ===
      const totalSteps = 8;
      setShowExportModal(true);
      setExportProgress({
        phase: 'conectando',
        current: 0,
        total: totalSteps,
        success: 0,
        errors: 0,
        logs: ['Iniciando exportación...'],
        startTime: Date.now(),
        elapsedTime: 0
      } as any);
      const logExport = (msg: string) => setExportProgress(prev => prev ? { ...prev, logs: [...(prev.logs||[]), msg] } as any : prev);
      const tick = (phase?: string) => setExportProgress(prev => prev ? { ...prev, current: Math.min((prev.current||0)+1, prev.total||totalSteps), phase: (phase as any) || prev.phase } as any : prev);

      console.log('🚀 [EXPORTACIÓN MEJORADA] Iniciando exportación con corrección de asignaciones...');
      logExport('Aplicando corrección dinámica de asignaciones (si está disponible)...');
      
      // ✅ PASO 1: Aplicar corrección dinámica antes de exportar
      if (typeof window.regenerarAsignacionesDinamicas === 'function') {
        console.log('🔄 [PRE-EXPORTACIÓN] Aplicando corrección dinámica...');
        window.regenerarAsignacionesDinamicas();
      }
      tick('procesando');
      
      // ✅ PASO 2: Usar sistema de exportación mejorada si está disponible
      if (typeof window.exportarBBDDConAsignaciones === 'function') {
        console.log('📦 [EXPORTACIÓN AVANZADA] Usando sistema mejorado de exportación...');
        logExport('Usando exportación avanzada integrada...');
        const resultado = window.exportarBBDDConAsignaciones();
        
        if (resultado.exito) {
          tick('finalizando');
          toast({
            title: translate('configExportSuccessTitle') || 'Exportación exitosa',
            description: `Base de datos exportada con asignaciones incluidas. Archivo: ${resultado.archivo}`,
            variant: 'default'
          });
          // Completar modal
          setExportProgress(prev => prev ? { ...prev, phase: 'completado', current: prev.total, success: (prev.success||0)+1, logs: [...(prev.logs||[]), '✅ Exportación avanzada completada'] } as any : prev);
          // Refrescar ventana con año actual por defecto
          try { localStorage.setItem('admin-selected-year', String(new Date().getFullYear())); } catch {}
          setTimeout(() => { try { window.location.reload(); } catch {} }, 1200);
          return;
        } else {
          console.warn('⚠️ [EXPORTACIÓN] Error en sistema avanzado, usando método básico...');
          logExport('⚠️ Exportación avanzada falló, intentando método básico...');
        }
      }
      
  // ✅ PASO 3: Método de exportación básica mejorada (fallback)
  console.log('📦 [EXPORTACIÓN BÁSICA] Usando exportación básica mejorada...');
      logExport('Ejecutando exportación básica mejorada...');
      
      // ✅ MEJORAR EXPORTACIÓN: Asegurar que todos los usuarios tengan campos completos
  const rawUsers = safeGet<any[]>('smart-student-users', []);
      tick('procesando');
      const exportUsers = rawUsers.map((user: any) => {
        // Garantizar que cada usuario exportado tenga TODOS los campos necesarios para login
        return {
          // Campos obligatorios para login
          id: user.id || crypto.randomUUID(),
          username: user.username || user.name || `user_${Date.now()}_${Math.random()}`,
          password: user.password || '1234',
          role: user.role || 'student',
          displayName: user.displayName || user.name || 'Usuario Sin Nombre',
          activeCourses: Array.isArray(user.activeCourses) ? user.activeCourses : 
                        (user.role === 'admin' ? [] : ['4to Básico']),
          email: user.email || `${user.username || user.name}@example.com`,
          isActive: user.isActive !== undefined ? user.isActive : true,
          createdAt: user.createdAt || new Date().toISOString(),
          updatedAt: user.updatedAt || new Date().toISOString(),
          
          // Preservar campos adicionales del usuario original
          ...(user.name && { name: user.name }),
          ...(user.assignedTeachers && { assignedTeachers: user.assignedTeachers }),
          ...(user.teachingAssignments && { teachingAssignments: user.teachingAssignments }),
          ...(user.uniqueCode && { uniqueCode: user.uniqueCode }),
          ...(user.courseId && { courseId: user.courseId }),
          ...(user.sectionId && { sectionId: user.sectionId }),
          ...(user.selectedSubjects && { selectedSubjects: user.selectedSubjects }),
          ...(user.assignedSections && { assignedSections: user.assignedSections }),
          ...(user.subjects && { subjects: user.subjects }),
          ...(user.section && { section: user.section })
        };
      });

      console.log('📦 [EXPORTACIÓN] Usuarios preparados con campos completos:', exportUsers.length);
  logExport(`Usuarios procesados: ${exportUsers.length}`);

  // ✅ Incluir configuraciones del Calendario Admin por año
  const calendarConfigs = getAllAdminCalendarConfigs();
  const calendarYears = Object.keys(calendarConfigs);
  tick('procesando');
  logExport(`Calendarios incluidos: ${calendarYears.length} año(s)`);

  // Incluir semestres académicos globales, si existen
  let semesters: any = null;
  semesters = safeGet<any>('smart-student-semesters', null);

  const years = LocalStorageManager.listYears();
  const perYear: Record<string, any> = {};
  years.forEach(y => {
    perYear[y] = {
      courses: LocalStorageManager.getCoursesForYear(y),
      sections: LocalStorageManager.getSectionsForYear(y),
      subjects: LocalStorageManager.getSubjectsForYear(y),
      students: LocalStorageManager.getStudentsForYear(y),
      teachers: LocalStorageManager.getTeachersForYear(y),
      teacherAssignments: LocalStorageManager.getTeacherAssignmentsForYear(y),
      studentAssignments: LocalStorageManager.getStudentAssignmentsForYear(y)
    };
  });
    tick('procesando');
    logExport('Asistencia y calificaciones por año recolectadas');

  // ✅ NUEVO: asistencia por año y resúmenes por año
  const attendancePerYear: Record<string, any> = {};
  const attendanceSummaryPerYear: Record<string, any> = {};
  // Capacidad por año (días hábiles x estudiantes asignados)
  const attendanceCapacityPerYear: Record<string, number> = {};
  // ✅ NUEVO: calificaciones de pruebas por año
  const testGradesPerYear: Record<string, any[]> = {};
  years.forEach(y => {
    try {
      // Exportar en formato compacto tal como está guardado para evitar expandir a millones de filas
      const compact = LocalStorageManager.getAttendanceCompactForYear(y);
      if (compact) attendancePerYear[y] = compact; else attendancePerYear[y] = [];
    } catch { attendancePerYear[y] = []; }
    try {
      // Calcular capacidad para este año
      const cfgRaw = localStorage.getItem(`admin-calendar-${y}`);
      let cfg: any = null; try { cfg = cfgRaw ? JSON.parse(cfgRaw) : null; } catch { cfg = cfgRaw; }
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch {/* ignore */} }
      const pad = (n: number) => String(n).padStart(2, '0');
      const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const inRange = (date: Date, range?: { start?: string; end?: string }) => {
        if (!range?.start || !range?.end) return false;
        const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const parseLocal = (ymd: string) => { const [yy, mm, dd] = ymd.split('-').map(Number); return new Date(yy, (mm||1)-1, dd||1); };
        const a = parseLocal(range.start).getTime();
        const b = parseLocal(range.end).getTime();
        const [min, max] = a <= b ? [a, b] : [b, a];
        return t >= min && t <= max;
      };
      const start = new Date(Number(y), 0, 1);
      const end = new Date(Number(y), 11, 31);
      let availableDays = 0; const d = new Date(start);
      const holidays: string[] = Array.isArray(cfg?.holidays) ? cfg.holidays : [];
      while (d <= end) {
        const dow = d.getDay(); const isWeekday = dow >= 1 && dow <= 5;
        if (isWeekday && !inRange(d, cfg?.summer) && !inRange(d, cfg?.winter) && !holidays.includes(keyOf(d))) {
          availableDays++;
        }
        d.setDate(d.getDate() + 1);
      }
      const students = LocalStorageManager.getStudentsForYear(Number(y)) || [];
      const assignedStudentsCount = students.filter((s: any) => s.courseId && s.sectionId).length;
      const capacity = availableDays * assignedStudentsCount;
      if (capacity > 0) attendanceCapacityPerYear[String(y)] = capacity;

      const s = LocalStorageManager.getAttendanceSummary(Number(y));
      if (s) attendanceSummaryPerYear[y] = { ...s, capacity };
    } catch {}
    try {
      const tg = LocalStorageManager.getTestGradesForYear(Number(y));
      testGradesPerYear[String(y)] = Array.isArray(tg) ? tg : [];
    } catch { testGradesPerYear[String(y)] = []; }
  });

      // =====================================
      // 🔄 Paso adicional: Recolectar datos SQL por año
      // =====================================
      const yearsForSQL = [...new Set([selectedYear, ...years])].sort();
      const usingSupabase = isSupabaseEnabled();
      const gradesByYear: Record<string, any[]> = {};
      const activitiesByYear: Record<string, any[]> = {};
      const attendanceSQLByYear: Record<string, any[]> = {};
      // Intentar obtener funciones del backend dinámico
      const backendSQL: any = usingSupabase ? __sqlDatabase : sqlDB;
      for (const y of yearsForSQL) {
        try {
          // Calificaciones
          if (backendSQL.getGradesByYear) {
            const res = await backendSQL.getGradesByYear(Number(y));
            const arr = Array.isArray(res?.grades) ? res.grades : Array.isArray(res) ? res : [];
            if (arr.length) gradesByYear[String(y)] = arr;
          }
        } catch (e) { console.warn('[EXPORT SQL] No se pudieron leer calificaciones año', y, e); }
        try {
          // Actividades
            if (backendSQL.getActivitiesByYear) {
              const resA = await backendSQL.getActivitiesByYear(Number(y));
              const arrA = Array.isArray(resA?.activities) ? resA.activities : Array.isArray(resA) ? resA : [];
              if (arrA.length) activitiesByYear[String(y)] = arrA;
            }
        } catch (e) { console.warn('[EXPORT SQL] No se pudieron leer actividades año', y, e); }
        try {
          // Asistencia (SQL)
          if (backendSQL.getAttendanceByYear) {
            const resAt = await backendSQL.getAttendanceByYear(Number(y));
            const arrAt = Array.isArray(resAt?.attendance) ? resAt.attendance : Array.isArray(resAt) ? resAt : [];
            if (arrAt.length) attendanceSQLByYear[String(y)] = arrAt;
          }
        } catch (e) { console.warn('[EXPORT SQL] No se pudieron leer asistencia SQL año', y, e); }
      }
  tick('procesando');
      const sqlExportMeta = {
        provider: usingSupabase ? 'supabase' : 'indexeddb',
        years: Object.keys(gradesByYear).length || Object.keys(attendanceSQLByYear).length || Object.keys(activitiesByYear).length ? yearsForSQL : [],
        totalGrades: Object.values(gradesByYear).reduce((a, b) => a + b.length, 0),
        totalActivities: Object.values(activitiesByYear).reduce((a, b) => a + b.length, 0),
        totalAttendance: Object.values(attendanceSQLByYear).reduce((a, b) => a + b.length, 0),
        exportedAt: new Date().toISOString()
      };
      if (sqlExportMeta.totalGrades || sqlExportMeta.totalActivities || sqlExportMeta.totalAttendance) {
        console.log('🗄️ [EXPORT SQL] Respaldo SQL incluido:', sqlExportMeta);
      } else {
        console.log('🗄️ [EXPORT SQL] No se encontraron datos SQL para respaldar (puede estar vacío o no inicializado)');
      }

      const data = {
        // Legacy flat (último año seleccionado) para compatibilidad
        courses: LocalStorageManager.getCoursesForYear(selectedYear),
        sections: LocalStorageManager.getSectionsForYear(selectedYear),
        subjects: LocalStorageManager.getSubjectsForYear(selectedYear),
        students: LocalStorageManager.getStudentsForYear(selectedYear),
        teachers: LocalStorageManager.getTeachersForYear(selectedYear),
        assignments: LocalStorageManager.getStudentAssignmentsForYear(selectedYear),
        // Year-aware completo
        perYear,
  attendancePerYear,
  attendanceSummaryPerYear,
        config: LocalStorageManager.getConfig(),
        // Agregar usuarios administradores
  administrators: safeGet<any[]>('smart-student-administrators', []),
        // Agregar asignaciones de profesores a cursos-secciones
  teacherAssignments: safeGet<any[]>('smart-student-teacher-assignments', []),
        // ✅ NUEVA CARACTERÍSTICA: Incluir asignaciones de estudiantes
  studentAssignments: safeGet<any[]>('smart-student-student-assignments', []),
        // ✅ NUEVO: Incluir tareas/evaluaciones/comentarios/notificaciones/resultados/ asistencia
    tasks: safeGet<any[]>('smart-student-tasks', []),
    taskComments: safeGet<any[]>('smart-student-task-comments', []),
    taskNotifications: safeGet<any[]>('smart-student-task-notifications', []),
  evaluations: safeGet<any[]>('smart-student-evaluations', []),
  attendance: LocalStorageManager.getAttendanceForYear(selectedYear),
  // ✅ NUEVO: resultados de evaluaciones y calificaciones de pruebas
  evaluationResults: safeGet<any[]>('smart-student-evaluation-results', []),
  // Calificaciones (compatibilidad: año seleccionado) y por año
  testGrades: (function(){ try { return LocalStorageManager.getTestGradesForYear(selectedYear) || []; } catch { return []; } })(),
  testGradesPerYear,
  // ✅ NUEVO: Incluir configuraciones del calendario admin por año
        calendarConfigs,
  // ✅ NUEVO: Incluir semestres académicos (1er y 2º)
  // Mantener compatibilidad: exportar en la clave "semesters" (fallback UI) y también en
  // el formato de exportación avanzada bajo "smart-student-semesters" si el importador lo usa.
  semesters,
  'smart-student-semesters': semesters,
  // ✅ NUEVO: capacidad anual de asistencia por año (días hábiles x estudiantes asignados)
  attendanceCapacityPerYear,
        // ✅ NUEVO: Comunicaciones creadas por profesores dirigidas a estudiantes/curso-sección
        communications: collectTeacherCommunications(),
        // ✅ NUEVO: Presentaciones compartidas por profesor (solo shared, por usuario)
        slidesByUser: collectAllSharedSlidesByUser(),
        // ✅ NUEVO: Incluir pruebas por profesor/usuario, historiales y notas de pruebas
  testsByUser: collectAllTestsByUser(),
  testReviews: collectAllTestReviews(),
        // ✅ USUARIOS PRINCIPALES CON CAMPOS COMPLETOS PARA LOGIN
        users: exportUsers,
        // ✅ METADATOS DE CORRECCIÓN DINÁMICA
        metadatos: {
          version: '2.2.0',
          tipoExportacion: 'completa-con-asignaciones',
          fechaExportacion: new Date().toISOString(),
          includeAsignaciones: true,
          sistemaCorreccionDinamica: typeof window.regenerarAsignacionesDinamicas === 'function',
          // ✅ Calendarios incluidos
          calendarYears,
          calendarConfigsCount: calendarYears.length,
          includeTests: true,
          includeGrades: true,
          includeCommunications: true,
          includeSlidesByUser: true,
          calendarAwareAttendance: true
        },
    exportDate: new Date().toISOString(),
  version: '2.6', // 2.6: añade respaldo SQL (grades/activities/attendance)
    // ✅ NUEVO: Respaldo SQL centralizado
    sqlBackup: {
      meta: sqlExportMeta,
      gradesByYear,
      activitiesByYear,
      attendanceByYear: attendanceSQLByYear
    }
      };

  logExport('Empaquetando datos para descarga...');

      // Stringify robusto: manejar BigInt y reducir formato si es necesario
      const replacer = (_k: string, v: any) => (typeof v === 'bigint' ? Number(v) : v);
      let dataStr: string;
      try {
        dataStr = JSON.stringify(data, replacer, 2);
      } catch (e1) {
        console.warn('[EXPORT] stringify pretty falló, reintentando sin pretty:', e1);
        dataStr = JSON.stringify(data, replacer);
      }
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(dataBlob);
      link.download = `smart-student-backup-${new Date().toISOString().split('T')[0]}.json`;
      link.click();

      tick('finalizando');

      toast({
        title: translate('configExportSuccessTitle') || 'Exportación exitosa',
        description: (sqlExportMeta.totalGrades || sqlExportMeta.totalAttendance || sqlExportMeta.totalActivities)
          ? 'Datos + SQL respaldados (calificaciones / actividades / asistencia)'
          : (translate('configExportSuccessDescription') || 'Datos exportados con campos completos para login. La importación será automática.'),
        variant: 'default'
      });
      setExportProgress(prev => prev ? { ...prev, phase: 'completado', current: prev.total, success: (prev.success||0)+1, logs: [...(prev.logs||[]), '✅ Exportación completada'] } as any : prev);
      // Refrescar ventana con año actual por defecto
      try { localStorage.setItem('admin-selected-year', String(new Date().getFullYear())); } catch {}
      setTimeout(() => { try { window.location.reload(); } catch {} }, 1200);
    } catch (error) {
      console.error('❌ [EXPORT ERROR] Error exportando datos:', error);
      toast({
        title: translate('configExportErrorTitle') || 'Error en exportación',
        description: (error as Error)?.message || (translate('configExportErrorDescription') || 'No se pudieron exportar los datos'),
        variant: 'destructive'
      });
      setExportProgress(prev => prev ? { ...prev, phase: 'error', errors: (prev.errors||0)+1, logs: [...(prev.logs||[]), `❌ Error: ${(error as Error)?.message || 'Error desconocido'}`] } as any : prev);
    }
  };

  // Extraer lógica principal de importación para reutilizarla desde el modal
  const performImport = async (importedData: any, inputEl?: HTMLInputElement | null) => {
    // Watchdog para evitar que el modal quede sin estado terminal en casos extremos
    let importWatchdog: any;
    try {
      console.log('📥 [IMPORTACIÓN] Aplicando datos importados (modal del proyecto)...');
      // === Modal de progreso de importación ===
      const steps = 10; // aproximado
      setShowImportModal(true);
      setImportProgress({
        phase: 'conectando',
        current: 0,
        total: steps,
        success: 0,
        errors: 0,
        logs: ['Iniciando importación...'],
        startTime: Date.now(),
        elapsedTime: 0
      } as any);
      // Watchdog deslizante de 3 minutos: se reinicia con cada avance y fuerza recarga al vencer
      const resetImportWatchdog = () => {
        try { if (importWatchdog) clearTimeout(importWatchdog); } catch {}
        try {
          importWatchdog = window.setTimeout(() => {
            setImportProgress(prev => {
              if (!prev || prev.phase === 'completado' || prev.phase === 'error') return prev as any;
              const now = Date.now();
              return {
                ...prev,
                phase: 'completado',
                current: prev.total,
                logs: [...(prev.logs||[]), '⚠️ Finalización forzada por tiempo máximo. Se recargará para aplicar cambios.'],
                elapsedTime: now - (prev.startTime || now)
              } as any;
            });
            // Asegurar año actual y recargar
            try { localStorage.setItem('admin-selected-year', String(new Date().getFullYear())); } catch {}
            try { window.setTimeout(() => { try { window.location.reload(); } catch {} }, 1200); } catch {}
          }, 180_000);
        } catch {}
      };

      const logImp = (msg: string) => { resetImportWatchdog(); setImportProgress(prev => prev ? { ...prev, logs: [...(prev.logs||[]), msg] } as any : prev); };
      const tickImp = (phase?: string) => { resetImportWatchdog(); setImportProgress(prev => prev ? { ...prev, current: Math.min((prev.current||0)+1, prev.total||steps), phase: (phase as any) || prev.phase } as any : prev); };

      // Activar watchdog inicial
      resetImportWatchdog();

      // 1) Intentar flujo avanzado si está disponible
  if (typeof window.importarDesdeAdmin === 'function' && inputEl) {
        console.log('📦 [IMPORTACIÓN AVANZADA] Usando importarDesdeAdmin(input)');
        // Forzar año actual por defecto previo a eventos/recarga
        try { localStorage.setItem('admin-selected-year', String(new Date().getFullYear())); } catch {}

  // Disparar importador avanzado
        window.importarDesdeAdmin(inputEl);
        logImp('Usando importador avanzado integrado...');

        // Notificar inicio a otros módulos
        try {
          window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'import-start', source: 'admin-config' } }));
          window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'import-start' } }));
        } catch {}

        // Al detectar señales de finalización, recargar con año actual
        let didScheduleReload = false;
        let sqlReady = false;
        let pendingReloadReason: string | null = null;
        const once = (type: string, handler: any) => {
          const wrap = (ev: any) => { try { window.removeEventListener(type, wrap as any); } catch {}; handler(ev); };
          window.addEventListener(type, wrap as any, { once: true });
        };
        const scheduleReload = (reason: string) => {
          // Si SQL aún no termina, aplazar reload
          if (!sqlReady) { pendingReloadReason = reason; return; }
          if (didScheduleReload) return;
          didScheduleReload = true;
          logImp(`Finalizado por evento: ${reason}. Recargando…`);
          setImportProgress(prev => prev ? { ...prev, phase: 'completado', current: prev.total, logs: [...(prev.logs||[]), `✅ Importación completada (${reason})`], elapsedTime: Date.now() - (prev?.startTime || Date.now()) } as any : prev);
          setTimeout(() => { try { window.location.reload(); } catch {} }, 1200);
        };
        try {
          // No recargar aún en dataImported: primero migraremos SQL post-import
          once('attendanceChanged', () => scheduleReload('attendanceChanged'));
          once('studentAssignmentsChanged', () => scheduleReload('studentAssignmentsChanged'));
          once('usersUpdated', () => scheduleReload('usersUpdated'));
          // También reaccionar a cambios de catálogos base
          once('coursesChanged', () => scheduleReload('coursesChanged'));
          once('sectionsChanged', () => scheduleReload('sectionsChanged'));
        } catch {}

        // Mientras el importador avanzado procesa LocalStorage/UI, nosotros restauramos/migramos SQL desde el propio backup
        try {
          const usingSupabase = isSupabaseEnabled();
          const backend: any = usingSupabase ? __sqlDatabase : sqlDB;
          const ensureYear = (record: any, y: number) => { if (!record.year) record.year = y; return record; };
          const hasSQLBackup = Boolean(importedData?.sqlBackup && typeof importedData.sqlBackup === 'object');

          // 1.a) Si hay bloque SQL en el backup, restaurarlo
          if (hasSQLBackup) {
            const { gradesByYear, activitiesByYear, attendanceByYear } = importedData.sqlBackup as any;
            let g = 0, a = 0, at = 0;
            if (gradesByYear && backend?.insertGrades) {
              for (const [yStr, arr] of Object.entries(gradesByYear as Record<string, any[]>)) {
                if (!Array.isArray(arr) || arr.length === 0) continue;
                const y = Number(yStr);
                const normalized = (arr as any[]).map(r => ensureYear({ ...r }, y));
                const bs = usingSupabase ? 500 : 1000;
                for (let i = 0; i < normalized.length; i += bs) {
                  const batch = normalized.slice(i, i + bs);
                  try { await backend.insertGrades(batch); g += batch.length; } catch (e) { console.warn('Error insert batch grades adv', y, e); }
                }
              }
            }
            if (activitiesByYear && backend?.insertActivities) {
              for (const [yStr, arr] of Object.entries(activitiesByYear as Record<string, any[]>)) {
                if (!Array.isArray(arr) || arr.length === 0) continue;
                const y = Number(yStr);
                const normalized = (arr as any[]).map(r => ensureYear({ ...r }, y));
                const bs = usingSupabase ? 500 : 1000;
                for (let i = 0; i < normalized.length; i += bs) {
                  const batch = normalized.slice(i, i + bs);
                  try { await backend.insertActivities(batch); a += batch.length; } catch (e) { console.warn('Error insert batch activities adv', y, e); }
                }
              }
            }
            if (attendanceByYear && backend?.insertAttendance) {
              for (const [yStr, arr] of Object.entries(attendanceByYear as Record<string, any[]>)) {
                if (!Array.isArray(arr) || arr.length === 0) continue;
                const y = Number(yStr);
                const normalized = (arr as any[]).map(r => ensureYear({ ...r }, y));
                const bs = usingSupabase ? 8000 : 2000;
                for (let i = 0; i < normalized.length; i += bs) {
                  const batch = normalized.slice(i, i + bs);
                  try { await backend.insertAttendance(batch); at += batch.length; } catch (e) { console.warn('Error insert batch attendance adv', y, e); }
                }
              }
            }
            if (g || a || at) logImp(`SQL restaurado (avanzado) G:${g} A:${a} ASIS:${at}`);
            // Actualizar contadores y marcar listo inmediatamente cuando hay SQL backup
            try {
              if (countGradesByYear) await countGradesByYear(selectedYear);
              if (countAllGrades) await countAllGrades();
              if (countAttendanceByYear) await countAttendanceByYear(selectedYear);
              if (countAllAttendance) await countAllAttendance();
            } catch {}
            sqlReady = true;
            if (pendingReloadReason) scheduleReload(pendingReloadReason);
          } else {
            // 1.b) Sin bloque SQL: programar migración a SQL post-import (evita recarga temprana con solo 2k registros)
            try {
              const onPostImport = async () => {
                try {
                  const usingSupabase2 = isSupabaseEnabled();
                  const backend2: any = usingSupabase2 ? __sqlDatabase : sqlDB;
                  // Calificaciones
                  try {
                    const years: number[] = (() => {
                      const set = new Set<number>();
                      if (importedData?.testGradesPerYear && typeof importedData.testGradesPerYear === 'object') {
                        Object.keys(importedData.testGradesPerYear).forEach(k => { const n = Number(k); if (Number.isFinite(n)) set.add(n); });
                      } else if (Array.isArray(importedData?.testGrades)) { set.add(Number(selectedYear)); }
                      if (set.size === 0) set.add(Number(selectedYear));
                      return Array.from(set.values()).sort();
                    })();
                    let totalG = 0;
                    const clamp = (n: any) => { const x = Number(n); if (!isFinite(x)) return 0; return Math.max(0, Math.min(100, x)); };
                    const toISO = (v: any) => { try { const d = new Date(typeof v === 'number' ? v : (v || Date.now())); return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString(); } catch { return new Date().toISOString(); } };
                    for (const y of years) {
                      const list = ((): any[] => {
                        try { return LocalStorageManager.getTestGradesForYear(y) || []; } catch { return []; }
                      })();
                      if (!Array.isArray(list) || list.length === 0) continue;
                      const normalized = list.map((g: any) => {
                        const testId = String(g?.testId ?? g?.id ?? '');
                        const studentId = String(g?.studentId ?? '');
                        const baseId = String(g?.id || `${y}-${testId}-${studentId}`);
                        const gradedAtISO = toISO(g?.gradedAt);
                        return {
                          id: baseId,
                          testId,
                          studentId,
                          studentName: String(g?.studentName ?? ''),
                          score: clamp(g?.score),
                          courseId: g?.courseId != null ? String(g.courseId) : null,
                          sectionId: g?.sectionId != null ? String(g.sectionId) : null,
                          subjectId: g?.subjectId != null ? String(g.subjectId) : null,
                          title: String(g?.title ?? 'Nota'),
                          gradedAt: gradedAtISO,
                          year: Number(y),
                          type: ((): any => {
                            const t = String(g?.taskType || g?.type || '').toLowerCase();
                            if (t === 'tarea' || t === 'prueba' || t === 'evaluacion') return t;
                            return 'prueba';
                          })(),
                          createdAt: gradedAtISO,
                          updatedAt: gradedAtISO,
                        };
                      });
                      const bs = usingSupabase2 ? 500 : 1000;
                      for (let i = 0; i < normalized.length; i += bs) {
                        const batch = normalized.slice(i, i + bs);
                        try { await backend2.insertGrades(batch); totalG += batch.length; } catch (e) { console.warn('Error migrando grades (post-advanced) año', y, e); }
                      }
                    }
                    if (totalG) logImp(`SQL: migradas ${totalG} calificaciones (post-advanced)`);
                  } catch (e) { console.warn('Fallo migración calificaciones (post-advanced):', e); }

                  // Asistencia
                  try {
                    const yearsA: number[] = (() => {
                      const set = new Set<number>();
                      if (importedData?.attendancePerYear && typeof importedData.attendancePerYear === 'object') {
                        Object.keys(importedData.attendancePerYear).forEach(k => { const n = Number(k); if (Number.isFinite(n)) set.add(n); });
                      } else if (Array.isArray(importedData?.attendance)) { set.add(Number(selectedYear)); }
                      if (set.size === 0) set.add(Number(selectedYear));
                      return Array.from(set.values()).sort();
                    })();
                    let totalA = 0;
                    const toISOd = (v: any) => { try { const d = new Date(v); return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString(); } catch { return new Date().toISOString(); } };
                    for (const y of yearsA) {
                      let rows: any[] = [];
                      try { rows = LocalStorageManager.getAttendanceForYear(y) || []; } catch { rows = []; }
                      if (!rows.length) continue;
                      const normalized = rows.map((r: any, idx: number) => ({
                        id: String(r?.id || `${y}-${r?.studentId || r?.sid || 'unk'}-${r?.date || r?.day || r?.timestamp || idx}`),
                        date: toISOd(r?.date || r?.day || r?.timestamp || Date.now()),
                        courseId: r?.courseId != null ? String(r.courseId) : null,
                        sectionId: r?.sectionId != null ? String(r.sectionId) : null,
                        studentId: String(r?.studentId || r?.sid || ''),
                        status: ((): any => {
                          const st = String(r?.status || '').toLowerCase();
                          if (st === 'present' || r?.present === true) return 'present';
                          if (st === 'late') return 'late';
                          if (st === 'excused') return 'excused';
                          return 'absent';
                        })(),
                        present: r?.present === true ? true : undefined,
                        comment: r?.comment ? String(r.comment) : undefined,
                        createdAt: toISOd(r?.createdAt || r?.date || Date.now()),
                        updatedAt: toISOd(r?.updatedAt || r?.date || Date.now()),
                        year: Number(y),
                      }));
                      const bs = usingSupabase2 ? 8000 : 2000;
                      for (let i = 0; i < normalized.length; i += bs) {
                        const batch = normalized.slice(i, i + bs);
                        try { await backend2.insertAttendance(batch); totalA += batch.length; } catch (e) { console.warn('Error migrando asistencia (post-advanced) año', y, e); }
                      }
                    }
                    if (totalA) logImp(`SQL: migrada asistencia ${totalA} registros (post-advanced)`);
                  } catch (e) { console.warn('Fallo migración asistencia (post-advanced):', e); }

                  // Actualizar contadores y permitir reload
                  try {
                    if (countGradesByYear) await countGradesByYear(selectedYear);
                    if (countAllGrades) await countAllGrades();
                    if (countAttendanceByYear) await countAttendanceByYear(selectedYear);
                    if (countAllAttendance) await countAllAttendance();
                  } catch {}
                  sqlReady = true;
                  if (pendingReloadReason) scheduleReload(pendingReloadReason);
                } catch (e) {
                  console.warn('Error en migración SQL post-import (ruta avanzada):', e);
                }
              };
              window.addEventListener('dataImported', onPostImport, { once: true });
            } catch (e) {
              console.warn('No se pudo programar migración SQL post-import:', e);
            }
          }
        } catch (e) {
          console.warn('No se pudo restaurar/migrar SQL en ruta avanzada:', e);
          logImp('⚠️ SQL: restauración/migración no completada en ruta avanzada');
        }

        // Fallback: si nada llega en 20s, recargar igual
        try {
          window.setTimeout(() => {
            if (!didScheduleReload) scheduleReload('timeout-20s');
          }, 20_000);
        } catch {}

        tickImp('finalizando');
        // Mantener el modal listo para cerrar mientras llega el evento/timeout
        return;
      }

      // 2) Crear respaldo antes de importar
      console.log('💾 [RESPALDO] Creando respaldo de seguridad...');
      const respaldoSeguridad = {
        timestamp: new Date().toISOString(),
        'smart-student-users': JSON.parse(localStorage.getItem('smart-student-users') || '[]'),
        'smart-student-student-assignments': JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]'),
        'smart-student-teacher-assignments': JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]'),
        'smart-student-semesters': JSON.parse(localStorage.getItem('smart-student-semesters') || 'null'),
        'calendarConfigs': (function() {
          const out: Record<string, any> = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.startsWith('admin-calendar-')) {
                const raw = localStorage.getItem(k);
                if (!raw) continue;
                const year = k.replace('admin-calendar-', '');
                try { out[year] = JSON.parse(raw); } catch { out[year] = raw; }
              }
            }
          } catch {}
          return out;
        })()
      };
  localStorage.setItem('smart-student-backup-importacion', JSON.stringify(respaldoSeguridad));
  logImp('Respaldo de seguridad creado');
  tickImp('procesando');

  // =============================================
  // 3) Importar colecciones base (legacy) al año seleccionado
  if (Array.isArray(importedData.courses)) LocalStorageManager.setCoursesForYear(selectedYear, importedData.courses || []);
      if (Array.isArray(importedData.sections)) LocalStorageManager.setSectionsForYear(selectedYear, importedData.sections || []);
      // Espejo global para compatibilidad con vistas legacy
      try {
        const coursesY = LocalStorageManager.getCoursesForYear(selectedYear) || [];
        localStorage.setItem('smart-student-courses', JSON.stringify(coursesY));
        window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-courses', newValue: JSON.stringify(coursesY) }));
      } catch {}
      try {
        const sectionsY = LocalStorageManager.getSectionsForYear(selectedYear) || [];
        localStorage.setItem('smart-student-sections', JSON.stringify(sectionsY));
        window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-sections', newValue: JSON.stringify(sectionsY) }));
      } catch {}
      if (Array.isArray(importedData.subjects)) LocalStorageManager.setSubjectsForYear(selectedYear, importedData.subjects || []);
      if (Array.isArray(importedData.students)) LocalStorageManager.setStudentsForYear(selectedYear, importedData.students || []);
      if (Array.isArray(importedData.teachers)) LocalStorageManager.setTeachersForYear(selectedYear, importedData.teachers || []);
      if (Array.isArray(importedData.assignments)) {
        LocalStorageManager.setStudentAssignmentsForYear(selectedYear, importedData.assignments || []);
        try { localStorage.setItem('smart-student-student-assignments', JSON.stringify(importedData.assignments || [])); } catch {}
        try { window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-student-assignments', newValue: JSON.stringify(importedData.assignments || []) })); } catch {}
      }
  logImp('Colecciones base restauradas');
  tickImp('procesando');

      // 3b) Year-aware: perYear
      if (importedData.perYear && typeof importedData.perYear === 'object') {
        try {
          Object.entries(importedData.perYear as Record<string, any>).forEach(([yearStr, payload]) => {
            const y = Number(yearStr);
            if (!Number.isFinite(y)) return;
            if (Array.isArray(payload.courses)) LocalStorageManager.setCoursesForYear(y, payload.courses);
            if (Array.isArray(payload.sections)) LocalStorageManager.setSectionsForYear(y, payload.sections);
            if (Array.isArray(payload.subjects)) LocalStorageManager.setSubjectsForYear(y, payload.subjects);
            if (Array.isArray(payload.students)) LocalStorageManager.setStudentsForYear(y, payload.students);
            if (Array.isArray(payload.teachers)) LocalStorageManager.setTeachersForYear(y, payload.teachers);
            if (Array.isArray(payload.teacherAssignments)) LocalStorageManager.setTeacherAssignmentsForYear(y, payload.teacherAssignments);
            if (Array.isArray(payload.studentAssignments)) LocalStorageManager.setStudentAssignmentsForYear(y, payload.studentAssignments);
          });
          // Notificar cambios de asignaciones por año importado
          try { window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'import-per-year' } })); } catch {}
          try { window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'import-per-year' } })); } catch {}
          // Actualizar espejo global a partir del año seleccionado
          try {
            const coursesY = LocalStorageManager.getCoursesForYear(selectedYear) || [];
            localStorage.setItem('smart-student-courses', JSON.stringify(coursesY));
            window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-courses', newValue: JSON.stringify(coursesY) }));
          } catch {}
          try {
            const sectionsY = LocalStorageManager.getSectionsForYear(selectedYear) || [];
            localStorage.setItem('smart-student-sections', JSON.stringify(sectionsY));
            window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-sections', newValue: JSON.stringify(sectionsY) }));
          } catch {}
        } catch (e) {
          console.warn('No se pudo restaurar perYear:', e);
        }
      }
      logImp('Estructura por año restaurada');
      tickImp('procesando');

      // 3c) Asistencia por año y resúmenes
  if (importedData.attendancePerYear && typeof importedData.attendancePerYear === 'object') {
        try {
          Object.entries(importedData.attendancePerYear as Record<string, any>).forEach(([yearStr, rowsOrCompact]) => {
            const y = Number(yearStr);
            if (!Number.isFinite(y)) return;
            // Si viene compacto, guardarlo directo; si viene expandido (array), comprimir con setAttendanceForYear
    const preferSession = false; // Usar localStorage para persistencia permanente de datos importados
    if (Array.isArray(rowsOrCompact)) LocalStorageManager.setAttendanceForYear(y, rowsOrCompact, { preferSession });
    else LocalStorageManager.setAttendanceCompactForYear(y, rowsOrCompact, { preferSession });
          });
        } catch (e) {
          console.warn('No se pudo restaurar asistencia por año:', e);
        }
      }
      if (importedData.attendanceSummaryPerYear && typeof importedData.attendanceSummaryPerYear === 'object') {
        try {
          Object.entries(importedData.attendanceSummaryPerYear as Record<string, any>).forEach(([yearStr, sum]) => {
            const y = Number(yearStr);
            if (!Number.isFinite(y) || !sum) return;
            try { LocalStorageManager.setAttendanceSummary(y, sum); } catch {}
          });
        } catch (e) {
          console.warn('No se pudo restaurar resúmenes de asistencia por año:', e);
        }
      }
      logImp('Asistencia por año y resúmenes restaurados');
      tickImp('procesando');

      // 3c-2) Capacidad anual por año (opcional). Se almacena aparte y se puede recalcular desde calendarConfigs.
      if (importedData.attendanceCapacityPerYear && typeof importedData.attendanceCapacityPerYear === 'object') {
        try {
          // Guardar el mapa completo para referencia; la UI prioriza el recálculo en vivo.
          localStorage.setItem('smart-student-attendance-capacity', JSON.stringify(importedData.attendanceCapacityPerYear));
        } catch (e) {
          console.warn('No se pudo almacenar attendanceCapacityPerYear:', e);
        }
      }

      // Config
      if (importedData.config) {
        LocalStorageManager.setConfig(importedData.config);
        setConfig({ ...config, ...importedData.config });
      }
      logImp('Configuración del sistema aplicada');
      tickImp('procesando');

      // 3d) Reconstrucción de asignaciones de estudiantes por año desde asistencia si faltan
      try {
        const attYears: number[] = [];
        if (importedData.attendancePerYear && typeof importedData.attendancePerYear === 'object') {
          for (const y of Object.keys(importedData.attendancePerYear)) {
            const n = Number(y); if (Number.isFinite(n)) attYears.push(n);
          }
        }
        // Incluir el año seleccionado si se importó asistencia global
        if (Array.isArray(importedData.attendance) && importedData.attendance.length > 0) {
          if (!attYears.includes(selectedYear)) attYears.push(selectedYear);
        }
        for (const y of attYears) {
          try {
            const existing = LocalStorageManager.getStudentAssignmentsForYear(y) || [];
            if (existing.length > 0) continue;
            // Intentar leer asistencia en formato compacto para extraer [studentId, courseId, sectionId]
            const compact = LocalStorageManager.getAttendanceCompactForYear(y);
            const triples = new Set<string>(); // key: studentId|courseId|sectionId
            if (compact && compact.fmt === 'exceptions-v2' && typeof compact.s === 'string') {
              const rows = String(compact.s).split('|');
              for (const row of rows) {
                if (!row) continue;
                const [sid, cid, secid] = row.split(',');
                if (sid && secid) triples.add(`${sid}|${cid || ''}|${secid}`);
              }
            } else {
              // Fallback: expandido (puede ser pesado, pero es último recurso)
              const expanded = LocalStorageManager.getAttendanceForYear(y) || [];
              for (const r of expanded) {
                const sid = String(r.studentId || '');
                const cid = String(r.courseId || '');
                const secid = String(r.sectionId || '');
                if (sid && secid) triples.add(`${sid}|${cid}|${secid}`);
              }
            }
            if (triples.size > 0) {
              const nowIso = new Date().toISOString();
              const rebuilt = Array.from(triples).map((k) => {
                const [sid, cid, secid] = k.split('|');
                return {
                  id: `sa-${sid}-${secid}`,
                  studentId: sid,
                  courseId: cid,
                  sectionId: secid,
                  isActive: true,
                  assignedAt: nowIso,
                  source: 'rebuild-from-attendance'
                };
              });
              LocalStorageManager.setStudentAssignmentsForYear(y, rebuilt);
              try { window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'rebuild-from-attendance', year: y } })); } catch {}
            }
          } catch (e) {
            console.warn('Reconstrucción de studentAssignments falló para año', y, e);
          }
        }
      } catch (e) {
        console.warn('No se pudo ejecutar reconstrucción de asignaciones desde asistencia:', e);
      }

      // Calendario admin
      if (importedData.calendarConfigs && typeof importedData.calendarConfigs === 'object') {
        console.log('📅 [CALENDARIO] Restaurando configuraciones de calendario admin por año...');
        try {
          let restoredCount = 0;
          Object.entries(importedData.calendarConfigs).forEach(([year, cfg]) => {
            try {
              const y = String(year).trim();
              if (!/^[0-9]{4}$/.test(y)) return;
              const key = `admin-calendar-${y}`;
              const value = typeof cfg === 'string' ? cfg : JSON.stringify(cfg);
              localStorage.setItem(key, value);
              restoredCount++;
            } catch (e) {
              console.warn('No se pudo restaurar configuración de calendario para año', year, e);
            }
          });
          console.log(`📅 [CALENDARIO] Años restaurados: ${restoredCount}`);
        } catch (e) {
          console.warn('Error restaurando configuraciones de calendario admin:', e);
        }
      }
      logImp('Calendarios de administrador restaurados');
      tickImp('procesando');

      // Semestres
      const importedSemesters = importedData['smart-student-semesters'] || importedData.semesters;
      if (importedSemesters) {
        try {
          localStorage.setItem('smart-student-semesters', JSON.stringify(importedSemesters));
          console.log('📚 [SEMESTRES] Restaurados semestres académicos');
        } catch (e) {
          console.warn('No se pudieron restaurar los semestres académicos:', e);
        }
      }

      // Administradores y asignaciones de profesores
      if (importedData.administrators) {
        localStorage.setItem('smart-student-administrators', JSON.stringify(importedData.administrators));
      }
      if (Array.isArray(importedData.teacherAssignments) && importedData.teacherAssignments.length > 0) {
        LocalStorageManager.setTeacherAssignmentsForYear(selectedYear, importedData.teacherAssignments);
        try { window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'import', year: selectedYear } })); } catch {}
      }

      // Asignaciones de estudiantes
      if (Array.isArray(importedData.studentAssignments) && importedData.studentAssignments.length > 0) {
        LocalStorageManager.setStudentAssignmentsForYear(selectedYear, importedData.studentAssignments);
        try { localStorage.setItem('smart-student-student-assignments', JSON.stringify(importedData.studentAssignments)); } catch {}
        try { window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-student-assignments', newValue: JSON.stringify(importedData.studentAssignments) })); } catch {}
        try { window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'import', year: selectedYear } })); } catch {}
      }
      logImp('Usuarios y asignaciones restaurados');
      tickImp('procesando');

      // Colecciones adicionales
      if (importedData.tasks) localStorage.setItem('smart-student-tasks', JSON.stringify(importedData.tasks));
      if (importedData.taskComments) localStorage.setItem('smart-student-task-comments', JSON.stringify(importedData.taskComments));
      if (importedData.taskNotifications) localStorage.setItem('smart-student-task-notifications', JSON.stringify(importedData.taskNotifications));
      if (importedData.evaluations) localStorage.setItem('smart-student-evaluations', JSON.stringify(importedData.evaluations));
  if (Array.isArray(importedData.attendance) && importedData.attendance.length > 0) LocalStorageManager.setAttendance(importedData.attendance);
  if (importedData.evaluationResults) localStorage.setItem('smart-student-evaluation-results', JSON.stringify(importedData.evaluationResults));
  // ✅ Importar calificaciones de pruebas por año
  (function(){
    const preferSession = true;
    const { LocalStorageManager } = require('@/lib/education-utils');
    try {
      if (importedData.testGradesPerYear && typeof importedData.testGradesPerYear === 'object') {
        Object.entries(importedData.testGradesPerYear as Record<string, any[]>).forEach(([yearStr, arr]) => {
          const y = Number(yearStr);
          if (!Number.isFinite(y)) return;
          try { LocalStorageManager.setTestGradesForYear(y, Array.isArray(arr) ? arr : [], { preferSession }); } catch {}
          try {
            const key = LocalStorageManager.keyForTestGrades(y);
            window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(arr || []) }));
          } catch {}
        });
        return; // Finalizado vía per-year
      }
      // Compatibilidad: si viene testGrades plano, asignarlo al año seleccionado
      if (Array.isArray(importedData.testGrades)) {
        try { LocalStorageManager.setTestGradesForYear(selectedYear, importedData.testGrades, { preferSession }); } catch {}
        try {
          const key = LocalStorageManager.keyForTestGrades(selectedYear);
          window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(importedData.testGrades) }));
        } catch {}
      }
    } catch (e) {
      console.warn('No se pudieron importar calificaciones de pruebas:', e);
    }
  })();
    logImp('Calificaciones de pruebas restauradas');
    tickImp('procesando');

      // 🚀 Migración inmediata a SQL si el backup no traía bloque SQL
      try {
        const hasSQLGradesBackup = Boolean(importedData?.sqlBackup && (importedData.sqlBackup as any)?.gradesByYear);
        if (!hasSQLGradesBackup) {
          const usingSupabase = isSupabaseEnabled();
          const backend: any = usingSupabase ? __sqlDatabase : sqlDB;
          if (backend && backend.insertGrades) {
            logImp('SQL: migrando calificaciones importadas a SQL por año…');
            const yearsToMigrate: number[] = (() => {
              const set = new Set<number>();
              try {
                if (importedData?.testGradesPerYear && typeof importedData.testGradesPerYear === 'object') {
                  Object.keys(importedData.testGradesPerYear).forEach(k => { const y = Number(k); if (Number.isFinite(y)) set.add(y); });
                } else if (Array.isArray(importedData?.testGrades)) {
                  set.add(Number(selectedYear));
                }
              } catch {}
              // Si no pudimos inferir, al menos el año seleccionado
              if (set.size === 0) set.add(Number(selectedYear));
              return Array.from(set.values()).sort();
            })();

            let totalInserted = 0;
            const clamp = (n: any) => {
              const x = Number(n); if (!isFinite(x)) return 0; return Math.max(0, Math.min(100, x));
            };
            const toISO = (v: any) => { try { const d = new Date(typeof v === 'number' ? v : (v || Date.now())); return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString(); } catch { return new Date().toISOString(); } };

            // Notificar inicio de migración a SQL
            try { window.dispatchEvent(new CustomEvent('sqlMigrationStarted', { detail: { years: yearsToMigrate } })); } catch {}

            for (const y of yearsToMigrate) {
              try {
                const list = ((): any[] => {
                  try { return LocalStorageManager.getTestGradesForYear(y) || []; } catch { return []; }
                })();
                if (!Array.isArray(list) || list.length === 0) { logImp(`SQL: año ${y} sin calificaciones para migrar`); continue; }
                // Normalizar al esquema SQL
                const normalized = list.map((g: any) => {
                  const testId = String(g?.testId ?? g?.id ?? '');
                  const studentId = String(g?.studentId ?? '');
                  const baseId = String(g?.id || `${y}-${testId}-${studentId}`);
                  const gradedAtISO = toISO(g?.gradedAt);
                  return {
                    id: baseId,
                    testId,
                    studentId,
                    studentName: String(g?.studentName ?? ''),
                    score: clamp(g?.score),
                    courseId: g?.courseId != null ? String(g.courseId) : null,
                    sectionId: g?.sectionId != null ? String(g.sectionId) : null,
                    subjectId: g?.subjectId != null ? String(g.subjectId) : null,
                    title: String(g?.title ?? 'Nota'),
                    gradedAt: gradedAtISO,
                    year: Number(y),
                    type: ((): any => {
                      const t = String(g?.taskType || g?.type || '').toLowerCase();
                      if (t === 'tarea' || t === 'prueba' || t === 'evaluacion') return t;
                      return 'prueba';
                    })(),
                    createdAt: gradedAtISO,
                    updatedAt: gradedAtISO,
                  };
                });

                // Insertar en lotes
                const batchSize = usingSupabase ? 500 : 1000;
                let insertedY = 0;
                for (let i = 0; i < normalized.length; i += batchSize) {
                  const batch = normalized.slice(i, i + batchSize);
                  try { await backend.insertGrades(batch); insertedY += batch.length; totalInserted += batch.length; }
                  catch (e) { console.warn('Error migrando lote SQL', { year: y, from: i, to: i + batch.length }, e); }
                }
                logImp(`SQL: año ${y} migrado (${insertedY} calificaciones)`);
                try { window.dispatchEvent(new CustomEvent('sqlGradesUpdated', { detail: { year: y, migrated: insertedY } })); } catch {}
              } catch (e) {
                console.warn('No se pudo migrar año a SQL:', y, e);
                logImp(`⚠️ SQL: no se pudo migrar año ${y}`);
              }
            }
            logImp(`SQL: migración completada (${totalInserted} calificaciones)`);
            // Notificar fin de migración
            try { window.dispatchEvent(new CustomEvent('sqlMigrationCompleted', { detail: { years: yearsToMigrate, totalInserted } })); } catch {}
          }
        }
      } catch (e) {
        console.warn('Error en migración inmediata a SQL:', e);
        logImp('⚠️ SQL: migración inmediata fallida');
      }

      // 🚀 NUEVO: Migración inmediata de Asistencia a SQL si el backup no traía bloque SQL
      try {
        const hasSQLAttendanceBackup = Boolean(importedData?.sqlBackup && (importedData.sqlBackup as any)?.attendanceByYear);
        if (!hasSQLAttendanceBackup) {
          const usingSupabase = isSupabaseEnabled();
          const backend: any = usingSupabase ? __sqlDatabase : sqlDB;
          if (backend && backend.insertAttendance) {
            logImp('SQL: migrando asistencia importada a SQL por año…');
            const yearsToMigrate: number[] = (() => {
              const set = new Set<number>();
              try {
                if (importedData?.attendancePerYear && typeof importedData.attendancePerYear === 'object') {
                  Object.keys(importedData.attendancePerYear).forEach(k => { const y = Number(k); if (Number.isFinite(y)) set.add(y); });
                } else if (Array.isArray(importedData?.attendance)) {
                  set.add(Number(selectedYear));
                }
              } catch {}
              if (set.size === 0) set.add(Number(selectedYear));
              return Array.from(set.values()).sort();
            })();

            let totalInserted = 0;
            const toISO = (v: any) => { try { const d = new Date(typeof v === 'number' ? v : (v || Date.now())); return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString(); } catch { return new Date().toISOString(); } };
            for (const y of yearsToMigrate) {
              try {
                // Intentar expandido directo si viene así; si viene compacto, dependerá de que el importador avanzado lo expanda a LocalStorage
                let rows: any[] = [];
                const payload = (importedData?.attendancePerYear || {})[String(y)];
                if (Array.isArray(payload)) rows = payload;
                else if (Array.isArray(importedData?.attendance) && y === Number(selectedYear)) rows = importedData.attendance;
                if (!rows.length) { logImp(`SQL: año ${y} sin asistencia expandida para migrar (fallback)`); continue; }
                const normalized = rows.map((r: any, idx: number) => ({
                  id: String(r?.id || `${y}-${r?.studentId || 'unk'}-${r?.date || idx}`),
                  date: toISO(r?.date || r?.day || r?.timestamp || Date.now()),
                  courseId: r?.courseId != null ? String(r.courseId) : null,
                  sectionId: r?.sectionId != null ? String(r.sectionId) : null,
                  studentId: String(r?.studentId || r?.sid || ''),
                  status: ((): any => { const st = String(r?.status || '').toLowerCase(); if (st === 'present' || r?.present === true) return 'present'; if (st === 'late') return 'late'; if (st === 'excused') return 'excused'; return 'absent'; })(),
                  present: r?.present === true ? true : undefined,
                  comment: r?.comment ? String(r.comment) : undefined,
                  createdAt: toISO(r?.createdAt || r?.date || Date.now()),
                  updatedAt: toISO(r?.updatedAt || r?.date || Date.now()),
                  year: Number(y),
                }));
                const batchSize = usingSupabase ? 8000 : 2000;
                let insertedY = 0;
                for (let i = 0; i < normalized.length; i += batchSize) {
                  const batch = normalized.slice(i, i + batchSize);
                  try { await backend.insertAttendance(batch); insertedY += batch.length; totalInserted += batch.length; }
                  catch (e) { console.warn('Error migrando lote asistencia SQL', { year: y, from: i, to: i + batch.length }, e); }
                }
                logImp(`SQL: año ${y} migrado asistencia (${insertedY} registros)`);
                try { window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { year: y, migrated: insertedY } })); } catch {}
              } catch (e) {
                console.warn('No se pudo migrar asistencia año a SQL:', y, e);
                logImp(`⚠️ SQL: no se pudo migrar asistencia año ${y}`);
              }
            }
            logImp(`SQL: migración asistencia completada (${totalInserted} registros)`);
          }
        }
      } catch (e) {
        console.warn('Error en migración inmediata de asistencia a SQL:', e);
        logImp('⚠️ SQL: migración inmediata asistencia fallida');
      }

      // =============================================
      // 🔄 Importar respaldo SQL si está presente
      // Estructura esperada: importedData.sqlBackup { meta, gradesByYear, activitiesByYear, attendanceByYear }
      let sqlImportStats: { grades: number; activities: number; attendance: number } | null = null;
      if (importedData.sqlBackup && typeof importedData.sqlBackup === 'object') {
        try {
          const { gradesByYear, activitiesByYear, attendanceByYear } = importedData.sqlBackup as any;
          const usingSupabase = isSupabaseEnabled();
          const backend: any = usingSupabase ? __sqlDatabase : sqlDB;
          let gradesImported = 0, activitiesImported = 0, attendanceImported = 0;
          const ensureYear = (record: any, yearKey: string) => {
            if (!record.year) record.year = Number(yearKey) || selectedYear;
            return record;
          };
          // Insertar calificaciones por año
          if (gradesByYear && typeof gradesByYear === 'object' && backend.insertGrades) {
            for (const [yearStr, arr] of Object.entries(gradesByYear as Record<string, any[]>)) {
              if (!Array.isArray(arr) || arr.length === 0) continue;
              const yearNum = Number(yearStr);
              const normalized = arr.map(r => ensureYear(r, yearStr));
              // Lotes
              const batchSize = 1000;
              for (let i = 0; i < normalized.length; i += batchSize) {
                const batch = normalized.slice(i, i + batchSize);
                try { await backend.insertGrades(batch); } catch (e) { console.warn('Error insertando lote grades SQL año', yearNum, e); }
              }
              gradesImported += normalized.length;
            }
          }
          // Insertar actividades
          if (activitiesByYear && typeof activitiesByYear === 'object' && backend.insertActivities) {
            for (const [yearStr, arr] of Object.entries(activitiesByYear as Record<string, any[]>)) {
              if (!Array.isArray(arr) || arr.length === 0) continue;
              const normalized = arr.map(r => ensureYear(r, yearStr));
              const batchSize = 1000;
              for (let i = 0; i < normalized.length; i += batchSize) {
                const batch = normalized.slice(i, i + batchSize);
                try { await backend.insertActivities(batch); } catch (e) { console.warn('Error insertando lote activities SQL año', yearStr, e); }
              }
              activitiesImported += normalized.length;
            }
          }
            // Insertar asistencia SQL
          if (attendanceByYear && typeof attendanceByYear === 'object' && backend.insertAttendance) {
            for (const [yearStr, arr] of Object.entries(attendanceByYear as Record<string, any[]>)) {
              if (!Array.isArray(arr) || arr.length === 0) continue;
              const normalized = arr.map(r => ensureYear(r, yearStr));
              const batchSize = usingSupabase ? 8000 : 2000;
              for (let i = 0; i < normalized.length; i += batchSize) {
                const batch = normalized.slice(i, i + batchSize);
                try { await backend.insertAttendance(batch); } catch (e) { console.warn('Error insertando lote attendance SQL año', yearStr, e); }
              }
              attendanceImported += normalized.length;
            }
          }
          sqlImportStats = { grades: gradesImported, activities: activitiesImported, attendance: attendanceImported };
          console.log('🗄️ [SQL IMPORT] Respaldo SQL restaurado:', sqlImportStats);
          try { if (gradesImported) window.dispatchEvent(new CustomEvent('sqlGradesUpdated', { detail: { imported: gradesImported } })); } catch {}
          try { if (activitiesImported) window.dispatchEvent(new CustomEvent('sqlActivitiesUpdated', { detail: { imported: activitiesImported } })); } catch {}
          try { if (attendanceImported) window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { imported: attendanceImported } })); } catch {}
        } catch (e) {
          console.warn('No se pudo importar respaldo SQL:', e);
        }
      }
      if (sqlImportStats) logImp(`SQL restaurado G:${sqlImportStats.grades} A:${sqlImportStats.activities} ASIS:${sqlImportStats.attendance}`);
      tickImp('finalizando');

      // Notificar UI de cambios relevantes
  try { window.dispatchEvent(new CustomEvent('attendanceChanged', { detail: { action: 'import', year: selectedYear } })); } catch {}
  try { window.dispatchEvent(new CustomEvent('yearsChanged', { detail: { action: 'import' } })); } catch {}
  try { window.dispatchEvent(new CustomEvent('coursesChanged', { detail: { source: 'import' } })); } catch {}
  try { window.dispatchEvent(new CustomEvent('sectionsChanged', { detail: { source: 'import' } })); } catch {}
  // Espejo global y StorageEvent para cursos/secciones
  try {
    const coursesY = LocalStorageManager.getCoursesForYear(selectedYear) || [];
    localStorage.setItem('smart-student-courses', JSON.stringify(coursesY));
    window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-courses', newValue: JSON.stringify(coursesY) }));
  } catch {}
  try {
    const sectionsY = LocalStorageManager.getSectionsForYear(selectedYear) || [];
    localStorage.setItem('smart-student-sections', JSON.stringify(sectionsY));
    window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-sections', newValue: JSON.stringify(sectionsY) }));
  } catch {}
  try { window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', { detail: { action: 'import' } })); } catch {}
  try { window.dispatchEvent(new CustomEvent('commentsUpdated', { detail: { action: 'import' } })); } catch {}
  try { window.dispatchEvent(new CustomEvent('studentCommunicationsUpdated', { detail: { action: 'import' } })); } catch {}
  try { window.dispatchEvent(new CustomEvent('dataImported', { detail: { when: Date.now() } })); } catch {}

      // ✅ NUEVO: Comunicaciones de profesores a estudiantes/curso-sección
      if (Array.isArray(importedData.communications)) {
        try {
          localStorage.setItem('smart-student-communications', JSON.stringify(importedData.communications));
        } catch (e) {
          console.warn('No se pudieron restaurar las comunicaciones:', e);
        }
      }

      // ✅ NUEVO: Presentaciones por usuario (solo compartidas)
      if (importedData.slidesByUser && typeof importedData.slidesByUser === 'object') {
        try {
          Object.entries(importedData.slidesByUser as Record<string, any[]>).forEach(([key, arr]) => {
            if (!key || !Array.isArray(arr)) return;
            if (key.startsWith('smart-student-slides-')) {
              // Mezclar con existentes (si los hay) preservando no compartidas del entorno destino
              try {
                const existingRaw = localStorage.getItem(key);
                const existing = existingRaw ? JSON.parse(existingRaw) : [];
                const merged = Array.isArray(existing)
                  ? [
                      ...existing, // mantiene borradores locales/no compartidos
                      ...arr.filter((s: any) => s && s.shared === true && !existing.some((e: any) => e.id === s.id))
                    ]
                  : arr;
                localStorage.setItem(key, JSON.stringify(merged));
              } catch {
                localStorage.setItem(key, JSON.stringify(arr));
              }
            }
          });
        } catch (e) {
          console.warn('No se pudieron restaurar presentaciones por usuario:', e);
        }
      }

      // Pruebas y revisiones
      if (importedData.testsByUser && typeof importedData.testsByUser === 'object') {
        try {
          Object.entries(importedData.testsByUser as Record<string, any[]>).forEach(([key, arr]) => {
            if (!key || !Array.isArray(arr)) return;
            if (key === 'smart-student-tests' || key.startsWith('smart-student-tests_')) {
              localStorage.setItem(key, JSON.stringify(arr));
            }
          });
        } catch (e) {
          console.warn('No se pudieron restaurar las pruebas por usuario:', e);
        }
      }
      if (importedData.testReviews && typeof importedData.testReviews === 'object') {
        try {
          Object.entries(importedData.testReviews as Record<string, any[]>).forEach(([key, arr]) => {
            if (!key || !Array.isArray(arr)) return;
            if (key.startsWith('smart-student-test-reviews_')) {
              localStorage.setItem(key, JSON.stringify(arr));
            }
          });
        } catch (e) {
          console.warn('No se pudieron restaurar historiales de revisión:', e);
        }
      }

      // Consolidar usuarios (importación JSON): reparar campos faltantes y guardar
      if (importedData.users) {
        const consolidatedUsers = Array.isArray(importedData.users) ? [...importedData.users] : [];
        const repairedUsers = consolidatedUsers.map((user: any, index: number) => ({
          id: user.id || crypto.randomUUID(),
          username: user.username || user.name || `imported_user_${Date.now()}_${index}`,
          password: user.password || '1234',
          role: user.role || 'student',
          displayName: user.displayName || user.name || `Usuario Importado ${index + 1}`,
          activeCourses: Array.isArray(user.activeCourses) ? user.activeCourses : ((user.role || 'student') === 'admin' ? [] : ['4to Básico']),
          ...(user.subjects && { subjects: user.subjects }),
          ...(user.section && { section: user.section })
        }));
        safeSaveSmartStudentUsers(repairedUsers, 'post-import consolidate');
      }

      // Validación/corrección post-importación
      console.log('🔍 [POST-IMPORTACIÓN] Ejecutando validación y corrección automática...');
      setTimeout(() => {
        const asignacionesEstudiantes = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
        if (asignacionesEstudiantes.length === 0) {
          if (typeof window.regenerarAsignacionesDinamicas === 'function') {
            const resultado = window.regenerarAsignacionesDinamicas();
            if (resultado.exito) {
              toast({ title: 'Corrección aplicada', description: `Asignaciones de estudiantes corregidas automáticamente: ${resultado.asignacionesCreadas} asignaciones`, variant: 'default' });
            }
          } else {
            aplicarCorreccionBasicaPostImportacion();
          }
        } else if (typeof window.validarAsignacionesManualmente === 'function') {
          const validacion = window.validarAsignacionesManualmente();
          if (!validacion.esValido && typeof window.regenerarAsignacionesDinamicas === 'function') {
            window.regenerarAsignacionesDinamicas();
          }
        }

        // Despachar eventos para que otras pestañas recarguen sus datos
        try {
          window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'import-complete', source: 'admin-config' } }));
          window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'import-complete' } }));
        } catch {}
      }, 2000);

      toast({
        title: translate('configImportSuccessTitle') || 'Importación exitosa',
        description: sqlImportStats && (sqlImportStats.grades || sqlImportStats.activities || sqlImportStats.attendance)
          ? `Datos + SQL restaurados (G:${sqlImportStats.grades} / A:${sqlImportStats.activities} / ASIS:${sqlImportStats.attendance})`
          : 'Datos importados con asignaciones aplicadas automáticamente. Sistema validado y corregido.',
        variant: 'default'
      });
      setImportProgress(prev => prev ? { ...prev, phase: 'completado', current: prev.total, success: (prev.success||0)+1, logs: [...(prev.logs||[]), '✅ Importación completada'], elapsedTime: Date.now() - (prev?.startTime || Date.now()) } as any : prev);

  // Recargar para aplicar datos (fallback); los eventos ya fueron emitidos
  try { localStorage.setItem('admin-selected-year', String(new Date().getFullYear())); } catch {}
  setTimeout(() => { try { window.location.reload(); } catch {} }, 1800);
    } catch (error) {
      toast({
        title: translate('configImportErrorTitle') || 'Error en importación',
        description: translate('configImportErrorDescription') || 'No se pudieron importar los datos. Verifica el formato del archivo.',
        variant: 'destructive'
      });
      setImportProgress(prev => prev ? { ...prev, phase: 'error', errors: (prev.errors||0)+1, logs: [...(prev.logs||[]), `❌ Error: ${(error as Error)?.message || 'Error desconocido'}`], elapsedTime: Date.now() - (prev?.startTime || Date.now()) } as any : prev);
    } finally {
      try { if (importWatchdog) clearTimeout(importWatchdog); } catch {}
    }
  };

  const handleImportData = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        console.log('🚀 [IMPORTACIÓN MEJORADA] Iniciando importación con aplicación automática de asignaciones...');
        
        const importedData = JSON.parse(e.target?.result as string);
        
  // Validación flexible: aceptar si hay estructura reconocible, con o sin 'version'
  const hasBasicCollections = Array.isArray(importedData?.courses);
  const hasPerYear = importedData && typeof importedData.perYear === 'object' && Object.keys(importedData.perYear).length > 0;
  const hasUsers = Array.isArray(importedData?.users);
  const hasAttendancePerYear = importedData && typeof importedData.attendancePerYear === 'object';
  const hasMetadatos = importedData && typeof importedData.metadatos === 'object';
  const hasTasksOrEvals = Array.isArray(importedData?.tasks) || Array.isArray(importedData?.evaluations);
  const recognizable = hasBasicCollections || hasPerYear || hasUsers || hasAttendancePerYear || hasMetadatos || hasTasksOrEvals;
  if (!recognizable) {
          // Si existe importador avanzado, permitir continuar por esa vía
          if (typeof window.importarDesdeAdmin === 'function') {
            console.warn('[IMPORTACIÓN] Estructura no estándar, usando importador avanzado…');
            setPendingImportData(null);
            setPendingImportInput(event.target as HTMLInputElement);
            setShowImportConfirmDialog(true);
            return;
          }
          toast({
            title: translate('configImportErrorTitle') || 'Error en importación',
            description: translate('configInvalidFileFormat') || 'Formato de archivo inválido',
            variant: 'destructive'
          });
          return;
        }
        // Abrir modal del proyecto para confirmar
        setPendingImportData(importedData);
        setPendingImportInput(event.target as HTMLInputElement);
        setShowImportConfirmDialog(true);
      } catch (error) {
        // Si falla el parseo pero existe importador avanzado, permitir continuar con confirmación
        if (typeof window.importarDesdeAdmin === 'function') {
          console.warn('[IMPORTACIÓN] JSON inválido, pero se detectó importador avanzado. Continuando con importación avanzada…');
          setPendingImportData(null);
          setPendingImportInput(event.target as HTMLInputElement);
          setShowImportConfirmDialog(true);
          return;
        }
        toast({
          title: translate('configImportErrorTitle') || 'Error en importación',
          description: translate('configImportErrorDescription') || 'No se pudieron importar los datos. Verifica el formato del archivo.',
          variant: 'destructive'
        });
      }
    };

    reader.readAsText(file);
    // No limpiar aún: se limpiará al confirmar/cancelar en el modal
  };

  // Helper: guardar smart-student-users con fallback de tamaño
  const safeSaveSmartStudentUsers = (users: any[], context?: string): boolean => {
    const key = 'smart-student-users';
    const setRaw = (arr: any[]) => localStorage.setItem(key, JSON.stringify(arr));
    const slimUser = (u: any) => {
      const out: any = {
        id: u.id,
        username: u.username,
        role: u.role,
        displayName: u.displayName || u.name,
        password: u.password,
        email: u.email,
        rut: u.rut,
        isActive: u.isActive !== false,
        activeCourses: Array.isArray(u.activeCourses) ? (u.activeCourses.slice(0, 1)) : (u.role === 'admin' ? [] : ['4to Básico']),
        courseId: u.courseId,
        sectionId: u.sectionId,
      };
      return out;
    };
    const ultraSlimUser = (u: any) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      displayName: u.displayName || u.name,
      password: u.password,
    });
    try {
      setRaw(users);
      try { localStorage.setItem(key + '__quality', 'full'); } catch {}
      return true;
    } catch (e1) {
      console.warn('[Quota] Guardado full falló, intentando slim…', e1);
      try {
        const slim = Array.isArray(users) ? users.map(slimUser) : [];
        setRaw(slim);
        try { localStorage.setItem(key + '__quality', 'slim'); } catch {}
        toast({ title: translate('storageAlmostFull') || 'Almacenamiento casi lleno', description: (translate('storageSavedSlim') || 'Se guardó una versión ligera de los usuarios') + (context ? ` (${context})` : ''), variant: 'destructive' });
        return true;
      } catch (e2) {
        console.warn('[Quota] Guardado slim falló, intentando ultra…', e2);
        try {
          const ultra = Array.isArray(users) ? users.map(ultraSlimUser) : [];
          setRaw(ultra);
          try { localStorage.setItem(key + '__quality', 'ultra'); } catch {}
          toast({ title: translate('storageAlmostFull') || 'Almacenamiento casi lleno', description: (translate('storageSavedUltraSlim') || 'Se guardó una versión ultra-ligera de los usuarios') + (context ? ` (${context})` : ''), variant: 'destructive' });
          return true;
        } catch (e3) {
          console.warn('[Quota] Guardado ultra falló, moviendo a sessionStorage…', e3);
          try {
            sessionStorage.setItem(key, JSON.stringify(users));
            localStorage.setItem(key, '[]');
            localStorage.setItem(key + '__where', 'session');
            try { localStorage.setItem(key + '__quality', 'session-full'); } catch {}
            toast({ title: translate('storageExceeded') || 'Almacenamiento excedido', description: translate('storageUsersStoredInSession') || 'Usuarios guardados temporalmente en sessionStorage. Algunas funciones podrían ser limitadas.', variant: 'destructive' });
            return true;
          } catch (e4) {
            console.error('[Quota] No fue posible guardar usuarios en ningún formato.', e4);
            toast({ title: translate('error') || 'Error', description: translate('storageUsersNotSaved') || 'No se pudieron guardar los usuarios por límite del navegador.', variant: 'destructive' });
            return false;
          }
        }
      }
    }
  };

  // ✅ NUEVA FUNCIÓN: Aplicar corrección básica post-importación
  const aplicarCorreccionBasicaPostImportacion = () => {
    try {
      console.log('🔧 [CORRECCIÓN POST-IMPORTACIÓN] Aplicando corrección básica...');
      
      const usuarios = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const cursos = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      const secciones = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
      
      const estudiantes = usuarios.filter((u: any) => u.role === 'student' || u.role === 'estudiante');
      const asignacionesBasicas: any[] = [];
      
      estudiantes.forEach((estudiante: any) => {
        let cursoAsignado: any = null;
        let seccionAsignada: any = null;
        
        // Usar información existente del estudiante
        if (estudiante.courseId && estudiante.sectionId) {
          cursoAsignado = cursos.find((c: any) => c.id === estudiante.courseId);
          seccionAsignada = secciones.find((s: any) => s.id === estudiante.sectionId);
        } else if (estudiante.activeCourses && estudiante.activeCourses.length > 0) {
          const nombreCurso = estudiante.activeCourses[0];
          cursoAsignado = cursos.find((c: any) => 
            c.name === nombreCurso || c.name.includes(nombreCurso.split(' ')[0])
          );
          if (cursoAsignado) {
            const seccionesCurso = secciones.filter((s: any) => s.courseId === cursoAsignado.id);
            seccionAsignada = seccionesCurso[0];
          }
        } else if (cursos.length > 0) {
          cursoAsignado = cursos[0];
          const seccionesCurso = secciones.filter((s: any) => s.courseId === cursoAsignado.id);
          seccionAsignada = seccionesCurso[0];
        }
        
        if (cursoAsignado && seccionAsignada) {
          asignacionesBasicas.push({
            id: `${estudiante.id}-${seccionAsignada.id}-${Date.now()}-${Math.random()}`,
            studentId: estudiante.id,
            courseId: cursoAsignado.id,
            sectionId: seccionAsignada.id,
            assignedAt: new Date().toISOString(),
            isActive: true
          });
        }
      });
      
      if (asignacionesBasicas.length > 0) {
        localStorage.setItem('smart-student-student-assignments', JSON.stringify(asignacionesBasicas));
        console.log(`✅ [CORRECCIÓN POST-IMPORTACIÓN] ${asignacionesBasicas.length} asignaciones básicas creadas`);
        
        toast({
          title: 'Corrección aplicada',
          description: `${asignacionesBasicas.length} asignaciones de estudiantes creadas automáticamente`,
          variant: 'default'
        });
      }
      
    } catch (error) {
      console.error('❌ [ERROR CORRECCIÓN] Error en corrección post-importación:', error);
    }
  };

  // ==========================
  // � REINICIAR SISTEMA COMPLETO
  // ==========================
  const handleResetSystem = async () => {
    setIsResettingSystem(true);
    
    // Reiniciar el progreso a 0 ANTES de abrir el modal
    setResetSystemProgress({
      phase: translate('resetProgressInitializing') || 'Preparando...',
      current: 0,
      total: 19
    });
    
    setShowResetProgressModal(true);
    
    const totalSteps = 19; // 19 pasos (incluyendo comunicaciones, tareas, evaluaciones y notificaciones)
    let currentStep = 0;

    const updateProgress = (phaseKey: string) => {
      currentStep++;
      console.log(`📊 [RESET PROGRESS] Paso ${currentStep}/${totalSteps} - ${phaseKey}`);
      setResetSystemProgress({
        phase: translate(phaseKey),
        current: currentStep,
        total: totalSteps
      });
    };

    try {
      console.log('🔴 [RESET SYSTEM] Iniciando reinicio completo del sistema...');
      
      // Pequeña pausa para que se vea el estado inicial 0/13
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Paso 1: Eliminar calificaciones de Firebase
      updateProgress('resetProgressGrades');
      try {
        await deleteAllSQLGrades();
        console.log('✅ Calificaciones de Firebase eliminadas');
      } catch (e) {
        console.warn('⚠️ Error al eliminar calificaciones de Firebase:', e);
      }
      
      // Paso 2: Eliminar asistencia de Firebase
      updateProgress('resetProgressAttendance');
      try {
        await clearAllAttendance();
        console.log('✅ Asistencia de Firebase eliminada');
      } catch (e) {
        console.warn('⚠️ Error al eliminar asistencia de Firebase:', e);
      }

      // Paso 3: Eliminar estudiantes de LocalStorage
      updateProgress('resetProgressStudents');
      LocalStorageManager.setStudentsForYear(selectedYear, []);
      console.log('✅ Estudiantes eliminados');

      // Paso 4: Eliminar profesores de LocalStorage
      updateProgress('resetProgressTeachers');
      LocalStorageManager.setTeachersForYear(selectedYear, []);
      console.log('✅ Profesores eliminados');

      // Paso 5: Eliminar asignaciones de profesores
      updateProgress('resetProgressTeacherAssignments');
      LocalStorageManager.setTeacherAssignmentsForYear(selectedYear, []);
      localStorage.removeItem('smart-student-teacher-assignments');
      console.log('✅ Asignaciones de profesores eliminadas');

      // Paso 6: Eliminar cursos
      updateProgress('resetProgressCourses');
      LocalStorageManager.setCoursesForYear(selectedYear, []);
      localStorage.removeItem('smart-student-courses');
      console.log('✅ Cursos eliminados');

      // Paso 7: Eliminar secciones
      updateProgress('resetProgressSections');
      LocalStorageManager.setSectionsForYear(selectedYear, []);
      localStorage.removeItem('smart-student-sections');
      console.log('✅ Secciones eliminadas');

      // Paso 8: Eliminar asignaturas
      updateProgress('resetProgressSubjects');
      LocalStorageManager.setSubjectsForYear(selectedYear, []);
      console.log('✅ Asignaturas eliminadas');

      // Paso 9: Eliminar asignaciones de estudiantes
      updateProgress('resetProgressStudentAssignments');
      LocalStorageManager.setStudentAssignmentsForYear(selectedYear, []);
      localStorage.removeItem('smart-student-student-assignments');
      console.log('✅ Asignaciones de estudiantes eliminadas');

      // Paso 9.1: Eliminar apoderados de LocalStorage
      updateProgress('resetProgressGuardians');
      LocalStorageManager.setGuardiansForYear(selectedYear, []);
      localStorage.removeItem('smart-student-guardians');
      console.log('✅ Apoderados eliminados');

      // Paso 9.2: Eliminar relaciones apoderado-estudiante
      updateProgress('resetProgressGuardianRelations');
      LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, []);
      localStorage.removeItem('smart-student-guardian-students');
      console.log('✅ Relaciones apoderado-estudiante eliminadas');

      // Paso 10: Eliminar calificaciones de LocalStorage
      updateProgress('resetProgressGradesLS');
      localStorage.removeItem('smart-student-test-grades');
      localStorage.removeItem('smart-student-test-grades-cache');
      console.log('✅ Calificaciones de LocalStorage eliminadas');

      // Paso 11: Eliminar asistencia de LocalStorage
      updateProgress('resetProgressAttendanceLS');
      localStorage.removeItem('smart-student-attendance');
      console.log('✅ Asistencia de LocalStorage eliminada');

      // Paso 12: Eliminar comunicaciones
      updateProgress('resetProgressCommunications');
      localStorage.removeItem('smart-student-communications');
      console.log('✅ Comunicaciones eliminadas');

      // Paso 13: Eliminar tareas
      updateProgress('resetProgressTasks');
      localStorage.removeItem('smart-student-tasks');
      console.log('✅ Tareas eliminadas');

      // Paso 14: Eliminar evaluaciones
      updateProgress('resetProgressEvaluations');
      localStorage.removeItem('smart-student-evaluations');
      console.log('✅ Evaluaciones eliminadas');

      // Paso 15: Eliminar notificaciones
      updateProgress('resetProgressNotifications');
      localStorage.removeItem('smart-student-notifications');
      // También eliminar preferencias de notificaciones por email de usuarios
      const allKeys = Object.keys(localStorage);
      allKeys.forEach(key => {
        if (key.startsWith('emailNotifications_')) {
          localStorage.removeItem(key);
        }
      });
      console.log('✅ Notificaciones eliminadas');

      // Paso 16: Limpiar usuarios (solo estudiantes y profesores del año)
      updateProgress('resetProgressUsers');
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const admins = allUsers.filter((u: any) => u.role === 'admin');
      safeSaveSmartStudentUsers(admins, 'resetSystem');
      console.log('✅ Usuarios limpiados (admins preservados)');

      // Paso 17: Finalizar (disparar eventos y actualizar contadores)
      updateProgress('resetProgressCounters');
      
      // Disparar eventos de actualización
      try {
        window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('coursesChanged', { detail: { source: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('sectionsChanged', { detail: { source: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('sqlGradesUpdated', { detail: { year: selectedYear, action: 'reset' } }));
        window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { year: selectedYear, action: 'reset' } }));
        window.dispatchEvent(new CustomEvent('communicationsUpdated', { detail: { action: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('tasksUpdated', { detail: { action: 'reset-system' } }));
        window.dispatchEvent(new CustomEvent('evaluationsUpdated', { detail: { action: 'reset-system' } }));
      } catch (e) {
        console.warn('⚠️ Error al disparar eventos:', e);
      }
      
      // Actualizar contadores
      try {
        await countGradesByYear(selectedYear);
        await countAllGrades();
        await countAttendanceByYear(selectedYear);
        await countAllAttendance();
        await getFirebaseCounters(selectedYear);
      } catch (e) {
        console.warn('⚠️ Error al actualizar contadores:', e);
      }

      // Marcar como completado (sin incrementar contador)
      setResetSystemProgress({
        phase: translate('resetProgressComplete'),
        current: totalSteps,
        total: totalSteps
      });
      
      toast({
        title: translate('resetSystemSuccessTitle'),
        description: translate('resetSystemSuccessDesc'),
        variant: 'default'
      });

      // Recargar estadísticas
      setSystemStats(getSystemStatistics());
      setRefreshUsers(prev => prev + 1);

      // Recargar la página después de 3 segundos
      setTimeout(() => {
        console.log('🔄 Recargando página después de reiniciar el sistema...');
        window.location.reload();
      }, 3000);

    } catch (error) {
      console.error('❌ Error al reiniciar el sistema:', error);
      toast({
        title: translate('resetSystemErrorTitle'),
        description: translate('resetSystemErrorDesc'),
        variant: 'destructive'
      });
      setIsResettingSystem(false);
      setShowResetProgressModal(false);
    }
  };

  // ==========================
  // �📥 CARGA MASIVA POR EXCEL
  // ==========================
  const downloadUsersExcelTemplate = async () => {
    try {
      const XLSX = await import('xlsx');
      const headers = ['role','name','rut','email','username','password','course','section','subjects','student_ruts','relationship','phone'];
      const example = [
        ['student','Juan Pérez','12345678-9','juan@example.com','juan.perez','1234','1ro Básico','A','','','',''],
  // Para profesores usa abreviaturas: MAT, LEN, HIST, CIEN, etc.
  ['teacher','Ana López','11111111-1','ana@example.com','ana.lopez','1234','','','MAT, LEN','','',''],
        ['admin','Admin Colegio','99999999-9','admin@example.com','admin','1234','','','','','',''],
        // Nota: Si dejas username vacío, se auto-generará desde email o nombre+RUT
        ['student','María Silva','22222222-2','maria@example.com','','1234','2do Básico','B','','','',''],
        // Apoderado: student_ruts = RUTs de estudiantes separados por coma, relationship = mother/father/tutor/other
        ['guardian','Carmen Madre','33333333-3','mama@example.com','carmen.madre','1234','','','','12345678-9, 22222222-2','mother','+56912345678']
      ];
      const aoa = [headers, ...example];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      XLSX.writeFile(wb, 'users-template.xlsx');
    } catch (e) {
      toast({
        title: translate('configExportErrorTitle') || 'Error en exportación',
        description: 'No se pudo generar la plantilla Excel',
        variant: 'destructive'
      });
    }
  };

  // Handler para procesar archivo Excel de usuarios (OPTIMIZADO - NO BLOQUEANTE)
  const handleBulkUsersExcelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    console.log('🎬 [CARGA EXCEL] Handler ejecutado');
    const file = event.target.files?.[0];
    console.log('📁 [CARGA EXCEL] Archivo seleccionado:', file?.name, file?.size, 'bytes');
    
    if (!file) {
      console.warn('⚠️ [CARGA EXCEL] No se seleccionó ningún archivo');
      return;
    }

    // Validar extensión del archivo
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      console.error('❌ [CARGA EXCEL] Extensión de archivo inválida:', file.name);
      toast({
        title: translate('configImportErrorTitle') || 'Error en importación',
        description: 'El archivo debe ser de tipo Excel (.xlsx, .xls) o CSV (.csv)',
        variant: 'destructive'
      });
      event.target.value = '';
      return;
    }

    console.log('🚀 [CARGA EXCEL] Iniciando proceso de carga...');
    setIsExcelProcessing(true);
    
    // ✅ Liberar el event loop para mostrar el estado de "Procesando..."
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      console.log('📦 [CARGA EXCEL] Importando biblioteca XLSX...');
      const XLSX = await import('xlsx');
      
      console.log('📖 [CARGA EXCEL] Leyendo archivo...');
      const data = await file.arrayBuffer();
      
      console.log('🔍 [CARGA EXCEL] Parseando workbook...');
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      
      console.log('📋 [CARGA EXCEL] Convirtiendo a JSON...');
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

      console.log('📊 [CARGA EXCEL] Datos leídos:', jsonData.length, 'filas');

      if (jsonData.length < 2) {
        throw new Error('El archivo está vacío o no tiene datos');
      }

      // Procesar headers (primera fila)
      const rawHeaders = jsonData[0] as string[];
      // ✅ Limpiar BOM UTF-8 y espacios del primer header
      const headers = rawHeaders.map((h, index) => {
        let header = String(h || '');
        // Remover BOM del primer header si existe
        if (index === 0 && header.charCodeAt(0) === 0xFEFF) {
          header = header.substring(1);
        }
        // Remover BOM alternativo
        header = header.replace(/^\uFEFF/, '');
        return header.toLowerCase().trim().replace(/\s+/g, '');
      });
      console.log('📊 [CARGA EXCEL] Headers detectados:', headers);
      console.log('📊 [CARGA EXCEL] Primer header (verificar BOM):', JSON.stringify(headers[0]));

      // Validar que tenga los campos mínimos requeridos
      const requiredFields = ['role', 'name'];
      const missingFields = requiredFields.filter(f => !headers.includes(f));
      if (missingFields.length > 0) {
        throw new Error(`Faltan campos requeridos en el Excel: ${missingFields.join(', ')}`);
      }

      // Normalización de asignaturas: aceptar abreviaturas (MAT, LEN, HIS, CNT) o nombres completos y mapear a nombre oficial
      const availableSubjectsAll = getAllAvailableSubjects();
      const normalizeKey = (s: string) => String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/([\u0300-\u036f])/g, '')
        .replace(/[\u00ba\u00b0]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const abbrToName = new Map<string, string>();
      const nameToName = new Map<string, string>();
      const normNameToName = new Map<string, string>();
      availableSubjectsAll.forEach(s => {
        if ((s as any).abbreviation) abbrToName.set(String((s as any).abbreviation).toLowerCase(), s.name);
        nameToName.set(s.name.toLowerCase(), s.name);
        normNameToName.set(normalizeKey(s.name), s.name);
      });
      const subjectSynonyms: Record<string, string> = {
        mat: 'mat', matematica: 'mat', matematicas: 'mat', 'matemáticas': 'mat',
        len: 'len', leng: 'len', lenguaje: 'len', lengua: 'len',
        his: 'his', hist: 'his', histo: 'his', historia: 'his',
        cnt: 'cnt', cn: 'cnt', ciencias: 'cnt', 'ciencias naturales': 'cnt',
        ing: 'ing', ingles: 'ing', 'inglés': 'ing',
        efi: 'efi', 'educacion fisica': 'efi', 'educación física': 'efi', 'ed fisica': 'efi',
        mus: 'mus', musica: 'mus', 'música': 'mus',
        art: 'art', artes: 'art', 'artes visuales': 'art',
        tec: 'tec', tecnologia: 'tec', 'tecnología': 'tec',
        rel: 'rel', religion: 'rel', 'religión': 'rel'
      };
      const parseSubjectName = (val: string): string => {
        const key = normalizeKey(val);
        const mapped = subjectSynonyms[key] || key;
        if (abbrToName.has(mapped)) return abbrToName.get(mapped)!;
        if (nameToName.has(mapped)) return nameToName.get(mapped)!;
        if (normNameToName.has(mapped)) return normNameToName.get(mapped)!;
        return '';
      };

      // Procesar filas y agrupar por usuario (para consolidar materias)
      const createdUsers = {
        admins: 0,
        teachers: 0,
        students: 0,
        guardians: 0,
        studentsUpdated: 0,
        errors: 0,
        errorMessages: [] as string[]
      };

      const existingUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      
      // Mapa temporal para consolidar usuarios con múltiples filas (para profesores con varias materias)
      const userMap = new Map<string, any>();

      // ✅ OPTIMIZACIÓN: Procesar en lotes para no bloquear la UI
      const BATCH_SIZE = 50; // Procesar 50 filas a la vez
      console.log(`⚙️ [CARGA EXCEL] Iniciando procesamiento por batches (${BATCH_SIZE} filas/batch)...`);
      
      for (let batchStart = 1; batchStart < jsonData.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, jsonData.length);
        const batchRows = jsonData.slice(batchStart, batchEnd);
        
        console.log(`🔄 [CARGA EXCEL] Procesando batch ${Math.ceil(batchStart/BATCH_SIZE)}: filas ${batchStart} a ${batchEnd-1}`);
        
        // Procesar el batch
        for (let batchIndex = 0; batchIndex < batchRows.length; batchIndex++) {
          const i = batchStart + batchIndex;
          const row = batchRows[batchIndex];
        if (!row || row.length === 0) continue;

        try {
          const cleanCell = (v: any): string => (v != null ? String(v).replace(/\r/g, '').replace(/\n/g, '').trim() : '');
          let rowValues: string[] = Array.isArray(row) ? row.map(cleanCell) : [];

          // ✅ Reparación para CSV: si un campo contiene comas sin comillas, XLSX lo separa en columnas extra.
          // Esto afecta especialmente a apoderados cuando `student_ruts` trae más de un RUT separado por coma.
          const roleIdx = headers.indexOf('role');
          const studentRutsIdx = headers.indexOf('student_ruts');
          const relationshipIdx = headers.indexOf('relationship');
          const phoneIdx = headers.indexOf('phone');
          const roleRaw = roleIdx >= 0 ? String(rowValues[roleIdx] || '').toLowerCase() : '';
          const isGuardianRow = roleRaw === 'guardian' || roleRaw === 'apoderado';

          if (
            isGuardianRow &&
            studentRutsIdx >= 0 &&
            relationshipIdx >= 0 &&
            phoneIdx >= 0 &&
            studentRutsIdx < relationshipIdx &&
            relationshipIdx < phoneIdx &&
            rowValues.length > headers.length
          ) {
            const relationshipRaw = rowValues[rowValues.length - 2] || '';
            const phoneRaw = rowValues[rowValues.length - 1] || '';
            const joinedStudentRuts = rowValues.slice(studentRutsIdx, rowValues.length - 2).join(',');

            rowValues = [
              ...rowValues.slice(0, studentRutsIdx),
              joinedStudentRuts,
              relationshipRaw,
              phoneRaw,
            ];
          }

          // Normalizar largo vs headers
          if (rowValues.length < headers.length) {
            rowValues = [...rowValues, ...Array(headers.length - rowValues.length).fill('')];
          }

          const userData: any = {};
          headers.forEach((header, index) => {
            userData[header] = rowValues[index] ?? '';
          });

          // Validar campos mínimos
          if (!userData.role || !userData.name) {
            createdUsers.errors++;
            const errorMsg = `Fila ${i + 1}: Faltan campos requeridos (role=${userData.role}, name=${userData.name})`;
            createdUsers.errorMessages.push(errorMsg);
            console.warn(`⚠️ [CARGA EXCEL] ${errorMsg}`);
            continue;
          }

          console.log(`✅ [CARGA EXCEL] Fila ${i + 1}: role=${userData.role}, name=${userData.name}, username=${userData.username}`);

          // Generar username si está vacío
          let username = String(userData.username || '').trim();
          if (!username) {
            // Intentar desde email
            if (userData.email && String(userData.email).includes('@')) {
              username = String(userData.email).split('@')[0];
            } else if (userData.rut) {
              // Generar desde nombre + últimos 4 dígitos del RUT
              const cleanName = String(userData.name)
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]/g, '');
              const rutDigits = String(userData.rut).replace(/[^0-9]/g, '').slice(-4);
              username = `${cleanName}_${rutDigits}`;
            } else {
              // Último recurso: nombre sin espacios
              username = String(userData.name)
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]/g, '');
            }
            console.log(`📝 [CARGA EXCEL] Username auto-generado para ${userData.name}: ${username}`);
          }

          // Obtener materias de esta fila y normalizar a nombres oficiales
          const rawSubjectsArr = String(userData.subjects || '')
            .replace(/\r/g, '')
            .replace(/\n/g, '')
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
          const subjectsInRow = rawSubjectsArr
            .map(parseSubjectName)
            .filter(Boolean); // ✅ nombres oficiales (coinciden con catálogo de asignaturas)

          // Verificar si ya procesamos este usuario (para consolidar materias)
          const userKey = `${username}_${userData.course}_${userData.section}`;
          
          if (userMap.has(userKey)) {
            // Usuario ya existe en el mapa, agregar las materias nuevas
            const existingData = userMap.get(userKey);
            existingData.subjects = [...new Set([...existingData.subjects, ...subjectsInRow])];
            console.log(`📚 [CARGA EXCEL] Consolidando materias para ${username}: ${existingData.subjects.join(', ')}`);
          } else {
            // Primera vez que vemos este usuario/curso/sección
            // Procesar campos específicos de apoderado
            const studentRuts = String(userData.student_ruts || userData.studentruts || '')
              .split(/[,;]/)
              .map(r => r.trim())
              .filter(r => r.length > 0);
            const relationship = String(userData.relationship || 'tutor').toLowerCase();
            const phone = String(userData.phone || '');

            userMap.set(userKey, {
              username,
              password: String(userData.password || '1234'),
              name: String(userData.name),
              displayName: String(userData.name),
              email: String(userData.email || ''),
              role: String(userData.role).toLowerCase(),
              rut: String(userData.rut || ''),
              course: String(userData.course || ''),
              section: String(userData.section || ''),
              subjects: subjectsInRow,
              // Campos de apoderado
              studentRuts,
              relationship: ['mother', 'father', 'tutor', 'other'].includes(relationship) ? relationship : 'tutor',
              phone
            });
          }

        } catch (error: any) {
          createdUsers.errors++;
          createdUsers.errorMessages.push(`Fila ${i + 1}: ${error.message}`);
          console.error(`Error procesando fila ${i + 1}:`, error);
        }
      }
        
        // ✅ Liberar el event loop después de cada batch
        if (batchEnd < jsonData.length) {
          console.log(`⏸️ [CARGA EXCEL] Liberando event loop después del batch ${Math.ceil(batchStart/BATCH_SIZE)}...`);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      // Ahora procesar el mapa consolidado y crear/actualizar usuarios
      console.log(`📊 [CARGA EXCEL] Procesamiento de filas completado`);
      console.log(`👥 [CARGA EXCEL] Usuarios consolidados: ${userMap.size}`);
      
      for (const [userKey, userData] of userMap.entries()) {
        try {
          // Verificar si el usuario ya existe
          const existingUser = existingUsers.find((u: any) => u.username === userData.username);

          const newUser = {
            id: existingUser?.id || `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            ...userData,
            createdAt: existingUser?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          // Agregar o actualizar usuario
          if (existingUser) {
            const index = existingUsers.findIndex((u: any) => u.username === userData.username);
            existingUsers[index] = { ...existingUser, ...newUser };
            if (newUser.role === 'student') {
              createdUsers.studentsUpdated++;
            }
            console.log(`🔄 [CARGA EXCEL] Usuario actualizado: ${userData.username}`);
          } else {
            existingUsers.push(newUser);
            if (newUser.role === 'admin') createdUsers.admins++;
            else if (newUser.role === 'teacher') createdUsers.teachers++;
            else if (newUser.role === 'student') createdUsers.students++;
            else if (newUser.role === 'guardian' || newUser.role === 'apoderado') createdUsers.guardians++;
            console.log(`✨ [CARGA EXCEL] Usuario creado: ${userData.username} (${newUser.role})`);
          }
        } catch (error: any) {
          createdUsers.errors++;
          createdUsers.errorMessages.push(`Error procesando usuario ${userData.username}: ${error.message}`);
        }
      }

      // Guardar usuarios actualizados
      console.log('💾 [CARGA EXCEL] Guardando usuarios en localStorage...');
      console.log(`💾 [CARGA EXCEL] Total usuarios a guardar: ${existingUsers.length}`);
      try {
        const jsonString = JSON.stringify(existingUsers);
        console.log(`💾 [CARGA EXCEL] Tamaño del JSON: ${jsonString.length} caracteres`);
        localStorage.setItem('smart-student-users', jsonString);
        
        // ✅ Verificar que se guardó correctamente
        const verification = localStorage.getItem('smart-student-users');
        if (verification) {
          const parsed = JSON.parse(verification);
          console.log('✅ [CARGA EXCEL] Usuarios guardados exitosamente. Total en storage:', parsed.length);
          
          // 📧 Activar notificaciones por email por defecto para todos los usuarios nuevos
          console.log('📧 [CARGA EXCEL] Activando notificaciones por email por defecto...');
          let emailNotificationsEnabled = 0;
          for (const user of parsed) {
            const prefKey = `emailNotifications_${user.id}`;
            // Solo activar si no existe preferencia previa (usuarios nuevos)
            if (localStorage.getItem(prefKey) === null) {
              localStorage.setItem(prefKey, 'true');
              emailNotificationsEnabled++;
            }
          }
          console.log(`📧 [CARGA EXCEL] Notificaciones por email activadas para ${emailNotificationsEnabled} usuarios nuevos`);
        } else {
          throw new Error('No se pudo verificar el guardado en localStorage');
        }
      } catch (saveError: any) {
        console.error('❌ [CARGA EXCEL] Error guardando usuarios:', saveError);
        throw new Error(`No se pudieron guardar los usuarios: ${saveError.message}`);
      }

      // 🔄 Sincronizar colecciones por año (estudiantes/profesores/asignaciones)
      console.log('🔄 [CARGA EXCEL] Sincronizando colecciones por año...');
      try {
        const year = selectedYear;
        // Mapas curso/sección por nombre → id del año activo
        const normalize = (s: string) => String(s || '')
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[º°]/g, '')
          .replace(/(\d+)\s*(ro|do|to)/g, '$1')
          .replace(/\s+/g, ' ').trim();
        const courses = LocalStorageManager.getCoursesForYear(year) || [];
        const sections = LocalStorageManager.getSectionsForYear(year) || [];
        const courseByName = new Map<string, any>(courses.map((c: any) => [normalize(c.name), c] as const));
        const sectionsByCourse = new Map<string, any[]>(courses.map((c: any) => [String(c.id), sections.filter((s: any) => String(s.courseId) === String(c.id))]));

        // Mapeo de abreviaturas/sinónimos a nombres de asignatura canónicos
        const availableSubjectsAll = getAllAvailableSubjects();
        const abbrToName = new Map<string, string>();
        const nameToName = new Map<string, string>();
        const normNameToName = new Map<string, string>();
        availableSubjectsAll.forEach(s => {
          if (s.abbreviation) abbrToName.set(String(s.abbreviation).toLowerCase(), s.name);
          nameToName.set(s.name.toLowerCase(), s.name);
          normNameToName.set(normalize(s.name), s.name);
        });
        const subjectSynonyms: Record<string, string> = {
          mat: 'mat', matematica: 'mat', matematicas: 'mat', 'matemáticas': 'mat',
          len: 'len', leng: 'len', lenguaje: 'len', lengua: 'len',
          his: 'his', hist: 'his', histo: 'his', historia: 'his',
          cnt: 'cnt', cn: 'cnt', ciencias: 'cnt', 'ciencias naturales': 'cnt',
          ing: 'ing', ingles: 'ing', 'inglés': 'ing',
          efi: 'efi', 'educacion fisica': 'efi', 'educación física': 'efi', 'ed fisica': 'efi',
          mus: 'mus', musica: 'mus', 'música': 'mus',
          art: 'art', artes: 'art', 'artes visuales': 'art',
          tec: 'tec', tecnologia: 'tec', 'tecnología': 'tec',
          rel: 'rel', religion: 'rel', 'religión': 'rel'
        };
        const mapRawSubjectsToNames = (arr: any): string[] => {
          if (!Array.isArray(arr)) return [];
          const result: string[] = [];
          for (const raw of arr) {
            const key = normalize(String(raw || ''));
            if (!key) continue;
            const mappedKey = (subjectSynonyms as any)[key] || key;
            const name = abbrToName.get(mappedKey) || nameToName.get(mappedKey) || normNameToName.get(mappedKey) || '';
            if (name && !result.includes(name)) result.push(name);
          }
          return result;
        };

        // Construir colecciones por año a partir de los usuarios globales importados
        const studentsYear: any[] = [];
        const teachersYear: any[] = [];
        const guardiansYear: any[] = [];
        const studentAssignmentsToAdd: any[] = [];
        const guardianStudentRelationsToAdd: any[] = [];

        // Mapa de RUT → studentId para resolver relaciones apoderado-estudiante
        const rutToStudentId = new Map<string, string>();

        // 🔎 Agregador por profesor (username) para recolectar secciones y materias desde el Excel
        // userMap conserva las filas por (username, course, section) — aquí consolidamos por username
        const teacherAggByUsername = new Map<string, { 
          id?: string;
          username: string;
          name?: string;
          email?: string;
          assignedSectionIds: Set<string>;
          selectedSubjects: Set<string>;
        }>();

        // Recolectar secciones y materias explícitas de cada fila del Excel para profesores
        for (const [userKey, uData] of userMap.entries()) {
          const role = String(uData.role || '').toLowerCase();
          if (role !== 'teacher' && role !== 'profesor') continue;
          const username = String(uData.username);
          if (!username) continue;
          let agg = teacherAggByUsername.get(username);
          if (!agg) {
            agg = { username, id: undefined, name: uData.displayName || uData.name, email: uData.email || '', assignedSectionIds: new Set(), selectedSubjects: new Set() };
            teacherAggByUsername.set(username, agg);
          }
          // Mapear course+section a sectionId del año
          const courseName = normalize(String(uData.course || ''));
          const sectionLetter = String(uData.section || '').trim();
          const course = courseName ? courseByName.get(courseName) : null;
          const secs = course ? (sectionsByCourse.get(String(course.id)) || []) : [];
          const section = sectionLetter ? secs.find((s: any) => normalize(s.name) === normalize(sectionLetter)) : null;
          if (section?.id) agg.assignedSectionIds.add(String(section.id));
          // Materias normalizadas desde esta fila
          const subjectsFromRow = mapRawSubjectsToNames(uData.subjects || []);
          subjectsFromRow.forEach(s => agg!.selectedSubjects.add(s));
        }

        for (const u of existingUsers) {
          const role = String(u.role || '').toLowerCase();
          if (role === 'student' || role === 'estudiante') {
            // Resolver curso/sección por nombre si están presentes en el Excel
            const courseName = normalize(u.course || u.courseName || (Array.isArray(u.activeCourses) ? u.activeCourses[0] : ''));
            const sectionLetter = String(u.section || u.sectionName || '').trim();
            const course = courseName ? courseByName.get(courseName) : null;
            const secs = course ? (sectionsByCourse.get(String(course.id)) || []) : [];
            const section = sectionLetter ? secs.find((s: any) => normalize(s.name) === normalize(sectionLetter)) : null;

            const studentRec = {
              id: u.id,
              username: u.username,
              rut: u.rut,
              name: u.displayName || u.name,
              displayName: u.displayName || u.name,
              email: u.email || '',
              role: 'student',
              courseId: course?.id || u.courseId || '',
              sectionId: section?.id || u.sectionId || '',
            };
            studentsYear.push(studentRec);

            // Agregar al mapa de RUT para resolver relaciones apoderado-estudiante
            if (studentRec.rut) {
              const normalizedRut = String(studentRec.rut).replace(/[^0-9kK-]/g, '').toLowerCase();
              rutToStudentId.set(normalizedRut, studentRec.id);
            }

            // Crear asignación estudiante→sección si tenemos ids
            if (studentRec.id && studentRec.sectionId) {
              studentAssignmentsToAdd.push({
                id: `sa-${studentRec.id}-${studentRec.sectionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                studentId: String(studentRec.id),
                courseId: String(studentRec.courseId || ''),
                sectionId: String(studentRec.sectionId),
                isActive: true,
                assignedAt: new Date().toISOString(),
                source: 'bulk-users-import'
              });
            }
          } else if (role === 'teacher' || role === 'profesor') {
            // Normalizar materias del profesor a nombres canónicos (p.ej., MAT → Matemáticas)
            const rawSubjects = Array.isArray((u as any).selectedSubjects)
              ? (u as any).selectedSubjects
              : (Array.isArray((u as any).subjects) ? (u as any).subjects : []);
            const normalizedSubjects = mapRawSubjectsToNames(rawSubjects);

            // Enriquecer con lo recolectado del Excel por username (todas sus filas)
            const agg = teacherAggByUsername.get(String(u.username));
            const assignedSectionIds = Array.from(agg?.assignedSectionIds || []);
            const mergedSubjects = new Set<string>([...normalizedSubjects, ...Array.from(agg?.selectedSubjects || [])]);

            const teacherRec = {
              id: u.id,
              username: u.username,
              name: u.displayName || u.name,
              displayName: u.displayName || u.name,
              email: u.email || '',
              role: 'teacher',
              // Si el Excel especificó secciones, usarlas; si no, respetar assignedSections previas si existen
              assignedSections: assignedSectionIds.length > 0 ? assignedSectionIds : (u.assignedSections || []),
              // Materias normalizadas unificadas
              selectedSubjects: Array.from(mergedSubjects)
            };
            // Guardar id/username en el agregador para usarlos en el auto-creator de assignments
            if (agg) { agg.id = teacherRec.id; }
            teachersYear.push(teacherRec);
          } else if (role === 'guardian' || role === 'apoderado') {
            // Procesar apoderado
            let studentRuts: string[] = [];
            if (Array.isArray(u.studentRuts)) {
              studentRuts = u.studentRuts;
            } else if (typeof (u as any).studentRuts === 'string' && String((u as any).studentRuts).trim()) {
              studentRuts = String((u as any).studentRuts)
                .split(/[,;]/)
                .map((r: string) => r.trim())
                .filter((r: string) => r.length > 0);
            }
            const studentIds: string[] = [];
            
            // Resolver RUTs de estudiantes a IDs
            for (const rut of studentRuts) {
              const normalizedRut = String(rut).replace(/[^0-9kK-]/g, '').toLowerCase();
              const studentId = rutToStudentId.get(normalizedRut);
              if (studentId) {
                studentIds.push(studentId);
              } else {
                // Buscar en estudiantes existentes del año
                const existingStudent = studentsYear.find((s: any) => {
                  const sRut = String(s.rut || '').replace(/[^0-9kK-]/g, '').toLowerCase();
                  return sRut === normalizedRut;
                });
                if (existingStudent) {
                  studentIds.push(existingStudent.id);
                }
              }
            }

            const guardianRec = {
              id: u.id,
              uniqueCode: `GRD-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`.toUpperCase().substring(0, 12),
              username: u.username,
              name: u.displayName || u.name,
              displayName: u.displayName || u.name,
              email: u.email || '',
              phone: u.phone || '',
              rut: u.rut || '',
              role: 'guardian',
              isActive: true,
              studentIds,
              relationship: u.relationship || 'tutor',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            guardiansYear.push(guardianRec);

            // Crear relaciones apoderado-estudiante
            studentIds.forEach((studentId, index) => {
              guardianStudentRelationsToAdd.push({
                id: `gsr-${guardianRec.id}-${studentId}-${Date.now()}`,
                guardianId: guardianRec.id,
                studentId,
                relationship: guardianRec.relationship,
                isPrimary: index === 0,
                createdAt: new Date().toISOString()
              });
            });
          }
        }

        // Guardar en claves segmentadas por año
        LocalStorageManager.setStudentsForYear(year, studentsYear);
        LocalStorageManager.setTeachersForYear(year, teachersYear);
        LocalStorageManager.setGuardiansForYear(year, guardiansYear);

        // Mezclar asignaciones nuevas con existentes evitando duplicados
        if (studentAssignmentsToAdd.length > 0) {
          const existingSA: any[] = LocalStorageManager.getStudentAssignmentsForYear(year) || [];
          const keySet = new Set(existingSA.map((a: any) => `${a.studentId}:${a.sectionId}`));
          const toAdd = studentAssignmentsToAdd.filter((a: any) => !keySet.has(`${a.studentId}:${a.sectionId}`));
          if (toAdd.length > 0) {
            LocalStorageManager.setStudentAssignmentsForYear(year, [...existingSA, ...toAdd]);
            try { window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { year, added: toAdd.length } })); } catch {}
          }
        }

        // Guardar relaciones apoderado-estudiante
        if (guardianStudentRelationsToAdd.length > 0) {
          const existingGSR: any[] = LocalStorageManager.getGuardianStudentRelationsForYear(year) || [];
          const keySet = new Set(existingGSR.map((r: any) => `${r.guardianId}:${r.studentId}`));
          const toAdd = guardianStudentRelationsToAdd.filter((r: any) => !keySet.has(`${r.guardianId}:${r.studentId}`));
          if (toAdd.length > 0) {
            LocalStorageManager.setGuardianStudentRelationsForYear(year, [...existingGSR, ...toAdd]);
            try { window.dispatchEvent(new CustomEvent('guardiansUpdated', { detail: { year, added: toAdd.length } })); } catch {}
          }
        }

        // Recalcular contadores de secciones y propagar eventos
        try { EducationAutomation.recalculateSectionCounts(translate, year); } catch {}
        try { window.dispatchEvent(new CustomEvent('usersChanged', { detail: { year, source: 'bulk-users-excel' } })); } catch {}
        try { window.dispatchEvent(new CustomEvent('sectionsChanged', { detail: { year } })); } catch {}

        // ✅ Auto-crear asignaciones de profesores tras importar usuarios (fallback)
        try {
          const coursesNow: any[] = LocalStorageManager.getCoursesForYear(year) || [];
          const sectionsNow: any[] = LocalStorageManager.getSectionsForYear(year) || [];
          const teachersNow: any[] = LocalStorageManager.getTeachersForYear(year) || teachersYear || [];
          let teacherAssignments: any[] = LocalStorageManager.getTeacherAssignmentsForYear(year) || [];

          const hasAssignment = (a: any[], teacherId: string, sectionId: string, subjectName?: string) =>
            a.some(x => String(x.teacherId) === String(teacherId) && String(x.sectionId) === String(sectionId) && String(x.subjectName || '') === String(subjectName || ''));

          let createdAssignments = 0;
          for (const t of teachersNow) {
            const subjects: string[] = Array.isArray(t?.selectedSubjects) ? t.selectedSubjects : [];
            if (!subjects || subjects.length === 0) continue; // sin materias no hay qué asignar

            // Si el profesor tiene secciones asignadas, usarlas; si no, NO crear asignaciones masivas
            const targetSections = Array.isArray(t.assignedSections) && t.assignedSections.length > 0
              ? sectionsNow.filter((s: any) => (t.assignedSections as any[]).includes(s.id))
              : [];

            for (const sec of targetSections) {
              const course = coursesNow.find((c: any) => String(c.id) === String(sec.courseId));
              if (!course) continue;
              for (const subjectName of subjects) {
                if (!hasAssignment(teacherAssignments, t.id, sec.id, subjectName)) {
                  teacherAssignments.push({
                    id: `ta-${t.id}-${sec.id}-${subjectName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    teacherId: t.id,
                    teacherUsername: t.username,
                    courseId: course.id,
                    sectionId: sec.id,
                    subjectName,
                    isActive: true,
                    createdAt: new Date().toISOString(),
                    source: 'bulk-users-fallback'
                  });
                  createdAssignments++;
                }
              }
              // Mantener assignedSections sincronizado
              if (!Array.isArray(t.assignedSections)) t.assignedSections = [];
              if (!t.assignedSections.includes(sec.id)) t.assignedSections.push(sec.id);
            }
          }

          if (createdAssignments > 0) {
            LocalStorageManager.setTeachersForYear(year, teachersNow);
            LocalStorageManager.setTeacherAssignmentsForYear(year, teacherAssignments);
            try { window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'bulk-users-auto', created: createdAssignments, year } })); } catch {}
          }
        } catch (autoErr) {
          console.warn('⚠️ [CARGA EXCEL] No se pudo auto-crear asignaciones tras la carga de usuarios:', autoErr);
        }
      } catch (syncErr) {
        console.warn('⚠️ [CARGA EXCEL] No se pudo sincronizar colecciones por año:', syncErr);
      }

      console.log('📋 [CARGA EXCEL] Preparando resumen de importación...');
      console.log('📊 [CARGA EXCEL] Resumen de importación:', {
        admins: createdUsers.admins,
        teachers: createdUsers.teachers,
        students: createdUsers.students,
        guardians: createdUsers.guardians,
        studentsUpdated: createdUsers.studentsUpdated,
        errors: createdUsers.errors,
        totalProcesado: userMap.size,
        totalEnStorage: existingUsers.length
      });
      
      // Actualizar resumen
      setExcelImportSummary({
        ...createdUsers,
        timestamp: new Date().toISOString()
      });
      
      console.log('✅ [CARGA EXCEL] Mostrando modal de resumen...');
      setShowExcelSummaryDialog(true);

      console.log('🎉 [CARGA EXCEL] Proceso completado exitosamente!');
      
      // Calcular total de usuarios creados
      const totalCreated = createdUsers.admins + createdUsers.teachers + createdUsers.students + createdUsers.guardians;
      
      console.log('=' .repeat(60));
      console.log('📊 RESUMEN FINAL DE IMPORTACIÓN:');
      console.log('=' .repeat(60));
      console.log(`👥 USUARIOS CREADOS:`);
      console.log(`   - Administradores: ${createdUsers.admins}`);
      console.log(`   - Profesores: ${createdUsers.teachers}`);
      console.log(`   - Estudiantes: ${createdUsers.students}`);
      console.log(`   - Apoderados: ${createdUsers.guardians}`);
      console.log(`   - TOTAL CREADOS: ${totalCreated}`);
      console.log(`🔄 Estudiantes actualizados: ${createdUsers.studentsUpdated}`);
      console.log(`❌ Errores: ${createdUsers.errors}`);
      console.log(`💾 Total en sistema: ${existingUsers.length} usuarios`);
      console.log('=' .repeat(60));
      
      // Mostrar notificación
      toast({
        title: translate('configImportSuccessTitle') || 'Import Successful',
        description: `${translate('configImportCreated') || 'Created'}: ${totalCreated} ${translate('configImportUsers') || 'users'}. ${translate('configImportUpdated') || 'Updated'}: ${createdUsers.studentsUpdated}. ${translate('configImportErrors') || 'Errors'}: ${createdUsers.errors}`,
        variant: createdUsers.errors > 0 ? 'default' : 'default'
      });

      // ✅ Disparar evento para actualizar otras vistas (sin bloquear si Firebase falla)
      try {
        console.log('📢 [CARGA EXCEL] Disparando evento usersUpdated...');
        // Usar setTimeout para que los listeners no bloqueen este proceso
        setTimeout(() => {
          try {
            window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'bulk-import' } }));
            console.log('✅ [CARGA EXCEL] Evento disparado correctamente');
          } catch (e) {
            console.warn('⚠️ [CARGA EXCEL] Error en listeners externos (ignorado):', e);
          }
        }, 100);
        setRefreshUsers(prev => prev + 1);
      } catch (eventError: any) {
        console.warn('⚠️ [CARGA EXCEL] Error preparando eventos (ignorado):', eventError);
      }

    } catch (error: any) {
      console.error('❌ [CARGA EXCEL] Error fatal:', error);
      console.error('❌ [CARGA EXCEL] Stack:', error.stack);
      
      // Si el error es de Firebase pero los usuarios se guardaron, mostrar éxito parcial
      try {
        const usersInStorage = localStorage.getItem('smart-student-users');
        if (usersInStorage && (error.message?.includes('Firebase') || error.message?.includes('permissions'))) {
          console.log('✅ [CARGA EXCEL] Usuarios guardados en localStorage a pesar del error de Firebase');
          
          // Contar usuarios guardados
          const savedUsers = JSON.parse(usersInStorage);
          const count = Array.isArray(savedUsers) ? savedUsers.length : 0;
          
          toast({
            title: 'Importación completada',
            description: `${count} usuarios total en sistema (Firebase no disponible, usando localStorage).`,
            variant: 'default'
          });
          
          setExcelImportSummary({
            admins: 0,
            teachers: 0,
            students: count,
            guardians: 0,
            studentsUpdated: 0,
            errors: 0,
            errorMessages: [],
            timestamp: new Date().toISOString()
          });
          setShowExcelSummaryDialog(true);
          return; // Salir sin mostrar error
        }
      } catch (checkError) {
        console.warn('⚠️ [CARGA EXCEL] Error verificando localStorage:', checkError);
      }
      
      // Error real que no es de Firebase
      toast({
        title: translate('configImportErrorTitle') || 'Error en importación',
        description: error.message || 'No se pudo procesar el archivo Excel',
        variant: 'destructive'
      });
    } finally {
      console.log('🏁 [CARGA EXCEL] Finalizando proceso...');
      setIsExcelProcessing(false);
      event.target.value = '';
      console.log('✅ [CARGA EXCEL] Proceso finalizado, estado limpiado');
    }
  };

  // ==========================
  // 👩‍🏫 CARGA MASIVA ASIGNACIONES PROFESORES (EXCEL)
  // ==========================
  const downloadTeacherAssignmentsTemplate = async () => {
    try {
      const XLSX = await import('xlsx');
      const headers = ['teacherUsername','teacherEmail','course','section','subjects'];
      const example = [
        // Asignar profesor a una sección específica con materias
        ['ana', 'ana@example.com', '4to Básico', 'A', 'MAT, LEN'],
        // Asignar profesor a todas las secciones del curso (dejar section en blanco)
        ['carlos', 'carlos@example.com', '5to Básico', '', 'HIST']
      ];
      const aoa = [headers, ...example];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Assignments');
      XLSX.writeFile(wb, 'teacher-assignments-template.xlsx');
    } catch (e) {
      toast({
        title: translate('configExportErrorTitle') || 'Error',
        description: 'No se pudo generar la plantilla de asignaciones para profesores',
        variant: 'destructive'
      });
    }
  };

  // ==========================
  // 📝 CARGA MASIVA TAREAS/EVALUACIONES (EXCEL)
  // ==========================
  const downloadTasksEvaluationsTemplate = async () => {
    try {
      const XLSX = await import('xlsx');
      const headers = ['type','title','description','date','dueDate','course','section','subject','createdBy','maxScore','weight'];
      const example = [
        // Tarea para una sección específica
        ['tarea','Lectura capítulo 3','Responder preguntas','', '2025-09-05','4to Básico','A','LEN','ana','', '10'],
        // Evaluación para todas las secciones del curso (dejar section vacío)
        ['evaluacion','Prueba Matemáticas 1','','2025-09-10','', '4to Básico','', 'MAT','carlos','100','20']
      ];
      const aoa = [headers, ...example];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'TasksEvaluations');
      XLSX.writeFile(wb, 'tasks-evaluations-template.xlsx');
    } catch (e) {
      toast({ title: 'Error', description: 'No se pudo generar la plantilla de tareas/evaluaciones', variant: 'destructive' });
    }
  };

  const handleBulkTasksEvaluationsUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });

        const normalize = (s: string) => String(s || '')
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[\u00ba\u00b0]/g, '')
          .replace(/(\d+)\s*(ro|do|to)/g, '$1')
          .replace(/\s+/g, ' ').trim();
  const getByAliases = (obj: any, aliases: string[]) => {
        const key = Object.keys(obj).find(k => aliases.includes(k.trim().toLowerCase()));
        return key ? String(obj[key]).trim() : '';
      };

  const courses: any[] = LocalStorageManager.getCoursesForYear(selectedYear);
  const sections: any[] = LocalStorageManager.getSectionsForYear(selectedYear);
  const teachers: any[] = LocalStorageManager.getTeachersForYear(selectedYear);
      const allUsers: any[] = JSON.parse(localStorage.getItem('smart-student-users') || '[]');

      const tasks: any[] = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
      const evaluations: any[] = JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]');

      const availableSubjectsAll = getAllAvailableSubjects();
      const abbrToName = new Map<string, string>();
      const nameToName = new Map<string, string>();
      const normNameToName = new Map<string, string>();
      availableSubjectsAll.forEach(s => {
        if (s.abbreviation) abbrToName.set(String(s.abbreviation).toLowerCase(), s.name);
        nameToName.set(s.name.toLowerCase(), s.name);
        normNameToName.set(normalize(s.name), s.name);
      });
      const subjectSynonyms: Record<string, string> = {
        'mat': 'mat','matematica': 'mat','matematicas': 'mat','matemáticas': 'mat',
        'len': 'len','leng': 'len','lenguaje': 'len','lengua': 'len',
        'his': 'his','hist': 'his','histo': 'his','historia': 'his',
        'cnt': 'cnt','cn': 'cnt','ciencias': 'cnt','ciencias naturales': 'cnt',
        'ing': 'ing','ingles': 'ing','inglés': 'ing',
        'efi': 'efi','educacion fisica': 'efi','educación física': 'efi','ed fisica': 'efi',
        'mus': 'mus','musica': 'mus','música': 'mus',
        'art': 'art','artes': 'art','artes visuales': 'art',
        'tec': 'tec','tecnologia': 'tec','tecnología': 'tec',
        'rel': 'rel','religion': 'rel','religión': 'rel'
      };
      const parseSubjectName = (val: string): string => {
        const key = normalize(val);
        const mapped = subjectSynonyms[key] || key;
        if (abbrToName.has(mapped)) return abbrToName.get(mapped)!;
        if (nameToName.has(mapped)) return nameToName.get(mapped)!;
        if (normNameToName.has(mapped)) return normNameToName.get(mapped)!;
        return '';
      };

      const userByUsername = new Map(allUsers.map((u: any) => [String(u.username || '').toLowerCase(), u]));
      const teacherByUsername = new Map(teachers.map((t: any) => [String(t.username || '').toLowerCase(), t]));
      const userByEmail = new Map(allUsers.map((u: any) => [String(u.email || '').toLowerCase(), u]));

      const typeMap: Record<string,string> = {
        'task':'task','tarea':'task','tareas':'task','homework':'task',
        'evaluation':'evaluation','evaluacion':'evaluation','evaluación':'evaluation','prueba':'evaluation','pruebas':'evaluation',
      };

      let createdTasks = 0;
      let createdEvaluations = 0;
      const errors: string[] = [];

      let rowIndex = 1;
      for (const row of rows) {
        rowIndex++;
        const typeRaw = getByAliases(row, ['type','tipo']);
        const type = typeMap[normalize(typeRaw)] || '';
        const title = getByAliases(row, ['title','titulo','título']);
        const description = getByAliases(row, ['description','descripcion','descripción']);
        const dateStr = getByAliases(row, ['date','fecha']) || '';
        const dueStr = getByAliases(row, ['due','duedate','fechaentrega']);
        const courseName = getByAliases(row, ['course','curso']);
        const sectionName = getByAliases(row, ['section','seccion','sección']);
        const subjectRaw = getByAliases(row, ['subject','asignatura']);
        const createdByRaw = getByAliases(row, ['createdby','creadopor','profesor','teacher']);
        const maxScoreRaw = getByAliases(row, ['maxscore','puntajemaximo']);
        const weightRaw = getByAliases(row, ['weight','ponderacion','ponderación']);

        if (!type || !title || !courseName) {
          errors.push(`Fila ${rowIndex}: faltan type/title/course`);
          continue;
        }

        const course = courses.find((c: any) => normalize(c.name) === normalize(courseName));
        if (!course) {
          errors.push(`Fila ${rowIndex}: curso no encontrado "${courseName}"`);
          continue;
        }
        const sectionsForCourse = sections.filter((s: any) => s.courseId === course.id);
        const targetSections = sectionName
          ? sectionsForCourse.filter((s: any) => normalize(s.name) === normalize(sectionName))
          : sectionsForCourse;
        if (targetSections.length === 0) {
          errors.push(`Fila ${rowIndex}: no hay secciones en curso ${course.name}`);
          continue;
        }

        const subjectName = subjectRaw ? parseSubjectName(subjectRaw) : '';
        let teacherUsername = '';
        if (createdByRaw) {
          const u = userByUsername.get(normalize(createdByRaw)) || userByEmail.get(normalize(createdByRaw));
          teacherUsername = u?.username || createdByRaw;
        }

        const makeDateISO = (s: string) => {
          const v = String(s || '').trim();
          if (!v) return undefined;
          const d = new Date(v);
          if (!isNaN(d.getTime())) return d.toISOString();
          // intentar formato YYYY-MM-DD
          const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).toISOString();
          return undefined;
        };
        const dateISO = makeDateISO(dateStr);
        const dueISO = makeDateISO(dueStr);

        for (const sec of targetSections) {
          if (type === 'task') {
            const item = {
              id: `task-${course.id}-${sec.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              title,
              description,
              courseId: course.id,
              sectionId: sec.id,
              subjectName: subjectName || undefined,
              createdBy: teacherUsername || undefined,
              createdAt: new Date().toISOString(),
              dueDate: dueISO,
              status: 'open'
            };
            tasks.push(item);
            createdTasks++;
          } else if (type === 'evaluation') {
            const maxScore = maxScoreRaw ? Number(maxScoreRaw) : undefined;
            const weight = weightRaw ? Number(weightRaw) : undefined;
            const item = {
              id: `eval-${course.id}-${sec.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              title,
              description,
              courseId: course.id,
              sectionId: sec.id,
              subjectName: subjectName || undefined,
              createdBy: teacherUsername || undefined,
              createdAt: new Date().toISOString(),
              date: dateISO,
              maxScore,
              weight
            };
            evaluations.push(item);
            createdEvaluations++;
          }
        }
      }

      localStorage.setItem('smart-student-tasks', JSON.stringify(tasks));
      localStorage.setItem('smart-student-evaluations', JSON.stringify(evaluations));

      try {
        window.dispatchEvent(new CustomEvent('tasksChanged', { detail: { created: createdTasks } }));
        window.dispatchEvent(new CustomEvent('evaluationsChanged', { detail: { created: createdEvaluations } }));
      } catch {}

      toast({
        title: 'Carga completada',
        description: `Tareas: ${createdTasks}, Evaluaciones: ${createdEvaluations}. Errores: ${errors.length}`,
        variant: errors.length ? 'destructive' : 'default'
      });
      if (errors.length) console.warn('[TASKS/EVALUATIONS IMPORT] Detalles:', errors);

      event.target.value = '';
    } catch (e) {
      console.error('Error al importar tareas/evaluaciones:', e);
      toast({ title: 'Error al importar', description: 'Revisa el formato del archivo. Usa la plantilla recomendada.', variant: 'destructive' });
      try { event.target.value = ''; } catch {}
    }
  };

  // ==========================
  // 📋 CARGA MASIVA ASISTENCIA (EXCEL)
  // ==========================
  const downloadAttendanceTemplate = async () => {
    try {
      // Plantilla CSV amigable con Excel (ES): separador ';' y BOM UTF-8 para tildes
      const headers = ['Fecha','Nombre','RUT','Curso','Sección','Estado'];
      const sample = [
        ['2025-01-01','Ana López','10000000-8','1ro Básico','A','Presente'],
        ['2025-01-01','Ana Silva','10000015-6','1ro Básico','A','Ausente']
      ];
      const escapeCSV = (v: any) => {
        const s = String(v ?? '');
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
      };
      const lines = [headers, ...sample].map(row => row.map(escapeCSV).join(';')).join('\r\n');
      const csv = '\uFEFF' + lines; // BOM UTF-8
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'attendance-template.csv';
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(a.href);
      a.remove();
    } catch (e) {
      toast({ title: 'Error', description: 'No se pudo generar la plantilla CSV de asistencia', variant: 'destructive' });
    }
  };

  // ==========================
  // 📥 Descarga plantilla de Estudiantes (Asistencia) por año
  // Ahora: generar UN SOLO sheet con columnas:
  // Fecha, Nombre, RUT, Curso, Sección, Estado
  // Filas: combinación (fecha escolar x estudiante) del año seleccionado.
  // Nota: los días hábiles excluyen feriados, vacaciones de invierno/verano y fines de semana
  //       cuando el calendario admin tiene showWeekends=true.
  // ==========================
  const downloadAttendanceStudentsTemplate = async () => {
    try {
      const XLSX = await import('xlsx');

      // Utilidades de fecha (local)
      const pad = (n: number) => String(n).padStart(2, '0');
      const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const parseLocalDate = (ymd: string) => {
        const [y, m, d] = ymd.split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
      };
      const inRange = (date: Date, range?: { start?: string; end?: string }) => {
        if (!range?.start || !range?.end) return false;
        const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const aDate = parseLocalDate(range.start);
        const bDate = parseLocalDate(range.end);
        const a = aDate.getTime();
        const b = bDate.getTime();
        const [min, max] = a <= b ? [a, b] : [b, a];
        return t >= min && t <= max;
      };
      const loadCalendarConfig = (year: number) => {
        const def = { showWeekends: true, summer: {}, winter: {}, holidays: [] as string[] } as any;
        try {
          const raw = localStorage.getItem(`admin-calendar-${year}`);
          if (!raw) return def;
          let parsed: any = null; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {/* ignore */} }
          return { ...def, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
        } catch {
          return def;
        }
      };

      const listSchoolDaysForYear = (year: number): string[] => {
        const cfg = loadCalendarConfig(year);
        const start = new Date(year, 0, 1);
        const end = new Date(year, 11, 31);
        const out: string[] = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dayKey = keyOf(d);
          if (cfg.holidays?.includes(dayKey)) continue; // feriado
          if (inRange(d, cfg.summer)) continue; // vacaciones verano
          if (inRange(d, cfg.winter)) continue; // vacaciones invierno
          const dow = d.getDay(); // 0=Dom, 6=Sab
          if (cfg.showWeekends && (dow === 0 || dow === 6)) continue; // fin de semana no laborable
          out.push(dayKey);
        }
        return out;
      };

      // Datos de estudiantes y catálogos (por año seleccionado)
      const students = LocalStorageManager.getStudentsForYear(selectedYear) || [];
      const courses = LocalStorageManager.getCoursesForYear(selectedYear) || [];
      const sections = LocalStorageManager.getSectionsForYear(selectedYear) || [];

      const courseById = new Map<string, any>(courses.map((c: any) => [c.id, c]));
      const sectionById = new Map<string, any>(sections.map((s: any) => [s.id, s]));

      // ÚNICA hoja: "Asistencia <YYYY>"
      const dates = listSchoolDaysForYear(selectedYear);
      const headers = ["Fecha", "Nombre", "RUT", "Curso", "Sección", "Estado"];
      const rows: any[] = [];
      for (const date of dates) {
        for (const s of students) {
          const courseName = courseById.get(s.courseId)?.name || '';
          const sectionName = sectionById.get(s.sectionId)?.name || '';
          rows.push([date, s.name || s.displayName || '', s.rut || '', courseName, sectionName, '']);
        }
      }

      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `Asistencia ${selectedYear}`);
      XLSX.writeFile(wb, `asistencia-estudiantes-${selectedYear}.xlsx`);
    } catch (e) {
      console.error('Error al generar plantilla de estudiantes para asistencia:', e);
      toast({ title: 'Error', description: 'No se pudo generar la plantilla de estudiantes', variant: 'destructive' });
    }
  };

  // ==========================
  // 📤 CARGA MASIVA ASISTENCIA A SQL
  // ==========================
  const handleUploadAttendanceSQL = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target?.files?.[0];
    if (!file) return;

    try {
      setShowAttendanceSQLModal(true);

      // Leer archivo con codificación UTF-8
      const text = await file.text();
      console.log(`📁 Archivo de asistencia cargado: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);

      const { headers, rows } = parseCSVforSQL(text);

      // Construir catálogos por año seleccionado
      const norm = (s: any) => String(s || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\bsecci[oó]n\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      const year = selectedYear;
      const courses = LocalStorageManager.getCoursesForYear(year) || [];
      const sections = LocalStorageManager.getSectionsForYear(year) || [];
      const students = LocalStorageManager.getStudentsForYear(year) || [];

      const courseByName = new Map<string, any>(courses.map((c: any) => [norm(c.name), c] as const));
      const sectionsByCourse = new Map<string, any[]>(courses.map((c: any) => [String(c.id), sections.filter((s: any) => String(s.courseId) === String(c.id))]));

      const cleanRUT = (rut: string) => {
        try { return cleanRut(rut) || String(rut).replace(/\./g, '').toLowerCase(); } catch { return String(rut).replace(/\./g, '').toLowerCase(); }
      };
      const studentByRut = new Map<string, any>(students.map((s: any) => [cleanRUT(String(s.rut || '')), s] as const));
      const studentByName = new Map<string, any>(students.map((s: any) => [norm(s.displayName || s.name || s.username), s] as const));

      // Función helper para obtener valores de columnas
      const get = (obj: any, keys: string[]): string => {
        const key = Object.keys(obj).find(k =>
          keys.some(searchKey =>
            String(k).toLowerCase().trim().includes(searchKey.toLowerCase())
          )
        );
        const value = key ? String(obj[key]).trim() : '';
        return value;
      };

      console.log(`🔍 Procesando ${rows.length} filas de asistencia...`);

      const attendanceRecords: any[] = [];
      const rowErrors: string[] = [];

      // Mapeo de estados
      const statusMap: Record<string, 'present' | 'absent' | 'late' | 'excused'> = {
        'presente': 'present',
        'present': 'present',
        'p': 'present',
        'ausente': 'absent',
        'absent': 'absent',
        'a': 'absent',
        'atraso': 'late',
        'late': 'late',
        'tarde': 'late',
        'l': 'late',
        'justificado': 'excused',
        'excused': 'excused',
        'j': 'excused',
      };

      rows.forEach((row: any, index: number) => {
        const rowNumber = index + 2;

        // Campos base
        const fecha = get(row, ['fecha', 'date', 'timestamp']);
        const nombre = get(row, ['nombre', 'name', 'estudiante', 'student', 'alumno']);
        const rut = get(row, ['rut', 'id', 'cedula', 'identificacion']);
        const curso = get(row, ['curso', 'course', 'grade', 'nivel', 'grado']);
        const seccion = get(row, ['seccion', 'sección', 'section', 'sala']);
        const estado = get(row, ['estado', 'status', 'asistencia']);
        const comentario = get(row, ['comentario', 'comment', 'observacion', 'observación']);

        if (index < 3) {
          console.log(`📝 Fila ${rowNumber}:`, { fecha, nombre, rut, curso, seccion, estado });
        }

        // Validaciones básicas
        if (!nombre && !rut) {
          rowErrors.push(`Fila ${rowNumber}: Falta Nombre o RUT`);
          return;
        }
        if (!fecha || !estado) {
          rowErrors.push(`Fila ${rowNumber}: Falta Fecha o Estado`);
          return;
        }

        // Fecha → ISO
        const fechaISO = parseFechaCSV(fecha);

        // Mapear IDs
        const courseObj = curso ? courseByName.get(norm(curso)) : null;
        const secs = courseObj ? (sectionsByCourse.get(String(courseObj.id)) || []) : [];
        const secObj = seccion ? secs.find((s: any) => norm(s.name) === norm(seccion)) : null;

        // Buscar estudiante
        const studentObj = (function() {
          if (rut) {
            const byRut = studentByRut.get(cleanRUT(rut));
            if (byRut) return byRut;
          }
          return studentByName.get(norm(nombre));
        })();

        if (!studentObj) {
          rowErrors.push(`Fila ${rowNumber}: Estudiante no encontrado (${nombre || rut})`);
          return;
        }

        // Normalizar estado
        const estadoNorm = norm(estado);
        const status = statusMap[estadoNorm] || 'present';

        // Crear registro de asistencia
        const record = {
          id: `att-${crypto.randomUUID()}`,
          date: fechaISO,
          courseId: courseObj?.id ? String(courseObj.id) : null,
          sectionId: secObj?.id ? String(secObj.id) : (studentObj.sectionId || null),
          studentId: String(studentObj.id),
          status,
          present: status === 'present',
          comment: comentario || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          year: selectedYear,
        };

        attendanceRecords.push(record);
      });

      if (rowErrors.length) {
        console.warn(`⚠️ Filas con error: ${rowErrors.length}`, rowErrors.slice(0, 10));
      }
      console.log(`✅ ${attendanceRecords.length} registros de asistencia procesados correctamente`);

      // Enviar a SQL
      if (attendanceRecords.length > 0) {
        await uploadAttendanceToSQL(attendanceRecords as any);
      }

      toast({
        title: rowErrors.length ? 'Carga parcial completada' : 'Carga completada',
        description: `Registros de asistencia importados: ${attendanceRecords.length}. Errores: ${rowErrors.length}`,
        variant: rowErrors.length ? 'destructive' : 'default'
      });

    } catch (e: any) {
      console.error('❌ Error en carga SQL de asistencia:', e);
      toast({
        title: 'Error en carga SQL',
        description: e?.message || 'Revisa el formato del archivo CSV',
        variant: 'destructive'
      });
      setShowAttendanceSQLModal(false);
    } finally {
      e.target.value = '';
    }
  };

  const handleBulkAttendanceUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      // Detectar CSV vs Excel y parsear filas
      const isCSV = /\.csv$/i.test(file.name) || (file.type && file.type.toLowerCase().includes('csv'));
      let rows: any[] = [];
      if (isCSV) {
        const buf = await file.arrayBuffer();
        let text = '';
        try {
          text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
        } catch {
          // Fallback para CSV guardados en ISO-8859-1
          text = new TextDecoder('iso-8859-1').decode(new Uint8Array(buf));
        }
        // Remover BOM si existe
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        // Normalizar saltos de línea
        const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = norm.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) throw new Error('CSV vacío');
        // Detectar delimitador
        const first = lines[0];
        const semi = (first.match(/;/g) || []).length;
        const comma = (first.match(/,/g) || []).length;
        const delim = semi > comma ? ';' : (comma > 0 ? ',' : ';');
        // Parser simple con comillas dobles
        const parseLine = (line: string): string[] => {
          const out: string[] = [];
          let cur = '';
          let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQ) {
              if (ch === '"') {
                if (line[i+1] === '"') { cur += '"'; i++; }
                else { inQ = false; }
              } else { cur += ch; }
            } else {
              if (ch === '"') { inQ = true; }
              else if (ch === delim) { out.push(cur); cur = ''; }
              else { cur += ch; }
            }
          }
        out.push(cur);
          return out;
        };
        const headerCells = parseLine(first).map(h => h.trim());
        rows = lines.slice(1).map(line => {
          const cells = parseLine(line);
          const obj: any = {};
          for (let i = 0; i < headerCells.length; i++) obj[headerCells[i]] = cells[i] ?? '';
          return obj;
        }).filter(obj => Object.values(obj).some(v => String(v||'').trim() !== ''));
      } else {
        const XLSX = await import('xlsx');
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        // raw:true para conservar seriales de Excel en fechas
        rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
      }

      const normalize = (s: string) => String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u00ba\u00b0]/g, '')
        .replace(/(\d+)\s*(ro|do|to)/g, '$1')
        .replace(/\s+/g, ' ').trim();
      const getByAliases = (obj: any, aliases: string[]) => {
        const key = Object.keys(obj).find(k => aliases.includes(String(k).trim().toLowerCase()));
        if (!key) return '';
        return (obj as any)[key]; // devolver crudo (puede ser número para fecha Excel)
      };

  let courses: any[] = LocalStorageManager.getCoursesForYear(selectedYear);
  let sections: any[] = LocalStorageManager.getSectionsForYear(selectedYear);
  let students: any[] = LocalStorageManager.getStudentsForYear(selectedYear);
  // Fallbacks desde claves globales si no hay datos por año
  if (!Array.isArray(courses) || courses.length === 0) {
    try { courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]') || []; } catch { courses = []; }
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    try { sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]') || []; } catch { sections = []; }
  }
  if (!Array.isArray(students) || students.length === 0) {
    try {
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]') || [];
      students = allUsers.filter((u: any) => String(u.role || '').toLowerCase() === 'student');
    } catch { students = []; }
  }
  // Validación mínima de catálogos
  if (!Array.isArray(courses) || courses.length === 0 || !Array.isArray(sections) || sections.length === 0 || !Array.isArray(students) || students.length === 0) {
    setShowAttendanceProgress(false);
    toast({ title: 'Faltan catálogos', description: 'No hay estudiantes/cursos/secciones para el año seleccionado. Importa usuarios y estructura o verifica el año activo.', variant: 'destructive' });
    try { (event as any).target.value = ''; } catch {}
    return;
  }
  // Cargar asistencia global para compatibilidad, pero preferir por año cuando se guarda
  const attendance: any[] = LocalStorageManager.getAttendance();

  const studentByUsername = new Map(students.map((s: any) => [normalize(String(s.username || '')), s]));
  const studentByRut = new Map(students.map((s: any) => [String(s.rut ? cleanRut(String(s.rut)) : ''), s]));
  const courseByName = new Map(courses.map((c: any) => [normalize(String(c.name || '')), c]));
      // Índice rápido de secciones por (courseId:nombre)
      const sectionByCourseAndName = new Map(
        sections.map((sec: any) => [
          `${sec.courseId}:${normalize(String(sec.name || ''))}`,
          sec
        ])
      );
  // (Índice se construye más abajo)
      const statusMap: Record<string,string> = {
        'present':'present','presente':'present','p':'present',
        'absent':'absent','ausente':'absent','a':'absent',
        'late':'late','atraso':'late','tarde':'late','l':'late'
      };
      const excelSerialToISO = (n: number) => {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const ms = Math.round(n * 24 * 60 * 60 * 1000);
        const d = new Date(excelEpoch.getTime() + ms);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
      };
      const makeDateISO = (val: any) => {
        if (val === undefined || val === null) return undefined;
        if (typeof val === 'number' && isFinite(val)) return excelSerialToISO(val);
        const v = String(val || '').trim();
        if (!v) return undefined;
        const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).toISOString();
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toISOString();
        return undefined;
      };

  let created = 0;
  let errorsCount = 0;

      // Intentar usar Web Worker para acelerar
      const total = rows.length;
      setShowAttendanceProgress(true);
      setAttendanceProgress({ current: 0, total, created: 0, errors: 0 });

      // Preparar catálogos "slim" para el worker
      const studentsSlim = students.map((s: any) => ({
        id: s.id,
        nameNorm: String((s.name || s.displayName || '')).toLowerCase(),
        usernameNorm: String(s.username || '').toLowerCase(),
        rutClean: String(s.rut ? cleanRut(String(s.rut)) : ''),
        courseId: s.courseId,
        sectionId: s.sectionId,
      }));
      const coursesSlim = courses.map((c: any) => ({ id: c.id, nameNorm: String(c.name || '').toLowerCase() }));
      const sectionsSlim = sections.map((sec: any) => ({ id: sec.id, courseId: sec.courseId, nameNorm: String(sec.name || '').toLowerCase() }));

      // Índice de asistencia existente por (YYYY-MM-DD:studentId)
      const attIndex = new Map<string, number>();
      attendance.forEach((a: any, idx: number) => {
        if (a?.date && a?.studentId) {
          attIndex.set(`${String(a.date).slice(0,10)}:${a.studentId}`, idx);
        }
      });

      // Crear worker dinámicamente si no existe
      if (!attendanceWorkerRef.current) {
        try {
          attendanceWorkerRef.current = new Worker(new URL('../../../workers/attendance-import.worker.ts', import.meta.url), { type: 'module' });
        } catch (err) {
          console.warn('No se pudo instanciar worker, se usará fallback en hilo principal:', err);
        }
      }

      const runOnMainThreadFallback = async () => {
        // Fallback: procesar de forma batcheada como antes
        let created = 0;
        let errorsCount = 0;
        const upserts: any[] = [];
        const normalize = (s: string) => String(s || '')
          .toLowerCase()
          .normalize('NFD').replace(/[ -\u036f]/g, '')
          .replace(/[\u00ba\u00b0]/g, '')
          .replace(/(\d+)\s*(ro|do|to)/g, '$1')
          .replace(/\s+/g, ' ').trim();
        const courseByName = new Map(courses.map((c: any) => [normalize(String(c.name || '')), c]));
        const sectionByCourseAndName = new Map(
          sections.map((sec: any) => [ `${sec.courseId}:${normalize(String(sec.name || ''))}`, sec ])
        );
        const studentByUsername = new Map(students.map((s: any) => [normalize(String(s.username || '')), s]));
        const studentByRut = new Map(students.map((s: any) => [String(s.rut ? cleanRut(String(s.rut)) : ''), s]));

        const statusMap: Record<string,string> = {
          'present':'present','presente':'present','p':'present',
          'absent':'absent','ausente':'absent','a':'absent',
          'late':'late','atraso':'late','tarde':'late','l':'late'
        };
        const excelSerialToISO = (n: number) => {
          const excelEpoch = new Date(Date.UTC(1899, 11, 30));
          const ms = Math.round(n * 24 * 60 * 60 * 1000);
          const d = new Date(excelEpoch.getTime() + ms);
          const yyyy = d.getUTCFullYear();
          const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(d.getUTCDate()).padStart(2, '0');
          return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
        };
        const makeDateISO = (val: any) => {
          if (val === undefined || val === null) return undefined;
          if (typeof val === 'number' && isFinite(val)) return excelSerialToISO(val);
          const v = String(val || '').trim();
          if (!v) return undefined;
          const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).toISOString();
          const d = new Date(v);
          if (!isNaN(d.getTime())) return d.toISOString();
          return undefined;
        };

        const BATCH = 2000;
        for (let start = 0; start < total; start += BATCH) {
          const end = Math.min(start + BATCH, total);
          for (let i = start; i < end; i++) {
            const row = rows[i];
            const dateRaw = getByAliases(row, ['date','fecha']);
            const courseRaw = getByAliases(row, ['course','curso']);
            const sectionRaw = getByAliases(row, ['section','seccion','sección']);
            const usernameRaw = getByAliases(row, ['studentusername','usuario','alumno','username']);
            const nameRaw = getByAliases(row, ['name','nombre']);
            const rutRaw = getByAliases(row, ['rut']);
            const statusRaw = getByAliases(row, ['status','estado']);
            const comment = String(getByAliases(row, ['comment','comentario','observacion','observación']) || '').trim();

            const dateISO = makeDateISO(dateRaw);
            if (!dateISO) { errorsCount++; continue; }

            let course = undefined as any;
            let section = undefined as any;
            const courseName = String(courseRaw || '').trim();
            const sectionName = String(sectionRaw || '').trim();
            if (courseName) course = courseByName.get(normalize(courseName));
            if (course && sectionName) section = sectionByCourseAndName.get(`${course.id}:${normalize(sectionName)}`);

            let student: any | undefined;
            const rutCleanVal = rutRaw ? cleanRut(String(rutRaw)) : '';
            if (rutCleanVal && studentByRut.has(rutCleanVal)) {
              student = studentByRut.get(rutCleanVal);
            } else if (usernameRaw) {
              student = studentByUsername.get(normalize(String(usernameRaw)));
            }
            if (!student && course && section && nameRaw) {
              const nameKey = normalize(String(nameRaw));
              student = students.find((s: any) => normalize(String(s.name||'')) === nameKey && s.sectionId === section.id);
            }
            if (!course && student?.courseId) course = courses.find((c: any) => c.id === student.courseId);
            if (!course) { errorsCount++; continue; }
            if (!section) {
              if (sectionName) section = sections.find((s: any) => s.courseId === course.id && normalize(String(s.name)) === normalize(sectionName));
              if (!section && student?.sectionId) {
                const secCandidate = sections.find((s: any) => s.id === student.sectionId);
                if (secCandidate && secCandidate.courseId === course.id) section = secCandidate;
              }
            }
            if (!student && course && section && nameRaw) {
              const nameKey2 = normalize(String(nameRaw));
              student = students.find((s: any) => normalize(String(s.name||'')) === nameKey2 && s.sectionId === section.id);
            }
            if (!student) { errorsCount++; continue; }
            if (!section) { errorsCount++; continue; }
            const status = statusMap[normalize(String(statusRaw || ''))];
            if (!status) { errorsCount++; continue; }

            const key = `${dateISO.slice(0,10)}:${student.id}`;
            const dupIndex = attIndex.has(key) ? (attIndex.get(key) as number) : -1;
            const record = {
              id: dupIndex >= 0 ? attendance[dupIndex].id : `att-${student.id}-${section.id}-${dateISO.slice(0,10)}`,
              date: dateISO,
              courseId: course.id,
              sectionId: section.id,
              studentId: student.id,
              status,
              present: status === 'present',
              comment: comment || undefined,
              createdAt: dupIndex >= 0 ? attendance[dupIndex].createdAt : new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            if (dupIndex >= 0) {
              attendance[dupIndex] = record;
              upserts.push(record);
            } else {
              attendance.push(record);
              attIndex.set(key, attendance.length - 1);
              created++;
              upserts.push(record);
            }
          }
          setAttendanceProgress({ current: end, total, created, errors: errorsCount });
          await new Promise(res => setTimeout(res, 0));
        }
        return { created, errorsCount, upserts };
      };

  let resultCreated = 0;
  let resultErrors = 0;

      if (attendanceWorkerRef.current) {
        const w = attendanceWorkerRef.current;
        const onMessage = (evt: MessageEvent) => {
          const { type } = evt.data || {};
          if (type === 'progress') {
            const { processed, total, created, errors } = evt.data;
            setAttendanceProgress({ current: processed, total, created, errors });
          } else if (type === 'done') {
            const { created, errors, results } = evt.data;
            if (!Array.isArray(results) || results.length === 0) {
              setShowAttendanceProgress(false);
              toast({ title: 'Archivo sin coincidencias', description: 'No se pudieron mapear filas a estudiantes del año. Verifica RUT/usuario y curso/sección.', variant: 'destructive' });
              cleanup();
              try { (event as any).target.value = ''; } catch {}
              return;
            }
            resultCreated = created || 0;
            resultErrors = errors || 0;
            // Subir directamente a SQL solo los registros procesados
            (async () => {
              try {
                const toSQL = (results as any[]).map(({ record }) => ({
                  ...record,
                  year: Number(String(record.date).slice(0,4)),
                  present: record.status === 'present'
                }));
                const yearFromData = toSQL[0]?.year || inferYearFromRows(rows) || selectedYear;
                setShowAttendanceSQLModal(true);
                await uploadAttendanceToSQL(toSQL as any);
                await countAttendanceByYear(yearFromData);
                await countAllAttendance();
                try { window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { year: yearFromData, added: toSQL.length } })); } catch {}
              } catch (e) {
                console.warn('No se pudo subir asistencia a SQL (worker):', e);
              } finally {
                setShowAttendanceProgress(false);
                try { (event as any).target.value = ''; } catch {}
              }
            })();
            cleanup();
          } else if (type === 'error') {
            console.warn('Worker error, usar fallback principal:', evt.data?.message);
            cleanup();
            runOnMainThreadFallback().then(async ({ created, errorsCount, upserts }) => {
              resultCreated = created;
              resultErrors = errorsCount;
              if (!Array.isArray(upserts) || upserts.length === 0) {
                toast({ title: 'Archivo sin coincidencias', description: 'No se pudieron mapear filas a estudiantes del año. Verifica RUT/usuario y curso/sección.', variant: 'destructive' });
                setShowAttendanceProgress(false);
                try { (event as any).target.value = ''; } catch {}
                return;
              }
              try {
                const toSQL = upserts.map(r => ({
                  ...r,
                  year: Number(String(r.date).slice(0,4)),
                  present: r.status === 'present'
                }));
                const yearFromData = toSQL[0]?.year || inferYearFromRows(rows) || selectedYear;
                setShowAttendanceSQLModal(true);
                await uploadAttendanceToSQL(toSQL as any);
                await countAttendanceByYear(yearFromData);
                await countAllAttendance();
                try { window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { year: yearFromData, added: toSQL.length } })); } catch {}
              } catch (e) {
                console.warn('No se pudo subir asistencia a SQL (fallback tras worker):', e);
              } finally {
                setShowAttendanceProgress(false);
                try { (event as any).target.value = ''; } catch {}
              }
            });
          }
        };
        const cleanup = () => {
          try { w.removeEventListener('message', onMessage as any); } catch {}
        };
        const finalize = async () => {
          cleanup();
          // Enviar a SQL en vez de LocalStorage
          try {
            const yearFromData = inferYearFromRows(rows) || selectedYear;
            const toSQL = attendance
              .filter(a => String(a?.date || '').startsWith(String(yearFromData) + '-'))
              .map(a => ({
                ...a,
                year: Number(String(a.date).slice(0,4))
              }));
            setShowAttendanceSQLModal(true);
            await uploadAttendanceToSQL(toSQL as any);
            await countAttendanceByYear(yearFromData);
            await countAllAttendance();
            try { window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { year: yearFromData, added: toSQL.length } })); } catch {}
          } catch (e) {
            console.warn('No se pudo subir asistencia a SQL, flujo LocalStorage omitido:', e);
          } finally {
            setShowAttendanceProgress(false);
            try { event.target.value = ''; } catch {}
          }
        };
        w.addEventListener('message', onMessage as any);
        // Enviar payload
        w.postMessage({ rows, studentsSlim, coursesSlim, sectionsSlim, batchSize: 5000 });
      } else {
  const { created, errorsCount, upserts } = await runOnMainThreadFallback();
        resultCreated = created;
        resultErrors = errorsCount;
        try {
          const toSQL = upserts.map(r => ({ ...r, year: Number(String(r.date).slice(0,4)), present: r.status === 'present' }));
          const yearFromData = toSQL[0]?.year || inferYearFromRows(rows) || selectedYear;
          setShowAttendanceSQLModal(true);
          await uploadAttendanceToSQL(toSQL as any);
          await countAttendanceByYear(yearFromData);
          await countAllAttendance();
          try { window.dispatchEvent(new CustomEvent('sqlAttendanceUpdated', { detail: { year: yearFromData, added: toSQL.length } })); } catch {}
        } catch (e) {
          console.warn('No se pudo subir asistencia a SQL (fallback principal):', e);
        } finally {
          setShowAttendanceProgress(false);
          try { (event as any).target.value = ''; } catch {}
        }
      }
    } catch (e) {
      console.error('Error al importar asistencia:', e);
      setShowAttendanceProgress(false);
      toast({ title: 'Error al importar', description: 'Revisa el formato del archivo. Usa la plantilla recomendada.', variant: 'destructive' });
      try { event.target.value = ''; } catch {}
    }
  };

  // ============ UI: Tarjeta SQL Asistencia (paridad con Calificaciones) ==========
  const AttendanceSQLCard = useMemo(() => {
    const connected = isAttendanceSQLConnected;
    const yearCount = attYearCount?.count ?? 0;
    const total = attTotal ?? 0;
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center w-full">
            <Upload className="w-5 h-5 mr-2" />
            {t('configBulkAttendanceTitle', 'Carga Masiva: Asistencia (SQL)')}
            <span
              className={`ml-auto text-[10px] font-semibold px-2 py-1 rounded border ${
                dbProvider === 'firebase' 
                  ? 'bg-amber-600/20 text-amber-700 dark:text-amber-300 border-amber-400/40'
                  : connected 
                    ? 'bg-emerald-600/20 text-emerald-700 dark:text-emerald-300 border-emerald-400/40' 
                    : 'bg-red-600/20 text-red-700 dark:text-red-300 border-red-400/40'
              }`}
              title={
                dbProvider === 'firebase' 
                  ? 'Firebase + LocalStorage (IndexedDB fallback)'
                  : connected 
                    ? t('sqlConnected','SQL Conectado (Supabase)') 
                    : t('sqlDisconnected','SQL Desconectado')
              }
            >
              {dbProvider === 'firebase' ? '🔥 Firebase + LS' : (connected ? '✅ SQL' : '❌ SQL')}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="p-4 border rounded-lg flex flex-col h-full">
            <p className="text-sm text-muted-foreground mb-3">
              {t('configBulkAttendanceDesc', '🗄️ Usa el Excel para registrar asistencia de forma masiva directamente en la base de datos SQL. Ventana con focus permanente, logs y cronómetro hasta completar la carga.')}
            </p>
            <div className="bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 rounded-md p-3 mb-3">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-blue-100 dark:bg-blue-900 p-2">
                  <Database className="w-4 h-4 text-blue-600 dark:text-blue-300" />
                </div>
                <div className="text-xs">
                  <div className="font-semibold text-blue-800 dark:text-blue-200">
                    {t('sqlMigrationAttendanceCompleted','Migración SQL Completada')}
                  </div>
                  <p className="text-blue-700 dark:text-blue-300/90 mt-1">
                    {t('sqlAttendanceMigrationDesc', 'La asistencia ahora se guarda en base de datos SQL para evitar límites de almacenamiento LocalStorage y mejorar el rendimiento.')}
                  </p>
                </div>
              </div>
            </div>

            {/* Contador de asistencia cargada */}
            <div className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-md p-3 mb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    {t('attendanceCounter', 'Asistencia en SQL')}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-emerald-600 dark:text-emerald-400">
                    <strong>{selectedYear}:</strong> {yearCount.toLocaleString()} {t('records','registros')}
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400 border-l border-emerald-300 pl-3">
                    <strong>{t('total','Total')}:</strong> {total.toLocaleString()} {t('records','registros')}
                  </span>
                </div>
              </div>
              {yearCount === 0 && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 ml-6">
                  {t('noAttendanceFound', 'No hay asistencia cargada para este año')}
                </p>
              )}
            </div>

            {/* Input oculto para archivo */}
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleBulkAttendanceUpload} className="hidden" id="sql-attendance-file" />

            {/* Fila de acciones 1 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
              <Button onClick={downloadAttendanceTemplate} variant="outline" className="h-11 border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/40 dark:hover:text-amber-200" title={t('downloadTemplate','Descargar Plantilla CSV')}>
                <Download className="w-4 h-4 mr-2" /> {t('downloadTemplate','Plantilla CSV')}
              </Button>
              <Button 
                onClick={() => document.getElementById('sql-attendance-file')?.click()} 
                variant="outline"
                disabled={isAttSQLUploading || !connected}
                className="h-11 border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800 dark:border-green-500 dark:text-green-300 dark:hover:bg-green-900/40 dark:hover:text-green-200"
                title={t('uploadToSQL','Subir a SQL')}
              >
                <Upload className="w-4 h-4 mr-2" /> {isAttSQLUploading ? t('processing','Procesando...') : t('uploadToSQL','Subir a SQL')}
              </Button>
            </div>

            {/* Fila de acciones 2 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              <Button onClick={downloadAttendanceStudentsTemplate} variant="outline" className="h-11 border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200" title={t('configDownloadStudentsTemplate','Descargar Estudiantes')}>
                <Download className="w-4 h-4 mr-2" /> {t('configDownloadStudentsTemplate','Descargar Estudiantes')}
              </Button>
              <Button
                onClick={() => setShowConfirmDeleteAttendanceSQL(true)}
                variant="outline"
                disabled={isAttSQLUploading || !connected}
                className="h-11 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500 dark:text-red-300 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                title={t('deleteSQLAttendance','Borrar Asistencia SQL (Año)')}
              >
                <Trash2 className="w-4 h-4 mr-2" /> {t('deleteSQL','Borrar SQL')}
              </Button>
            </div>

            {/* Estado de conexión SQL/Firebase */}
            <div className="text-xs text-muted-foreground mt-3 flex items-center gap-2">
              <Database className="w-3 h-3" />
              <span>{t('sqlStatus','Estado')}: </span>
              <span className={
                dbProvider === 'firebase' 
                  ? 'text-amber-600' 
                  : connected 
                    ? 'text-green-600' 
                    : 'text-red-600'
              }>
                {dbProvider === 'firebase' 
                  ? '🔥 Firebase + LocalStorage' 
                  : (connected ? t('connected','✅ SQL (Supabase)') : t('disconnected','❌ Desconectado'))}
              </span>
              <span>• {t('year','Año')}: {selectedYear}</span>
            </div>

          </div>
        </CardContent>
      </Card>
    );
  }, [isAttendanceSQLConnected, attYearCount, attTotal, selectedYear, isAttSQLUploading, dbProvider]);

  const handleBulkTeacherAssignmentsUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      const normalize = (s: string) => String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u00ba\u00b0]/g, '')
        .replace(/(\d+)\s*(ro|do|to)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();

      const getByAliases = (obj: any, aliases: string[]) => {
        const key = Object.keys(obj).find(k => aliases.includes(k.trim().toLowerCase()));
        return key ? String(obj[key]).trim() : '';
      };

  const courses: any[] = LocalStorageManager.getCoursesForYear(selectedYear);
  const sections: any[] = LocalStorageManager.getSectionsForYear(selectedYear);
  const teachers: any[] = LocalStorageManager.getTeachersForYear(selectedYear);
      const allUsers: any[] = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
  const teacherAssignments: any[] = LocalStorageManager.getTeacherAssignmentsForYear(selectedYear);

      const availableSubjectsAll = getAllAvailableSubjects();
      const abbrToName = new Map<string, string>();
      const nameToName = new Map<string, string>();
      const normNameToName = new Map<string, string>();
      availableSubjectsAll.forEach(s => {
        if (s.abbreviation) abbrToName.set(String(s.abbreviation).toLowerCase(), s.name);
        nameToName.set(s.name.toLowerCase(), s.name);
        normNameToName.set(normalize(s.name), s.name);
      });
      const synonyms: Record<string, string> = {
        'mat': 'mat','matematica': 'mat','matematicas': 'mat','matemáticas': 'mat',
        'len': 'len','leng': 'len','lenguaje': 'len','lengua': 'len',
        'his': 'his','hist': 'his','histo': 'his','historia': 'his',
        'cnt': 'cnt','cn': 'cnt','ciencias': 'cnt','ciencias naturales': 'cnt',
        'ing': 'ing','ingles': 'ing','inglés': 'ing',
        'efi': 'efi','educacion fisica': 'efi','educación física': 'efi','ed fisica': 'efi',
        'mus': 'mus','musica': 'mus','música': 'mus',
        'art': 'art','artes': 'art','artes visuales': 'art',
        'tec': 'tec','tecnologia': 'tec','tecnología': 'tec',
        'rel': 'rel','religion': 'rel','religión': 'rel'
      };
      const parseSubjectsToNames = (subjectsStr: string): string[] => {
        if (!subjectsStr || !subjectsStr.trim()) return [];
        return subjectsStr
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
          .map(t => {
            const key = normalize(t);
            const mapped = synonyms[key] || key;
            if (abbrToName.has(mapped)) return abbrToName.get(mapped)!;
            if (nameToName.has(mapped)) return nameToName.get(mapped)!;
            if (normNameToName.has(mapped)) return normNameToName.get(mapped)!;
            return '';
          })
          .filter(Boolean);
      };

      let created = 0;
      let updatedTeachers = 0;
      const errors: string[] = [];
      const assignmentsToAdd: any[] = [];

      const teacherByUsername = new Map(teachers.map((t: any) => [String(t.username || '').toLowerCase(), t]));
      const userByEmail = new Map(allUsers.map((u: any) => [String(u.email || '').toLowerCase(), u]));

      const hasAssignment = (a: any[], teacherId: string, sectionId: string, subjectName?: string) =>
        a.some(x => x.teacherId === teacherId && x.sectionId === sectionId && (x.subjectName || '') === (subjectName || ''));

      let rowIndex = 1;
      for (const row of rows) {
        rowIndex++;
        const teacherUsername = getByAliases(row, ['teacherusername','profesor','usuario']);
        const teacherEmail = getByAliases(row, ['teacheremail','email','correo']);
  // Aceptar alias frecuentes en distintos formatos de planillas
  const courseName = getByAliases(row, ['course','curso','grado','nivel']);
  const sectionName = getByAliases(row, ['section','sección','seccion','letra','section/letter','seccion/letra']);
  const subjectsStr = getByAliases(row, ['subjects','asignaturas','subject','asignatura','materia','ramo']);

        if (!teacherUsername && !teacherEmail) {
          errors.push(`Fila ${rowIndex}: Falta teacherUsername o teacherEmail`);
          continue;
        }
        if (!courseName) {
          errors.push(`Fila ${rowIndex}: Falta curso`);
          continue;
        }

        // Encontrar profesor por username o email
        let teacher = teacherByUsername.get(String(teacherUsername || '').toLowerCase());
        if (!teacher && teacherEmail) {
          const u = userByEmail.get(String(teacherEmail).toLowerCase());
          if (u) teacher = teachers.find((t: any) => t.username === u.username);
        }
        if (!teacher) {
          errors.push(`Fila ${rowIndex}: Profesor no encontrado (${teacherUsername || teacherEmail})`);
          continue;
        }

        const wantedCourseNorm = normalize(courseName);
        const course = courses.find((c: any) => normalize(c.name || '') === wantedCourseNorm);
        if (!course) {
          const disponibles = courses.map((c:any)=>c.name).join(', ');
          errors.push(`Fila ${rowIndex}: Curso no encontrado "${courseName}". Disponibles: ${disponibles}`);
          continue;
        }

        const sectionsForCourse = sections.filter((s: any) => s.courseId === course.id);
        const targetSections = sectionName
          ? sectionsForCourse.filter((s: any) => normalize(s.name || '') === normalize(sectionName))
          : sectionsForCourse; // si no hay sección, asignar a todas las secciones del curso
        if (targetSections.length === 0) {
          errors.push(`Fila ${rowIndex}: No hay secciones para el curso ${course.name}`);
          continue;
        }

        const subjects = parseSubjectsToNames(subjectsStr);
        const subjectsForAssign = subjects.length > 0
          ? subjects
          : (Array.isArray(teacher.selectedSubjects) && teacher.selectedSubjects.length > 0
              ? teacher.selectedSubjects
              : ['General']);

        // Crear asignaciones
        for (const sec of targetSections) {
          for (const subjectName of subjectsForAssign) {
            if (!hasAssignment(teacherAssignments, teacher.id, sec.id, subjectName) &&
                !hasAssignment(assignmentsToAdd, teacher.id, sec.id, subjectName)) {
              assignmentsToAdd.push({
                id: `ta-${teacher.id}-${sec.id}-${subjectName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                teacherId: teacher.id,
                teacherUsername: teacher.username,
                sectionId: sec.id,
                subjectName,
                createdAt: new Date().toISOString(),
                isActive: true,
                source: 'bulk-excel'
              });
              created++;
            }
          }
          // actualizar assignedSections del profesor
          if (!Array.isArray(teacher.assignedSections)) teacher.assignedSections = [];
          if (!teacher.assignedSections.includes(sec.id)) {
            teacher.assignedSections.push(sec.id);
            updatedTeachers++;
          }
        }
      }

      if (assignmentsToAdd.length > 0) {
        const nextAssignments = [...teacherAssignments, ...assignmentsToAdd];
        LocalStorageManager.setTeacherAssignmentsForYear(selectedYear, nextAssignments);
      }

      if (updatedTeachers > 0) {
        // t ya fue mutado arriba; persistimos arreglo actualizado
        LocalStorageManager.setTeachersForYear(selectedYear, teachers);
      }

      // Eventos para refrescar UI
      try {
        window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'bulk-import-excel', created } }));
        window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'bulk-teacher-assignments', created } }));
      } catch {}

      toast({
        title: 'Asignaciones cargadas',
        description: `Asignaciones creadas: ${created}. Errores: ${errors.length}`,
        variant: errors.length ? 'destructive' : 'default'
      });
      if (errors.length) console.warn('[TEACHER ASSIGNMENTS IMPORT] Detalles:', errors);

      // limpiar input
      event.target.value = '';
    } catch (e) {
      console.error('Error al importar asignaciones de profesores:', e);
      toast({
        title: 'Error al importar',
        description: 'Revisa el formato del archivo. Usa la plantilla recomendada.',
        variant: 'destructive'
      });
      try { event.target.value = ''; } catch {}
    }
  };

  const handleBulkExcelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsExcelProcessing(true);
    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      // Elegir la mejor hoja: buscar una con headers válidos y sin señales de pivot
      const requiredHeaders = ['role', 'name', 'rut'];
      const normalizeHeader = (h: string) => String(h || '')
        .trim()
        .replace(/^\uFEFF/, '')
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase();

      const looksLikePivot = (obj: any) => {
        const keys = Object.keys(obj);
        return keys.includes('Etiquetas de fila') ||
               keys.includes('Row Labels') ||
               keys.includes('Etiquetas de columna') ||
               keys.includes('Column Labels') ||
               keys.some(k => normalizeHeader(k).includes('total'));
      };

      let sheetName = workbook.SheetNames[0];
      let sheet = workbook.Sheets[sheetName];
      let rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      const hasRequired = (r: any[]) => {
        if (!Array.isArray(r) || r.length === 0) return false;
        const headers = Object.keys(r[0]).map(normalizeHeader);
        return requiredHeaders.every(req => headers.some(h => h.includes(req)));
      };

      // Si la primera hoja parece pivot o no tiene headers, buscar otra hoja válida
      if (!hasRequired(rows) || rows.some(looksLikePivot)) {
        for (const name of workbook.SheetNames) {
          const candidate = workbook.Sheets[name];
          const candidateRows: any[] = XLSX.utils.sheet_to_json(candidate, { defval: '' });
          if (hasRequired(candidateRows) && !candidateRows.some(looksLikePivot)) {
            sheetName = name;
            sheet = candidate;
            rows = candidateRows;
            break;
          }
        }
      }

      // Validaciones después de seleccionar hoja
      if (!Array.isArray(rows) || rows.length === 0) {
        setIsExcelProcessing(false);
        toast({
          title: 'Excel vacío',
          description: 'El archivo Excel no contiene datos válidos en ninguna hoja',
          variant: 'destructive'
        });
        event.target.value = '';
        return;
      }

      if (!hasRequired(rows)) {
        const headersFound = Object.keys(rows[0] || {});
        setIsExcelProcessing(false);
        toast({
          title: 'Headers faltantes en Excel',
          description: `❌ No se encontraron las columnas requeridas (role, name, rut). Headers detectados: ${headersFound.join(', ')}. Coloca la tabla en una hoja con formato tabular o usa la plantilla.`,
          variant: 'destructive'
        });
        event.target.value = '';
        return;
      }

      // Normalizador para comparar nombres con y sin tildes/símbolos
      const normalize = (s: string) => String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // quitar diacríticos
        .replace(/[º°]/g, '') // remover símbolos ordinales
        .replace(/(\d+)\s*(ro|do|to)/g, '$1') // 1ro/2do/4to -> 1/2/4
        .replace(/\s+/g, ' ') // colapsar espacios
        .trim();

      // utilitario para obtener propiedad por múltiples alias (mejorado para headers problemáticos)
      const getByAliases = (obj: any, aliases: string[]) => {
        const normalizeHeader = (header: string) => String(header || '')
          .trim()
          .replace(/^\uFEFF/, '') // remover BOM UTF-8
          .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ') // espacios no-breaking a espacios normales
          .replace(/\s+/g, ' ') // colapsar espacios múltiples
          .toLowerCase();
        
        const key = Object.keys(obj).find(k => {
          const normalizedKey = normalizeHeader(k);
          return aliases.some(alias => normalizedKey === alias.toLowerCase() || normalizedKey.includes(alias.toLowerCase()));
        });
        return key ? String(obj[key]).trim() : '';
      };

      // Cargar datos actuales
  const courses: any[] = LocalStorageManager.getCoursesForYear(selectedYear);
  const sections: any[] = LocalStorageManager.getSectionsForYear(selectedYear);
  const students: any[] = LocalStorageManager.getStudentsForYear(selectedYear);
  const teachers: any[] = LocalStorageManager.getTeachersForYear(selectedYear);
  const teacherAssignments: any[] = LocalStorageManager.getTeacherAssignmentsForYear(selectedYear);
      const admins: any[] = JSON.parse(localStorage.getItem('smart-student-administrators') || '[]');
      const allUsers: any[] = JSON.parse(localStorage.getItem('smart-student-users') || '[]');

  let createdStudents = 0;
  let updatedStudents = 0;
      let createdTeachers = 0;
      let createdAdmins = 0;
      let errors: string[] = [];
      let createdTeacherAssignments = 0;

      // Asignaciones pendientes cuando el curso/sección aún no existe en el momento de leer la fila
      const pendingTeacherAssignments: Array<{
        rut?: string; username?: string; email?: string;
        courseName: string; sectionName?: string; subjects: string[]
      }> = [];

      const findUserByUsername = (u: string) => {
        const ul = String(u || '').toLowerCase();
        return [...allUsers, ...students, ...teachers, ...admins].find((x: any) => String(x?.username || '').toLowerCase() === ul);
      };
      const isUsernameTaken = (u: string) => Boolean(findUserByUsername(u));

      const normRole = (r: string) => {
        const v = r.toLowerCase();
        if (['student','estudiante'].includes(v)) return 'student';
        if (['teacher','profesor','docente'].includes(v)) return 'teacher';
        if (['admin','administrador'].includes(v)) return 'admin';
        return '';
      };

      const availableSubjectsAll = getAllAvailableSubjects();
      const subjectsCatalog = availableSubjectsAll.map(s => s.name.toLowerCase());
      const abbrToName = new Map<string, string>(); // abrev -> nombre
      const nameToName = new Map<string, string>(); // nombre (lower) -> nombre
      const normNameToName = new Map<string, string>(); // nombre normalizado -> nombre
      availableSubjectsAll.forEach(s => {
        if (s.abbreviation) abbrToName.set(String(s.abbreviation).toLowerCase(), s.name);
        nameToName.set(s.name.toLowerCase(), s.name);
        normNameToName.set(normalize(s.name), s.name);
      });

      // Sinónimos y abreviaturas frecuentes
      const synonyms: Record<string, string> = {
        // Matemáticas
        'mat': 'mat', 'matematica': 'mat', 'matematicas': 'mat', 'matemáticas': 'mat',
        // Lenguaje
        'len': 'len', 'leng': 'len', 'lenguaje': 'len', 'lengua': 'len',
        // Historia
        'his': 'his', 'hist': 'his', 'histo': 'his', 'historia': 'his',
        // Ciencias Naturales
        'cnt': 'cnt', 'cn': 'cnt', 'ciencias': 'cnt', 'ciencias naturales': 'cnt',
        // Inglés
        'ing': 'ing', 'ingles': 'ing', 'inglés': 'ing',
        // Educación Física
        'efi': 'efi', 'educacion fisica': 'efi', 'educación física': 'efi', 'ed fisica': 'efi',
        // Música
        'mus': 'mus', 'musica': 'mus', 'música': 'mus',
        // Artes Visuales
        'art': 'art', 'artes': 'art', 'artes visuales': 'art',
        // Tecnología
        'tec': 'tec', 'tecnologia': 'tec', 'tecnología': 'tec',
        // Religión
        'rel': 'rel', 'religion': 'rel', 'religión': 'rel'
      };

      const parseSubjectsToNames = (subjectsStr: string): string[] => {
        if (!subjectsStr || !subjectsStr.trim()) return [];
        return subjectsStr
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
          .map(t => {
            const key = normalize(t);
            const mapped = synonyms[key] || key; // mapped puede ser abrev o nombre normalizado
            // 1) probar como abreviatura
            if (abbrToName.has(mapped)) return abbrToName.get(mapped)!;
            // 2) probar como nombre exacto lower
            if (nameToName.has(mapped)) return nameToName.get(mapped)!;
            // 3) probar como nombre normalizado
            if (normNameToName.has(mapped)) return normNameToName.get(mapped)!;
            return '';
          })
          .filter(Boolean);
      };

      const hasAssignment = (a: any[], teacherId: string, sectionId: string, subjectName?: string) =>
        a.some(x => x.teacherId === teacherId && x.sectionId === sectionId && (x.subjectName || '') === (subjectName || ''));

      // Nuevo: rastrear profesores ya limpiados para esta importación
      const clearedTeachers = new Set<string>();

      let rowIndex = 1; // para mensajes (1 = encabezado), datos inician en 2
      let autoFixedUsernames = 0; // conteo de usernames corregidos automáticamente
      for (const row of rows) {
        rowIndex++;
        const role = normRole(getByAliases(row, ['role','rol']));
        const name = getByAliases(row, ['name','nombre']);
        const rut = cleanRut(getByAliases(row, ['rut']));
        const email = getByAliases(row, ['email','correo']);
        const desiredUsername = getByAliases(row, ['username','usuario']);
        
        // Auto-generar username si está vacío
        let username = desiredUsername;
        if (!username || username.trim() === '') {
          // Intentar generar desde email
          if (email && email.includes('@')) {
            username = email.split('@')[0].toLowerCase().replace(/[^a-zA-Z0-9._-]/g, '');
          }
          // Si no hay email válido, generar desde nombre + RUT
          if (!username || username.length < 3) {
            const namePart = name.toLowerCase()
              .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
              .replace(/[^a-zA-Z0-9]/g, '').slice(0, 6); // solo letras/números, máx 6 chars
            const rutPart = rut ? rut.replace(/[^0-9]/g, '').slice(-4) : Math.random().toString().slice(2, 6);
            username = namePart + rutPart;
          }
          console.log(`🔧 Username auto-generado para "${name}": ${username}`);
        }
        
        // Validaciones y corrección automática de formato
        const usernamePattern = /^[a-zA-Z0-9._-]{3,}$/; // username simple
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // email válido
        const makeSafe = (s: string) => {
          const cleaned = String(s || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
            .replace(/[^a-z0-9._-]/g, '.') // reemplazar caracteres no permitidos por punto
            .replace(/\.{2,}/g, '.') // colapsar puntos múltiples
            .replace(/^\.|\.$/g, ''); // quitar punto inicial/final
          return cleaned;
        };
        const ensureUnique = (base: string) => {
          let candidate = base;
          if (!candidate || candidate.length < 3) candidate = (makeSafe(name).slice(0,6) || 'user') + (rut ? rut.replace(/[^0-9]/g, '').slice(-4) : Math.random().toString().slice(2,6));
          let idx = 0;
          while (isUsernameTaken(candidate)) {
            idx++;
            const suffix = rut ? rut.replace(/[^0-9]/g, '').slice(-2) : String(idx).padStart(2,'0');
            const basePart = candidate.replace(/[-._]?[0-9]*$/, '');
            candidate = `${basePart}-${suffix}`;
            if (idx > 50) break; // evitar bucle infinito
          }
          return candidate;
        };

        // Si no cumple patrón ni es email, intentar corregir
        if (!usernamePattern.test(username) && !emailPattern.test(username)) {
          const original = username;
          let fixed = makeSafe(original);
          if (!usernamePattern.test(fixed)) {
            fixed = ensureUnique(fixed);
          }
          if (usernamePattern.test(fixed)) {
            username = fixed;
            autoFixedUsernames++;
            console.log(`🧹 Username corregido automáticamente (fila ${rowIndex}): "${original}" → "${username}"`);
          } else {
            // Como último intento, usar parte local del email válida
            if (email && email.includes('@')) {
              const local = makeSafe(email.split('@')[0]);
              const uniqueLocal = ensureUnique(local);
              if (usernamePattern.test(uniqueLocal)) {
                username = uniqueLocal;
                autoFixedUsernames++;
              } else {
                errors.push(`Fila ${rowIndex}: Username inválido "${original}" (usa letras/números . _ - o un email válido)`);
                continue;
              }
            } else {
              errors.push(`Fila ${rowIndex}: Username inválido "${original}" (usa letras/números . _ - o un email válido)`);
              continue;
            }
          }
        }
        const password = getByAliases(row, ['password','contraseña','contrasena']);
        const courseName = getByAliases(row, ['course','curso']);
        const sectionName = getByAliases(row, ['section','sección','seccion']);
        const subjectsStr = getByAliases(row, ['subjects','asignaturas']);

        if (!role || !name || !rut) {
          errors.push(`Fila inválida (faltan role/name/rut): ${JSON.stringify(row)}`);
          continue;
        }

        const baseUser = {
          id: (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`) as string,
          username,
          name,
          email,
          rut,
          role,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        } as any;

  // El username puede ser un email o un nombre simple; ahora se corrige automáticamente si trae caracteres inválidos
  // Asegurar displayName consistente basado en name
        baseUser.displayName = baseUser.displayName || name;

  if (role === 'student') {
          // Duplicados: solo bloquear si ya existe en el año seleccionado
          const usernameLower = String(username).toLowerCase();
          const existsInYear = students.find((s:any)=> String(s.username||'').toLowerCase() === usernameLower);
          if (existsInYear) {
            errors.push(`Fila ${rowIndex}: Username duplicado "${username}" (estudiante ya existe en ${selectedYear})`);
            continue;
          }
          // Si existe globalmente como estudiante, reutilizarlo; si no, crear usuario nuevo
          const existingGlobal = allUsers.find((u:any)=> String(u.username||'').toLowerCase() === usernameLower && String(u.role||'').toLowerCase()==='student');

          const wantedCourseNorm = normalize(courseName);
          const course = courses.find((c: any) => normalize(c.name || '') === wantedCourseNorm);
          if (!course) {
            const disponibles = courses.map((c:any)=>c.name).join(', ');
            errors.push(`Fila ${rowIndex}: Curso no encontrado "${courseName}" para ${name}. Disponibles: ${disponibles}`);
            continue;
          }
          const wantedSectionNorm = normalize(sectionName);
          const section = sections.find((s: any) => s.courseId === course.id && normalize(s.name || '') === wantedSectionNorm);
          if (!section) {
            const seccDisponibles = sections.filter((s:any)=>s.courseId===course.id).map((s:any)=>s.name).join(', ');
            errors.push(`Fila ${rowIndex}: Sección no encontrada "${sectionName}" para ${name} (curso ${course.name}). Disponibles: ${seccDisponibles || 'Ninguna'}`);
            continue;
          }
          // Estudiante: si subjects está vacío, habilitar todas las asignaturas; si no, usar las declaradas
          const allowedSubjects = (subjectsStr && subjectsStr.trim())
            ? parseSubjectsToNames(subjectsStr)
            : availableSubjectsAll.map(s => s.name);

          const idToUse = existingGlobal?.id || baseUser.id;
          const studentRecord = {
            ...baseUser,
            id: idToUse,
            uniqueCode: EducationCodeGenerator.generateStudentCode(),
            role: 'student',
            courseId: course.id,
            sectionId: section.id,
            allowedSubjects
          };
          students.push(studentRecord);
          // Agregar al arreglo principal de usuarios solo si NO existía globalmente
          if (!existingGlobal) {
            allUsers.push({ ...studentRecord, role: 'student', password, displayName: name, email: baseUser.email, username: baseUser.username });
          }
          createdStudents++;
        } else if (role === 'teacher') {
          // Permitir múltiples filas para el mismo profesor (merge), pero bloquear si el username pertenece a OTRO rol
          const existingUser = findUserByUsername(username);
          if (existingUser && String(existingUser.role || '').toLowerCase() !== 'teacher') {
            errors.push(`Fila ${rowIndex}: Username en uso por otro rol "${username}"`);
            continue;
          }
          // Profesores: permitir abreviaturas (MAT, LEN, HIST, CPC, etc.) o nombres completos
          const selectedSubjects = parseSubjectsToNames(subjectsStr);
          if (selectedSubjects.length === 0) {
            errors.push(`Profesor sin asignaturas válidas: ${name}`);
          }

          // Intentar encontrar profesor existente por RUT/username/email (para evitar duplicados)
          const teacherIdx = teachers.findIndex((t: any) =>
            (t.rut && t.rut === rut) ||
            (t.username && t.username.toLowerCase() === (baseUser.username || '').toLowerCase()) ||
            (t.email && t.email.toLowerCase() === (baseUser.email || '').toLowerCase())
          );

          let teacherRef: any;
          if (teacherIdx >= 0) {
            // Fusionar materias seleccionadas
            const prev = teachers[teacherIdx];
            const mergedSubjects = Array.from(new Set([...(prev.selectedSubjects || []), ...selectedSubjects]));
            teachers[teacherIdx] = { ...prev, selectedSubjects: mergedSubjects, updatedAt: new Date() };
            teacherRef = teachers[teacherIdx];
          } else {
            teacherRef = {
              ...baseUser,
              uniqueCode: EducationCodeGenerator.generateTeacherCode(),
              role: 'teacher',
              assignedSections: [],
              selectedSubjects
            };
            teachers.push(teacherRef);
            createdTeachers++;
            // Agregar al arreglo principal de usuarios SOLO cuando se crea el usuario
            allUsers.push({ ...teacherRef, role: 'teacher', password, displayName: name, email: baseUser.email, username: baseUser.username });
          }

          // Si este archivo especifica curso/sección para este profesor, limpiar asignaciones anteriores UNA vez
          if (courseName && !clearedTeachers.has(teacherRef.id)) {
            // 1) Limpiar asignaciones existentes del profesor
            for (let i = teacherAssignments.length - 1; i >= 0; i--) {
              if (teacherAssignments[i]?.teacherId === teacherRef.id) {
                teacherAssignments.splice(i, 1);
              }
            }
            // 2) Reiniciar secciones asignadas del profesor
            teacherRef.assignedSections = [];
            // 3) Reiniciar materias seleccionadas: se reconstruyen con las filas del archivo
            teacherRef.selectedSubjects = [];
            clearedTeachers.add(teacherRef.id);
          }

          // Intentar crear asignaciones si vienen curso/sección en la fila
          const wantedCourseNorm = normalize(courseName);
          const wantedSectionNorm = normalize(sectionName);
          const course = courses.find((c: any) => normalize(c.name || '') === wantedCourseNorm);
          const secs = course
            ? sections.filter((s: any) => s.courseId === course.id && (!wantedSectionNorm || normalize(s.name || '') === wantedSectionNorm))
            : [];

          // Unir materias a nivel de profesor cuando se van procesando filas (si fue limpiado, parte vacío)
          if (selectedSubjects.length > 0) {
            const merged = Array.from(new Set([...(teacherRef.selectedSubjects || []), ...selectedSubjects]));
            teacherRef.selectedSubjects = merged;
          }
          const subjectsForAssign = (teacherRef.selectedSubjects && teacherRef.selectedSubjects.length > 0)
            ? teacherRef.selectedSubjects
            : selectedSubjects;
          if (course && secs.length > 0) {
            for (const sec of secs) {
              for (const subjectName of subjectsForAssign) {
                if (!hasAssignment(teacherAssignments, teacherRef.id, sec.id, subjectName)) {
                  teacherAssignments.push({
                    id: `ta-${teacherRef.id}-${sec.id}-${subjectName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    teacherId: teacherRef.id,
                    teacherUsername: teacherRef.username,
                    courseId: course.id,
                    sectionId: sec.id,
                    subjectName,
                    isActive: true,
                    createdAt: new Date().toISOString()
                  });
                  createdTeacherAssignments++;
                }
              }
              // Sincronizar assignedSections del profesor
              if (!Array.isArray(teacherRef.assignedSections)) teacherRef.assignedSections = [];
              if (!teacherRef.assignedSections.includes(sec.id)) teacherRef.assignedSections.push(sec.id);
            }
          } else if (courseName) {
            // Guardar pendiente si el curso/sección aún no existe
            pendingTeacherAssignments.push({
              rut,
              username: baseUser.username,
              email: baseUser.email,
              courseName,
              sectionName,
              subjects: subjectsForAssign
            });
          }
        } else if (role === 'admin') {
          // Duplicados para admins: no permitir username ya existente
          const existingAdmin = (admins.find((a:any)=> String(a.username||'').toLowerCase() === String(username).toLowerCase())
            || (allUsers.find((u:any)=> String(u.username||'').toLowerCase() === String(username).toLowerCase() && String(u.role||'').toLowerCase()==='admin')));
          if (existingAdmin) {
            errors.push(`Fila ${rowIndex}: Username duplicado "${username}" (admin ya existe)`);
            continue;
          }
          const newAdmin = {
            ...baseUser,
            uniqueCode: EducationCodeGenerator.generateAdminCode(),
            role: 'admin',
            displayName: name,
            activeCourses: [],
            password
          };
          admins.push(newAdmin);
          // Agregar al arreglo principal de usuarios SOLO cuando se crea el usuario
          allUsers.push({ ...newAdmin, role: 'admin', password, displayName: name, email: baseUser.email, username: baseUser.username });
          createdAdmins++;
        } else {
          errors.push(`Rol desconocido: ${getByAliases(row, ['role','rol'])}`);
          continue;
        }

      }

      // Persistir cambios
  try { LocalStorageManager.setStudentsForYear(selectedYear, students); }
  catch (e) {
    console.error('Quota when saving students:', e);
    toast({ title: 'Almacenamiento casi lleno', description: 'No se pudieron guardar todos los estudiantes por límite del navegador. Intenta dividir el archivo o limpiar datos.', variant: 'destructive' });
  }
  try { LocalStorageManager.setTeachersForYear(selectedYear, teachers); }
  catch (e) {
    console.error('Quota when saving teachers:', e);
  }
      localStorage.setItem('smart-student-administrators', JSON.stringify(admins));
      // Deduplicar usuarios por RUT o username/email + rol para evitar múltiples entradas por filas repetidas
      const dedupMap = new Map<string, any>();
      for (const u of allUsers) {
        const rutKey = cleanRut(u.rut || '') || '';
        const idKey = rutKey || (u.username ? `u:${String(u.username).toLowerCase()}` : (u.email ? `e:${String(u.email).toLowerCase()}` : `id:${u.id}`));
        const roleKey = String(u.role || '').toLowerCase();
        const key = `${idKey}|${roleKey}`;
        if (!dedupMap.has(key)) dedupMap.set(key, u);
      }
      const uniqueUsers = Array.from(dedupMap.values());
  if (!safeSaveSmartStudentUsers(uniqueUsers, 'bulk-excel users dedup')) {
    console.warn('No se pudieron guardar usuarios (bulk-excel users dedup)');
  }
      try { window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'bulk-excel-users-dedup', total: uniqueUsers.length } })); } catch {}
  LocalStorageManager.setTeacherAssignmentsForYear(selectedYear, teacherAssignments);
  // Espejo global para compatibilidad con páginas que leen sin año
  try { localStorage.setItem('smart-student-teacher-assignments', JSON.stringify(teacherAssignments)); } catch {}
  try { window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-teacher-assignments', newValue: JSON.stringify(teacherAssignments) })); } catch {}
  try { window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'bulk-import-excel-initial' } })); } catch {}

      // Auto: crear cursos/Secciones estándar si faltan y recalcular contadores
      try {
        // 1) Crear cursos estándar si no existen
  const coursesBefore = LocalStorageManager.getCoursesForYear(selectedYear);
  const createCoursesRes = EducationAutomation.createStandardCourses?.(translate, selectedYear);
  const coursesAfter = LocalStorageManager.getCoursesForYear(selectedYear);

        // 2) Crear secciones A/B para todos los cursos (modo forzado asegura cobertura total)
  const createSectionsRes = EducationAutomation.forceCreateSectionsForAllCourses?.(translate, selectedYear);

        // 3) Recalcular contadores de estudiantes por sección
  const recalcRes = EducationAutomation.recalculateSectionCounts?.(translate, selectedYear);

        console.log('[BULK IMPORT][AUTO] createCourses:', createCoursesRes, 'createSections:', createSectionsRes, 'recalc:', recalcRes);

        // Resolver asignaciones pendientes ahora que podrían existir cursos/secciones
        if (pendingTeacherAssignments.length > 0) {
          const coursesNow: any[] = LocalStorageManager.getCoursesForYear(selectedYear);
          const sectionsNow: any[] = LocalStorageManager.getSectionsForYear(selectedYear);

          for (const pending of pendingTeacherAssignments) {
            const t = teachers.find((x: any) =>
              (pending.rut && x.rut === pending.rut) ||
              (pending.username && String(x.username || '').toLowerCase() === String(pending.username || '').toLowerCase()) ||
              (pending.email && String(x.email || '').toLowerCase() === String(pending.email || '').toLowerCase())
            );
            if (!t) continue;
            const course = coursesNow.find((c: any) => normalize(c.name || '') === normalize(pending.courseName));
            if (!course) continue;
            const secs = pending.sectionName
              ? sectionsNow.filter((s: any) => s.courseId === course.id && normalize(s.name || '') === normalize(String(pending.sectionName || '')))
              : sectionsNow.filter((s: any) => s.courseId === course.id);
            for (const sec of secs) {
              for (const subjectName of pending.subjects) {
                if (!hasAssignment(teacherAssignments, t.id, sec.id, subjectName)) {
                  teacherAssignments.push({
                    id: `ta-${t.id}-${sec.id}-${subjectName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    teacherId: t.id,
                    teacherUsername: t.username,
                    courseId: course.id,
                    sectionId: sec.id,
                    subjectName,
                    isActive: true,
                    createdAt: new Date().toISOString()
                  });
                  createdTeacherAssignments++;
                }
              }
              if (!Array.isArray(t.assignedSections)) t.assignedSections = [];
              if (!t.assignedSections.includes(sec.id)) t.assignedSections.push(sec.id);
            }
          }

          // Persistir asignaciones y profesores actualizados tras resolver pendientes
          LocalStorageManager.setTeachersForYear(selectedYear, teachers);
          LocalStorageManager.setTeacherAssignmentsForYear(selectedYear, teacherAssignments);
          try { window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'bulk-import-excel-pending-resolved' } })); } catch {}
        }

        // 4) Disparar correcciones dinámicas si están disponibles (mantener comportamiento previo)
        if (createdStudents > 0 && typeof window.regenerarAsignacionesDinamicas === 'function') {
          window.regenerarAsignacionesDinamicas();
        }

        // 5) Notificar pestañas relacionadas para refrescar datos (Cursos y Secciones)
        try {
          window.dispatchEvent(new CustomEvent('coursesChanged', { detail: { source: 'bulk-import-excel' } }));
          window.dispatchEvent(new CustomEvent('sectionsChanged', { detail: { source: 'bulk-import-excel' } }));
        } catch {}
        // Y reflejar espejo global para vistas legacy con StorageEvent
        try {
          const coursesY2 = LocalStorageManager.getCoursesForYear(selectedYear) || [];
          localStorage.setItem('smart-student-courses', JSON.stringify(coursesY2));
          window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-courses', newValue: JSON.stringify(coursesY2) }));
        } catch {}
        try {
          const sectionsY2 = LocalStorageManager.getSectionsForYear(selectedYear) || [];
          localStorage.setItem('smart-student-sections', JSON.stringify(sectionsY2));
          window.dispatchEvent(new StorageEvent('storage', { key: 'smart-student-sections', newValue: JSON.stringify(sectionsY2) }));
        } catch {}
      } catch (e) {
        console.warn('[BULK IMPORT][AUTO] No se pudo completar la automatización post-carga:', e);
      }

      // Fallback: si el Excel NO especificó curso/sección pero sí materias de profesores,
      // crear asignaciones para TODAS las secciones del año seleccionado evitando duplicados.
      try {
        const coursesNow: any[] = LocalStorageManager.getCoursesForYear(selectedYear) || [];
        const sectionsNow: any[] = LocalStorageManager.getSectionsForYear(selectedYear) || [];
        const teachersNow: any[] = LocalStorageManager.getTeachersForYear(selectedYear) || teachers || [];
        let createdInFallback = 0;

        for (const t of teachersNow) {
          const subjects: string[] = Array.isArray(t?.selectedSubjects) ? t.selectedSubjects : [];
          if (!subjects || subjects.length === 0) continue; // sin materias no hay qué asignar

          // Si ya tiene assignedSections, solo rellenamos faltantes; si no, asignamos a todas las secciones
          const targetSections = Array.isArray(t.assignedSections) && t.assignedSections.length > 0
            ? sectionsNow.filter((s: any) => t.assignedSections.includes(s.id))
            : sectionsNow;

          for (const sec of targetSections) {
            const course = coursesNow.find((c: any) => c.id === sec.courseId);
            if (!course) continue;
            for (const subjectName of subjects) {
              if (!hasAssignment(teacherAssignments, t.id, sec.id, subjectName)) {
                teacherAssignments.push({
                  id: `ta-${t.id}-${sec.id}-${subjectName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  teacherId: t.id,
                  teacherUsername: t.username,
                  courseId: course.id,
                  sectionId: sec.id,
                  subjectName,
                  isActive: true,
                  createdAt: new Date().toISOString()
                });
                createdTeacherAssignments++;
                createdInFallback++;
              }
            }
            // mantener assignedSections sincronizado
            if (!Array.isArray(t.assignedSections)) t.assignedSections = [];
            if (!t.assignedSections.includes(sec.id)) t.assignedSections.push(sec.id);
          }
        }

        if (createdInFallback > 0) {
          // Persistir y notificar si creamos algo en el fallback
          LocalStorageManager.setTeachersForYear(selectedYear, teachersNow);
          LocalStorageManager.setTeacherAssignmentsForYear(selectedYear, teacherAssignments);
          try { window.dispatchEvent(new CustomEvent('teacherAssignmentsChanged', { detail: { action: 'bulk-import-excel-fallback', created: createdInFallback } })); } catch {}
        }
      } catch (e) {
        console.warn('[BULK IMPORT][FALLBACK] No se pudieron crear asignaciones globales:', e);
      }

  // Notificar a otros módulos (antes del toast) para refrescar vistas
      try {
        window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'bulk-import-excel', students: createdStudents, teachers: createdTeachers, admins: createdAdmins } }));
        if (createdStudents > 0) {
          window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'bulk-import-excel' } }));
        }
      } catch {}

      // Construir breve desglose de errores comunes
      const dupStudentErrors = errors.filter(e=>/Username duplicado.*estudiante/i.test(e)).length;
      const dupTeacherOtherRole = errors.filter(e=>/Username en uso por otro rol/i.test(e)).length;
      const invalidUsernameErrors = errors.filter(e=>/Username inválido/i.test(e)).length;
      const missingUsernameErrors = errors.filter(e=>/Falta username/i.test(e)).length;
      const shortSummaryParts = [] as string[];
      if (dupStudentErrors) shortSummaryParts.push(`Usernames duplicados (estudiantes): ${dupStudentErrors}`);
      if (dupTeacherOtherRole) shortSummaryParts.push(`Usernames usados por otro rol: ${dupTeacherOtherRole}`);
      if (invalidUsernameErrors) shortSummaryParts.push(`Usernames inválidos: ${invalidUsernameErrors}`);
      if (missingUsernameErrors) shortSummaryParts.push(`Usernames faltantes: ${missingUsernameErrors}`);
      const shortSummary = shortSummaryParts.length ? ` | ${shortSummaryParts.join(' | ')}` : '';

      toast({
        title: 'Carga masiva completada',
        description: `Estudiantes: ${createdStudents}, Profesores: ${createdTeachers}, Admins: ${createdAdmins}. Asignaciones profesor: ${createdTeacherAssignments}. Usernames corregidos: ${autoFixedUsernames}. Errores: ${errors.length}${shortSummary}`,
        variant: errors.length ? 'destructive' : 'default'
      });

      // Guardar resumen para mostrarlo debajo de los botones
      setExcelImportSummary({
        admins: createdAdmins,
        teachers: createdTeachers,
        students: createdStudents,
        guardians: 0,
        errors: errors.length,
        errorMessages: errors,
        timestamp: new Date().toISOString()
      });
  // Abrir ventana emergente con el resultado
  setShowExcelSummaryDialog(true);

      if (errors.length) {
        console.warn('[EXCEL IMPORT] Detalles:', errors);
      }

      setRefreshUsers(prev => prev + 1);
    } catch (e) {
      console.error('Error al importar Excel:', e);
      toast({
        title: 'Error al importar Excel',
        description: 'Revisa el formato del archivo. Usa la plantilla recomendada.',
        variant: 'destructive'
      });
    } finally {
      setIsExcelProcessing(false);
      // limpiar input
      event.target.value = '';
    }
  };

  // ✅ NUEVA FUNCIÓN: Reparar usuarios existentes con campos faltantes
  const repairExistingUsers = () => {
    try {
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      if (allUsers.length === 0) return;

      console.log('🔧 [REPARACIÓN] Iniciando reparación de usuarios existentes...');
      
      let repairedCount = 0;
      const repairedUsers = allUsers.map((user: any) => {
        const originalUser = { ...user };
        let needsRepair = false;

        // Verificar y reparar campos obligatorios
        if (!user.id) {
          user.id = crypto.randomUUID();
          needsRepair = true;
        }
        
        if (!user.username || user.username.trim() === '') {
          user.username = 'user_' + Math.random().toString(36).substr(2, 8);
          needsRepair = true;
        }
        
        if (!user.displayName) {
          user.displayName = user.name || 'Usuario Sin Nombre';
          needsRepair = true;
        }
        
        if (!user.password) {
          user.password = '1234'; // Password por defecto
          needsRepair = true;
        }
        
        if (!user.role) {
          user.role = 'student'; // Rol por defecto
          needsRepair = true;
        }
        
        if (!Array.isArray(user.activeCourses)) {
          user.activeCourses = user.role === 'admin' ? [] : ['4to Básico'];
          needsRepair = true;
        }
        
        if (!user.email) {
          user.email = `${user.username}@example.com`;
          needsRepair = true;
        }
        
        if (user.isActive === undefined || user.isActive === null) {
          user.isActive = true;
          needsRepair = true;
        }
        
        if (!user.createdAt) {
          user.createdAt = new Date();
          needsRepair = true;
        }
        
        if (!user.updatedAt) {
          user.updatedAt = new Date();
          needsRepair = true;
        }

        if (needsRepair) {
          repairedCount++;
          console.log(`🔧 Usuario reparado: ${user.username}`);
        }

        return user;
      });

      if (repairedCount > 0) {
  safeSaveSmartStudentUsers(repairedUsers, 'repairExistingUsers');
        
        toast({
          title: translate('configUsersRepairedTitle') || 'Usuarios reparados',
          description: translate('configUsersRepairedDescription') || `Se repararon ${repairedCount} usuarios con campos faltantes`,
          variant: 'default'
        });
        
        console.log(`✅ [REPARACIÓN] ${repairedCount} usuarios reparados exitosamente`);
      } else {
        console.log('✅ [REPARACIÓN] Todos los usuarios ya tienen los campos necesarios');
      }
    } catch (error) {
      console.error('❌ Error reparando usuarios:', error);
      toast({
        title: translate('error') || 'Error',
        description: translate('configRepairUsersError') || 'Error al reparar usuarios',
        variant: 'destructive'
      });
    }
  };

  // ✅ FUNCIÓN ELIMINADA: resetAllData - La sección "Reiniciar Sistema" fue removida de la UI
  /*
  const resetAllData = async () => {
    // ... función comentada completa ...
  };
  
  useEffect(() => {
    (window as any).__resetAllDataHandler = resetAllData;
    return () => {
      delete (window as any).__resetAllDataHandler;
    };
  }, []);
  
  const handleResetFromPanel = () => {
    setShowResetConfirm(false);
    resetAllData();
  };
  */

  const regeneratePasswords = async () => {
    setIsLoading(true);
    try {
  const students = LocalStorageManager.getStudentsForYear(selectedYear);
  const teachers = LocalStorageManager.getTeachersForYear(selectedYear);
      
      let updatedCount = 0;

      // Update main users array with new passwords
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const updatedUsers = allUsers.map((user: any) => {
        const newPassword = UsernameGenerator.generateRandomPassword(config.defaultPasswordLength);
        updatedCount++;
        return { ...user, password: newPassword };
      });

  safeSaveSmartStudentUsers(updatedUsers, 'regeneratePasswords');

      toast({
        title: translate('configPasswordsRegeneratedTitle') || 'Contraseñas regeneradas',
        description: translate('configPasswordsRegeneratedDescription') || 'Se regeneraron {{count}} contraseñas'.replace('{{count}}', updatedCount.toString()),
        variant: 'default'
      });
    } catch (error) {
      toast({
        title: translate('error') || 'Error',
        description: translate('configPasswordsRegeneratedError') || 'No se pudieron regenerar las contraseñas',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Functions for user creation modal
  const handleCreateUser = async () => {
    try {
      // Validation
      if (!createUserFormData.name.trim()) {
        toast({
          title: translate('error') || 'Error',
          description: translate('userManagementFillAllFields') || 'Por favor, completa todos los campos requeridos',
          variant: 'destructive'
        });
        return;
      }

      // RUT validation (required for all users)
  const rut = cleanRut((createUserFormData as any).rut?.trim() || '');
      if (!rut) {
        toast({
          title: translate('userManagementValidationError') || 'Error de validación',
          description: translate('userManagementRutRequired') || 'El RUT es requerido',
          variant: 'destructive'
        });
        return;
      }
    if (!validateRut(rut)) {
        toast({
          title: translate('userManagementValidationError') || 'Error de validación',
      description: translate('userManagementRutInvalid') || 'RUT inválido',
          variant: 'destructive'
        });
        return;
      }

      // Password validation for manual input
      if (!createUserFormData.autoGenerate) {
        if (!createUserFormData.username.trim() || !createUserFormData.password.trim()) {
          toast({
            title: translate('error') || 'Error',
            description: translate('userManagementFillAllFields') || 'Por favor, completa todos los campos requeridos',
            variant: 'destructive'
          });
          return;
        }
        if (createUserFormData.password !== createUserFormData.confirmPassword) {
          toast({
            title: translate('error') || 'Error',
            description: translate('userManagementPasswordsDoNotMatch') || 'Las contraseñas no coinciden',
            variant: 'destructive'
          });
          return;
        }
      }

      // Student validation
      if (createUserFormData.role === 'student' && (!createUserFormData.courseId || !createUserFormData.section)) {
        toast({
          title: translate('error') || 'Error',
          description: translate('userManagementSelectCourseSection') || 'Por favor, selecciona un curso y una sección',
          variant: 'destructive'
        });
        return;
      }

      // Teacher validation
      if (createUserFormData.role === 'teacher' && (!createUserFormData.selectedSubjects || createUserFormData.selectedSubjects.length === 0)) {
        toast({
          title: translate('error') || 'Error',
          description: translate('userManagementSelectSubject') || 'Por favor, selecciona una materia',
          variant: 'destructive'
        });
        return;
      }

      // Guardian validation
      if (createUserFormData.role === 'guardian') {
        const studentIds = (createUserFormData as any).studentIds as string[] | undefined;
        if (!studentIds || studentIds.length === 0) {
          toast({
            title: translate('error') || 'Error',
            description: translate('userManagementSelectStudentForGuardian') || 'Selecciona al menos un estudiante para el apoderado',
            variant: 'destructive'
          });
          return;
        }
      }

      // Generate credentials if auto-generate is enabled
      const username = createUserFormData.autoGenerate 
        ? UsernameGenerator.generateFromName(createUserFormData.name, createUserFormData.role as any)
        : createUserFormData.username.trim();
      
      const password = createUserFormData.autoGenerate
        ? UsernameGenerator.generateRandomPassword(config.defaultPasswordLength)
        : createUserFormData.password;

      const baseUser = {
        id: crypto.randomUUID(),
        username: username,
        name: createUserFormData.name.trim(),
        email: createUserFormData.email.trim(),
  rut,
        role: createUserFormData.role,
        password: password, // ✅ Agregar password al baseUser
        displayName: createUserFormData.name.trim(), // ✅ Agregar displayName
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      if (createUserFormData.role === 'student') {
        const newStudent = {
          ...baseUser,
          uniqueCode: EducationCodeGenerator.generateStudentCode(),
          role: 'student',
          courseId: createUserFormData.courseId,
          sectionId: createUserFormData.section
        };

  const students = LocalStorageManager.getStudentsForYear(selectedYear);
  const updatedStudents = [...students, newStudent];
  LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);

      } else if (createUserFormData.role === 'teacher') {
        const newTeacher = {
          ...baseUser,
          uniqueCode: EducationCodeGenerator.generateTeacherCode(),
          role: 'teacher',
          assignedSections: [],
          selectedSubjects: createUserFormData.selectedSubjects
        };

  const teachers = LocalStorageManager.getTeachersForYear(selectedYear);
  const updatedTeachers = [...teachers, newTeacher];
  LocalStorageManager.setTeachersForYear(selectedYear, updatedTeachers);

      } else if (createUserFormData.role === 'admin') {
        const newAdmin = {
          ...baseUser,
          uniqueCode: EducationCodeGenerator.generateAdminCode(),
          role: 'admin',
          displayName: createUserFormData.name.trim(),
          activeCourses: [],
          password: password
        };

        const administrators = JSON.parse(localStorage.getItem('smart-student-administrators') || '[]');
        const updatedAdministrators = [...administrators, newAdmin];
        localStorage.setItem('smart-student-administrators', JSON.stringify(updatedAdministrators));
      } else if (createUserFormData.role === 'guardian') {
        const studentIds = ((createUserFormData as any).studentIds || []) as string[];
        const relationship = (((createUserFormData as any).relationship || 'tutor') as any);
        const phone = String((createUserFormData as any).phone || '');

        const newGuardian = {
          ...baseUser,
          uniqueCode: EducationCodeGenerator.generateGuardianCode(),
          role: 'guardian',
          phone,
          studentIds: [...studentIds],
          relationship
        };

        const guardians = LocalStorageManager.getGuardiansForYear(selectedYear);
        LocalStorageManager.setGuardiansForYear(selectedYear, [...guardians, newGuardian]);

        // Crear relaciones apoderado-estudiante
        const existingRelations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear) || [];
        const newRelations = studentIds.map((studentId, index) => ({
          id: `gsr-${newGuardian.id}-${studentId}-${Date.now()}`,
          guardianId: newGuardian.id,
          studentId,
          relationship,
          isPrimary: index === 0,
          createdAt: new Date()
        }));
        LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, [...existingRelations, ...newRelations]);

        try { window.dispatchEvent(new CustomEvent('guardiansUpdated', { detail: { year: selectedYear, action: 'create' } })); } catch {}
      }

      // Save to main users array
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      console.log('🔍 [USUARIO DEBUG] Usuarios antes de agregar:', allUsers.length);
      
      // Preparar datos específicos según el rol
      let courseNames: string[] = [];
      let additionalData: any = {};
      
      if (createUserFormData.role === 'student' && createUserFormData.courseId) {
  const course = LocalStorageManager.getCoursesForYear(selectedYear).find((c: any) => c.id === createUserFormData.courseId);
        courseNames = course ? [course.name] : ['4to Básico'];
        // Agregar datos específicos para estudiantes
        additionalData.assignedTeachers = {
          'Matemáticas': 'jorge',
          'Ciencias Naturales': 'carlos',
          'Lenguaje y Comunicación': 'jorge',
          'Historia, Geografía y Ciencias Sociales': 'carlos'
        };
      } else if (createUserFormData.role === 'student') {
        // ✅ FALLBACK: Si es estudiante pero no tiene courseId, asignar curso por defecto
        courseNames = ['4to Básico'];
        additionalData.assignedTeachers = {
          'Matemáticas': 'jorge',
          'Ciencias Naturales': 'carlos',
          'Lenguaje y Comunicación': 'jorge',
          'Historia, Geografía y Ciencias Sociales': 'carlos'
        };
      } else if (createUserFormData.role === 'teacher' && createUserFormData.selectedSubjects) {
        // Para profesores, asignar cursos básicos por defecto
        courseNames = ['4to Básico'];
        additionalData.teachingAssignments = createUserFormData.selectedSubjects.map((subjectId: string) => {
          const subject = LocalStorageManager.getSubjectsForYear(selectedYear).find((s: any) => s.id === subjectId);
          return {
            teacherUsername: username,
            teacherName: createUserFormData.name.trim(),
            subject: subject?.name || 'Materia desconocida',
            courses: ['4to Básico']
          };
        });
      } else if (createUserFormData.role === 'teacher') {
        // ✅ FALLBACK: Si es profesor pero no tiene materias, asignar configuración básica
        courseNames = ['4to Básico'];
        additionalData.teachingAssignments = [{
          teacherUsername: username,
          teacherName: createUserFormData.name.trim(),
          subject: 'Matemáticas',
          courses: ['4to Básico']
        }];
      } else if (createUserFormData.role === 'admin') {
        // ✅ Los administradores no necesitan cursos específicos pero sí el array vacío
        courseNames = [];
      } else if (createUserFormData.role === 'guardian') {
        // Para apoderados, derivar cursos desde los estudiantes (si existen), si no dejar vacío
        try {
          const students = LocalStorageManager.getStudentsForYear(selectedYear) || [];
          const ids = (((createUserFormData as any).studentIds || []) as string[]);
          const courseIdSet = new Set<string>();
          for (const sid of ids) {
            const st = students.find((s: any) => s && s.id === sid);
            if (st?.courseId) courseIdSet.add(st.courseId);
          }
          const courses = LocalStorageManager.getCoursesForYear(selectedYear) || [];
          courseNames = Array.from(courseIdSet)
            .map((cid) => courses.find((c: any) => c.id === cid)?.name)
            .filter(Boolean) as string[];
        } catch {
          courseNames = [];
        }
      }
      
      // ✅ GARANTIZAR que siempre tengamos todos los campos mínimos necesarios
      const newUserForMain = {
        ...baseUser,
        activeCourses: courseNames, // ✅ Siempre definido como array
        ...additionalData
      };
      
      // ✅ VALIDACIÓN ADICIONAL: Verificar que tenga todos los campos requeridos
      const requiredFields = ['id', 'username', 'role', 'displayName', 'activeCourses', 'password'];
      const missingFields = requiredFields.filter(field => 
        newUserForMain[field] === undefined || newUserForMain[field] === null ||
        (field === 'activeCourses' && !Array.isArray(newUserForMain[field]))
      );
      
      if (missingFields.length > 0) {
        console.error('❌ [USUARIO DEBUG] Campos faltantes:', missingFields);
        toast({
          title: translate('error') || 'Error',
          description: `Error en creación: faltan campos ${missingFields.join(', ')}`,
          variant: 'destructive'
        });
        return;
      }
      
      console.log('🔍 [USUARIO DEBUG] Usuario a agregar:', newUserForMain);
      
      const updatedAllUsers = [...allUsers, newUserForMain];
  safeSaveSmartStudentUsers(updatedAllUsers, 'createUser');
      
      // Disparar eventos de sincronización global
      try {
        window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'create', userType: createUserFormData.role, source: 'admin-config' } }));
        if (createUserFormData.role === 'student') {
          window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'create' } }));
        }
      } catch {}

      console.log('✅ [USUARIO DEBUG] Usuario guardado en smart-student-users');
      console.log('📊 [USUARIO DEBUG] Total usuarios ahora:', updatedAllUsers.length);

      // Show success message with credentials if auto-generated
      if (createUserFormData.autoGenerate) {
        toast({
          title: translate('success') || 'Éxito',
          description: `${translate('userManagementUserCreated') || 'Usuario creado exitosamente'}. ${translate('userManagementCredentials') || 'Credenciales'}: ${username} / ${password}`,
          duration: 8000
        });
      } else {
        toast({
          title: translate('success') || 'Éxito',
          description: translate('userManagementUserCreated') || 'Usuario creado exitosamente',
        });
      }

      // Reset form and close modal
      resetCreateUserForm();
      setShowCreateUserDialog(false);

      // Refresh the user list to show the new user
      setRefreshUsers(prev => prev + 1);

      toast({
        title: translate('userManagementSuccess') || 'Éxito',
        description: `${
          createUserFormData.role === 'student' ? translate('userManagementStudent') || 'Estudiante' : 
          createUserFormData.role === 'teacher' ? translate('userManagementTeacher') || 'Profesor' : 
          createUserFormData.role === 'guardian' ? (translate('userManagementGuardian') || 'Apoderado') :
          translate('userManagementAdministrador') || 'Administrador'
        } ${translate('userManagementCreatedSuccessfully') || 'creado exitosamente'}`,
        variant: 'default'
      });
    } catch (error) {
      toast({
        title: translate('error') || 'Error',
        description: translate('userManagementCreateUserError') || 'Error al crear el usuario',
        variant: 'destructive'
      });
    }
  };

  const resetCreateUserForm = () => {
    setCreateUserFormData({
      name: '',
      email: '',
      rut: '',
      role: 'student',
      username: '',
      password: '',
      confirmPassword: '',
      autoGenerate: true,
      courseId: '',
      section: '',
      subject: '',
      selectedSubjects: [],
      phone: '',
      studentIds: [],
      relationship: 'tutor'
    });
  };

  // Function to get role badge colors
  const getRoleColor = (role: string) => {
    switch (role) {
  case 'admin': return 'bg-red-100 text-red-800 border border-red-300 dark:bg-red-900 dark:text-red-100 dark:border-red-700';
  case 'teacher': return 'bg-blue-100 text-blue-800 border border-blue-300 dark:bg-blue-900 dark:text-blue-100 dark:border-blue-700';
  case 'student': return 'bg-green-100 text-green-800 border border-green-300 dark:bg-green-900 dark:text-green-100 dark:border-green-700';
  case 'guardian': return 'bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-900 dark:text-purple-100 dark:border-purple-700';
  default: return 'bg-gray-100 text-gray-800 border border-gray-300 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700';
    }
  };

  // Function to get role icons
  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'admin': return <Crown className="w-3 h-3 mr-1" />;
      case 'teacher': return <Shield className="w-3 h-3 mr-1" />;
      case 'student': return <GraduationCap className="w-3 h-3 mr-1" />;
      case 'guardian': return <Users className="w-3 h-3 mr-1" />;
      default: return null;
    }
  };

  const stats = systemStats;

  return (
    <div className="space-y-6">
      {/* Modal Progreso Importación Calificaciones */}
      <Dialog open={showGradesProgress} onOpenChange={(o) => { if (!o) setShowGradesProgress(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Importación de Calificaciones</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground flex justify-between"><span>Fase:</span><span>{gradesProgress.phase}</span></div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span>{gradesProgress.current}/{gradesProgress.total}</span>
                <span>Creados: {gradesProgress.created} Err: {gradesProgress.errors}</span>
              </div>
              <Progress value={gradesProgress.total ? (gradesProgress.current / gradesProgress.total) * 100 : 0} />
            </div>
            <div className="flex gap-2 justify-end">
              {gradesProgress.phase === 'Procesando' && (
                <Button variant="destructive" size="sm" onClick={() => { gradesImportCancelRef.current = true; setGradesProgress(p => ({ ...p, phase: 'Cancelando...' })); }}>Cancelar</Button>
              )}
              {(gradesProgress.phase === 'Completado' || gradesProgress.phase === 'Cancelado' || gradesProgress.phase === 'Error') && (
                <Button size="sm" onClick={() => setShowGradesProgress(false)}>Cerrar</Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center">
            <SettingsIcon className="w-6 h-6 mr-2 text-blue-500" />
            {translate('configSystemTitle') || 'Configuración del Sistema'}
          </h2>
          <p className="text-muted-foreground">
            {translate('configSystemSubtitle') || 'Administra la configuración y mantén el sistema'}
          </p>
        </div>
        {/* Año */}
        <div className="flex items-center gap-2">
          <Label className="text-xs opacity-80">{translate('calendarYear') || 'Año'}</Label>
          <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableYears.map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-900/40"
            onClick={() => setShowNewYearDialog(true)}
          >
            {t('newYear','Nuevo Año')}
          </Button>
        </div>
      </div>

      {/* System Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <Users className="w-4 h-4 mr-2" />
              {translate('configTotalUsersTitle') || 'Usuarios Totales'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalUsers}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {stats.students} {translate('configStudentsTeachersText')?.replace('{{teachers}}', String(stats.teachers)) || `estudiantes, ${stats.teachers} profesores`}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <Database className="w-4 h-4 mr-2" />
              {translate('configAcademicStructureTitle') || 'Estructura Académica'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.courses}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {translate('configSectionsSubjectsText')?.replace('{{sections}}', String(stats.sections)).replace('{{subjects}}', String(stats.subjects)) || `${stats.sections} secciones, ${stats.subjects} asignaturas`}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <CheckCircle className="w-4 h-4 mr-2" />
              {translate('configAssignmentsTitle') || 'Asignaciones'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.assignments}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {translate('configAssignedText')?.replace('{{students}}', String(stats.assignedStudents)).replace('{{teachers}}', String(stats.assignedTeachers)) || `${stats.assignedStudents} est. asignados, ${stats.assignedTeachers} prof. asignados`}
            </div>
          </CardContent>
        </Card>

        {/* Nueva tarjeta: Asistencia % (filtrada por año) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <CheckCircle className="w-4 h-4 mr-2" />
              {translate('configAttendanceTitle') || 'Asistencia %'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(stats.attendancePercent ?? 0)}%</div>
            <div className="text-xs text-muted-foreground mt-1">
              {(stats.attendancePresent ?? 0).toLocaleString()} / {(stats.attendanceTotal ?? 0).toLocaleString()} ({translate('configAttendancePresentTotal') || 'presentes / total registros'})
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Botón temporal de debug para asistencia */}
      <div className="mb-4">
        <Button 
          onClick={() => {
            console.log('=== RECALCULANDO ESTADÍSTICAS ===');
            setSystemStats(getSystemStatistics());
          }}
          variant="outline"
          size="sm"
        >
          🔍 Debug Asistencia (Temporal)
        </Button>
      </div>

      {/* System Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <SettingsIcon className="w-5 h-5 mr-2" />
            {translate('configGeneralTitle') || 'Configuración General'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* User Management Settings */}
            <div className="space-y-4">
              <h4 className="font-medium">{translate('configUserManagementTitle') || 'Gestión de Usuarios'}</h4>
              
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <Label htmlFor="autoGenerateUsernames" className="text-sm font-medium">
                    {translate('configAutoGenerateUsernamesLabel') || 'Generar usuarios automáticamente'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {translate('configAutoGenerateUsernamesDesc') || 'Crear nombres de usuario basados en el nombre completo'}
                  </p>
                </div>
                <Switch
                  id="autoGenerateUsernames"
                  checked={config.autoGenerateUsernames}
                  onCheckedChange={(checked) => 
                    setConfig(prev => ({ ...prev, autoGenerateUsernames: checked }))
                  }
                  className="data-[state=checked]:bg-blue-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
                />
              </div>

              <div>
                <Label htmlFor="defaultPasswordLength">{translate('configDefaultPasswordLengthLabel') || 'Longitud de contraseña por defecto'}</Label>
                <Input
                  id="defaultPasswordLength"
                  type="number"
                  min="6"
                  max="20"
                  value={config.defaultPasswordLength}
                  onChange={(e) => 
                    setConfig(prev => ({ 
                      ...prev, 
                      defaultPasswordLength: parseInt(e.target.value) || 8 
                    }))
                  }
                  className="w-20"
                />
              </div>
            </div>

            {/* Academic Settings */}
            <div className="space-y-4">
              <h4 className="font-medium">{translate('configAcademicTitle') || 'Configuración Académica'}</h4>
              
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <Label htmlFor="allowMultipleTeachers" className="text-sm font-medium">
                    {translate('configMultipleTeachersLabel') || 'Múltiples profesores por asignatura'}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {translate('configMultipleTeachersDesc') || 'Permitir varios profesores en la misma asignatura'}
                  </p>
                </div>
                <Switch
                  id="allowMultipleTeachers"
                  checked={config.allowMultipleTeachersPerSubject}
                  onCheckedChange={(checked) => 
                    setConfig(prev => ({ ...prev, allowMultipleTeachersPerSubject: checked }))
                  }
                  className="data-[state=checked]:bg-blue-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
                />
              </div>

              <div>
                <Label htmlFor="maxStudentsPerSection">{translate('configMaxStudentsLabel') || 'Máximo estudiantes por sección'}</Label>
                <Input
                  id="maxStudentsPerSection"
                  type="number"
                  min="10"
                  max="50"
                  value={config.maxStudentsPerSection}
                  onChange={(e) => 
                    setConfig(prev => ({ 
                      ...prev, 
                      maxStudentsPerSection: parseInt(e.target.value) || 45 
                    }))
                  }
                  className="w-20"
                />
              </div>
            </div>
          </div>

          {/* Escala de calificaciones */}
          <div className="space-y-3 p-3 border rounded-lg">
            <h4 className="font-medium">{t('gradingScaleTitle','Escala de calificaciones')}</h4>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
              <div className="md:col-span-1">
                <Label>{t('gradingMode','Modo')}</Label>
                <Select
                  value={(config.grading?.mode) || 'percent'}
                  onValueChange={(v) => setConfig(prev => ({
                    ...prev,
                    grading: {
                      mode: (v as any),
                      min: prev.grading?.min ?? (v === 'percent' ? 0 : 1),
                      max: prev.grading?.max ?? (v === 'percent' ? 100 : 7),
                      passPercent: prev.grading?.passPercent ?? 60,
                      label: prev.grading?.label ?? (v === 'percent' ? '%' : undefined)
                    }
                  }))}
                >
                  <SelectTrigger><SelectValue placeholder={t('gradingMode','Modo')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent">{t('gradingModePercent','Porcentaje (0–100)')}</SelectItem>
                    <SelectItem value="numeric">{t('gradingModeNumeric','Numérica (p.ej. 1–7, 1–10)')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t('gradingMin','Mínimo')}</Label>
                <Input
                  type="number"
                  value={config.grading?.min ?? (config.grading?.mode === 'numeric' ? 1 : 0)}
                  onChange={(e)=> setConfig(prev => ({...prev, grading: { ...(prev.grading||{ mode: 'percent', min: 0, max: 100 }), min: Number(e.target.value) }}))}
                />
              </div>
              <div>
                <Label>{t('gradingMax','Máximo')}</Label>
                <Input
                  type="number"
                  value={config.grading?.max ?? (config.grading?.mode === 'numeric' ? 7 : 100)}
                  onChange={(e)=> setConfig(prev => ({...prev, grading: { ...(prev.grading||{ mode: 'percent', min: 0, max: 100 }), max: Number(e.target.value) }}))}
                />
              </div>
              <div>
                <Label>{t('gradingPassThreshold','Umbral Aprobación (%)')}</Label>
                <Input
                  type="number"
                  min={0} max={100}
                  value={config.grading?.passPercent ?? 60}
                  onChange={(e)=> setConfig(prev => ({...prev, grading: { ...(prev.grading||{ mode: 'percent', min: 0, max: 100 }), passPercent: Number(e.target.value) }}))}
                />
              </div>
              <div>
                <Label>{t('gradingLabel','Etiqueta')}</Label>
                <Input
                  placeholder={config.grading?.mode === 'percent' ? '%' : `${config.grading?.min ?? ''}–${config.grading?.max ?? ''}`}
                  value={config.grading?.label ?? ''}
                  onChange={(e)=> setConfig(prev => ({...prev, grading: { ...(prev.grading||{ mode: 'percent', min: 0, max: 100 }), label: e.target.value }}))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('gradingScaleNote','Esta escala afecta tareas, evaluaciones y gráficos. Los datos se normalizan internamente a porcentaje para cálculos.')}</p>
          </div>

          <div className="pt-4 border-t">
            <Button 
              onClick={saveConfiguration}
              disabled={isLoading}
              className="w-full sm:w-auto bg-blue-600 hover:bg-blue-500 text-white"
            >
              <SettingsIcon className="w-4 h-4 mr-2" />
              {translate('configSaveButton') || 'Guardar Configuración'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Data Management */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Database className="w-5 h-5 mr-2" />
            {translate('configDataManagementTitle') || 'Gestión de Datos'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Export Data */}
            <div className="p-4 border border-blue-200 rounded-lg">
              <h4 className="font-medium mb-2 flex items-center text-blue-600">
                <Download className="w-4 h-4 mr-2 text-blue-500" />
                {translate('configExportDataTitle') || 'Exportar Datos'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3">
                {translate('configExportDataDesc') || 'Descarga una copia de seguridad con asignaciones incluidas'}
              </p>
              <Button 
                onClick={exportSystemData}
                variant="outline" 
                className="w-full border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
              >
                <Download className="w-4 h-4 mr-2" />
                {translate('configExportButton') || 'Exportar'}
              </Button>
              {/* Modal de progreso para Exportar */}
              <GradesImportProgress
                open={showExportModal}
                progress={exportProgress as any}
                onClose={() => setShowExportModal(false)}
                title={t('exportProgressTitle','🧩 Exportando datos del sistema')}
              />
            </div>

            {/* (Eliminado: diálogo duplicado de progreso de asistencia) */}

            {/* Import Data */}
            <div className="p-4 border border-green-200 rounded-lg">
              <h4 className="font-medium mb-2 flex items-center text-green-600">
                <Upload className="w-4 h-4 mr-2 text-green-500" />
                {translate('configImportDataTitle') || 'Importar Datos'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3">
                {translate('configImportDataDesc') || 'Restaura datos con aplicación automática de asignaciones'}
              </p>
              <div>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleImportData}
                  className="hidden"
                  id="import-file"
                />
                <Button 
                  onClick={() => document.getElementById('import-file')?.click()}
                  variant="outline" 
                  className="w-full border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800 dark:border-green-500 dark:text-green-300 dark:hover:bg-green-900/40 dark:hover:text-green-200"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {translate('configImportButton') || 'Importar'}
                </Button>
                {/* Modal de progreso para Importar */}
                <GradesImportProgress
                  open={showImportModal}
                  progress={importProgress as any}
                  onClose={() => setShowImportModal(false)}
                  title={t('importProgressTitle','📥 Importando datos del sistema')}
                />
              </div>
            </div>


            {/* ✅ NUEVA FUNCIONALIDAD: Validar Asignaciones */}
            <div className="p-4 border border-yellow-200 rounded-lg">
              <h4 className="font-medium mb-2 flex items-center text-yellow-600">
                <CheckCircle className="w-4 h-4 mr-2" />
                {translate('configValidateSystemTitle') || 'Validate System'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3">
                {translate('configValidateSystemDesc') || 'Check the status of student-section assignments'}
              </p>
              <Button 
                onClick={() => {
                  console.log('🔍 [VALIDACIÓN MANUAL] Iniciando validación desde interfaz admin...');
                  if (typeof window.validarAsignacionesManualmente === 'function') {
                    const resultado = window.validarAsignacionesManualmente();
                    if (resultado.esValido) {
                      toast({
                        title: translate('configSystemValidTitle') || 'System valid',
                        description: translate('configSystemValidDesc') || 'All validations passed successfully',
                        variant: 'default'
                      });
                    } else {
                      toast({
                        title: translate('configProblemsDetectedTitle') || 'Problems detected',
                        description: `${translate('configProblemsDetectedDesc') || 'Problems found in the system'}: ${resultado.problemas.length}`,
                        variant: 'destructive'
                      });
                    }
                  } else if (typeof window.validarDesdeAdmin === 'function') {
                    window.validarDesdeAdmin();
                  } else {
                    toast({
                      title: translate('configFunctionUnavailableTitle') || 'Function not available',
                      description: translate('configValidationNotLoadedDesc') || 'Validation system not loaded. Refresh the page.',
                      variant: 'destructive'
                    });
                  }
                }}
                variant="outline" 
                className="w-full border-yellow-300 text-yellow-700 hover:bg-yellow-50 hover:text-yellow-800 dark:border-yellow-500 dark:text-yellow-300 dark:hover:bg-yellow-900/30 dark:hover:text-yellow-200"
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                {translate('configValidateButton') || 'Validate'}
              </Button>
            </div>

            {/* ✅ NUEVA FUNCIONALIDAD: Auto-Corregir */}
            <div className="p-4 border border-green-200 rounded-lg">
              <h4 className="font-medium mb-2 flex items-center text-green-600">
                <RefreshCw className="w-4 h-4 mr-2" />
                {translate('configAutoFixTitle') || 'Auto-Correct'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3">
                {translate('configAutoFixDesc') || 'Apply dynamic assignment correction automatically'}
              </p>
              <Button 
                onClick={() => {
                  console.log('🔄 [AUTO-CORRECCIÓN] Iniciando corrección desde interfaz admin...');
                  if (typeof window.regenerarAsignacionesDinamicas === 'function') {
                    const resultado = window.regenerarAsignacionesDinamicas();
                    if (resultado.exito) {
                      toast({
                        title: translate('configAutoFixSuccessTitle') || 'Auto-correction applied',
                        description: `${resultado.asignacionesCreadas} ${translate('configAutoFixSuccessDesc') || 'assignments corrected automatically'}`,
                        variant: 'default'
                      });
                      setTimeout(() => {
                        setRefreshUsers(prev => prev + 1);
                      }, 1000);
                    } else {
                      toast({
                        title: translate('configAutoFixErrorTitle') || 'Auto-correction error',
                        description: translate('configAutoFixErrorDesc') || 'Auto-correction could not be completed',
                        variant: 'destructive'
                      });
                    }
                  } else if (typeof window.aplicarCorreccionAutomatica === 'function') {
                    window.aplicarCorreccionAutomatica();
                  } else {
                    toast({
                      title: translate('configFunctionUnavailableTitle') || 'Function not available',
                      description: translate('configAutoFixNotLoadedDesc') || 'Auto-correction system not loaded. Refresh the page.',
                      variant: 'destructive'
                    });
                  }
                }}
                variant="outline" 
                className="w-full border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800 dark:border-green-500 dark:text-green-300 dark:hover:bg-green-900/40 dark:hover:text-green-200"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {translate('configAutoFixButton') || 'Fix'}
              </Button>
            </div>

            {/* (Sección de Reasignar Estudiantes eliminada) */}
            {/* Cierre primera fila */}
          </div>

          {/* Segunda fila: Carga masiva + Reiniciar (3 columnas) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">

            {/* Carga masiva por Excel */}
            <div className="p-4 border border-purple-200 rounded-lg flex flex-col">
              <h4 className="font-medium mb-2 flex items-center">
                <Upload className="w-4 h-4 mr-2 text-purple-500" />
                {translate('configBulkExcelTitle') || 'Bulk upload by Excel'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3 text-justify">
                {translate('configBulkExcelDesc') || 'Download the template, fill in the users and upload it to create students, teachers, and administrators with basic assignments. If the "subjects" field is empty for a student, they will be enabled for all subjects in the course. For teachers, use subject abbreviations (e.g., MAT, LEN, HIST).'}
              </p>
              {/* Pasos sugeridos para evitar errores en la carga */}
              <ol className="text-sm list-decimal ml-5 mb-3 text-muted-foreground">
                <li>{translate('configBulkExcelStep1') || 'Create courses'}</li>
                <li>{translate('configBulkExcelStep2') || 'Create sections'}</li>
                <li>{translate('configBulkExcelStep3') || 'Then upload the information with the Excel'}</li>
              </ol>
              {/* input oculto fuera para permitir flex-1 en ambos botones */}
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  console.log('📂 [INPUT] onChange triggered');
                  handleBulkUsersExcelUpload(e);
                }}
                className="hidden"
                id="excel-file"
              />
              <div className="flex flex-col sm:flex-row gap-2 mt-auto">
                <Button 
                  onClick={downloadUsersExcelTemplate}
                  variant="outline"
                  disabled={isExcelProcessing}
                  className="flex-1 border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
                >
                  <Download className="w-4 h-4 mr-2" />
                  {translate('configBulkExcelDownloadTpl') || 'Download template'}
                </Button>
                <Button 
                  onClick={() => {
                    console.log('🖱️ [BUTTON] Click en Upload Excel');
                    const input = document.getElementById('excel-file') as HTMLInputElement;
                    console.log('🎯 [INPUT] Input encontrado:', !!input);
                    if (input) {
                      input.value = ''; // Limpiar para permitir resubir el mismo archivo
                      input.click();
                      console.log('✅ [INPUT] Click ejecutado en input');
                    }
                  }}
                  variant="outline"
                  disabled={isExcelProcessing}
                  className="flex-1 border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {isExcelProcessing ? (translate('processing') || 'Processing...') : (translate('configBulkExcelUpload') || 'Upload Excel')}
                </Button>
              </div>

            </div>

            {/* Carga masiva de asignaciones de profesores */}
            <div className="p-4 border border-indigo-200 rounded-lg flex flex-col">
              <h4 className="font-medium mb-2 flex items-center">
                <Upload className="w-4 h-4 mr-2 text-indigo-500" />
                {translate('configBulkTeacherAssignmentsTitle') || 'Bulk upload: Teacher Assignments'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3 text-justify">
                {translate('configBulkTeacherAssignmentsDesc') || 'Upload an Excel to assign teachers to courses/sections and subjects. If you leave “section” empty, it will apply to all sections in the course.'}
              </p>
              <ol className="text-sm list-decimal ml-5 mb-3 text-muted-foreground">
                <li>{translate('configBulkTeacherAssignmentsStep1') || 'Make sure courses and sections are created'}</li>
                <li>{translate('configBulkTeacherAssignmentsStep2') || 'Teachers must exist in the system'}</li>
                <li>{translate('configBulkTeacherAssignmentsStep3') || 'Use subject abbreviations (e.g., MAT, LEN) or full names'}</li>
              </ol>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={handleBulkTeacherAssignmentsUpload}
                className="hidden"
                id="excel-teacher-assignments-file"
              />
        <div className="flex flex-col sm:flex-row gap-2 mt-auto">
                <Button 
                  onClick={downloadTeacherAssignmentsTemplate}
                  variant="outline"
                  className="flex-1 border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
                >
                  <Download className="w-4 h-4 mr-2" />
                  {translate('configBulkTeacherAssignmentsDownloadTpl') || 'Download template'}
                </Button>
                <Button 
                  onClick={() => document.getElementById('excel-teacher-assignments-file')?.click()}
                  variant="outline"
                  className="flex-1 border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {translate('configBulkTeacherAssignmentsUpload') || 'Upload Excel of assignments'}
                </Button>
              </div>
            </div>

            {/* Reset System */}
            <div className="p-4 border-2 border-red-400 dark:border-red-600 rounded-lg flex flex-col bg-red-50/30 dark:bg-red-950/30">
              <h4 className="font-medium mb-2 flex items-center text-red-700 dark:text-red-300">
                <AlertTriangle className="w-4 h-4 mr-2" />
                {translate('resetSystemTitle')}
              </h4>
              <p className="text-sm text-red-700 dark:text-red-300 mb-3 text-justify font-medium">
                ⚠️ {translate('resetSystemDesc')}
              </p>
              
              <div className="bg-red-100 dark:bg-red-950 border border-red-300 dark:border-red-700 rounded-md p-2 mb-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3 h-3 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-red-800 dark:text-red-200 mb-1">
                      {translate('resetSystemWarningTitle')}
                    </p>
                    <ul className="text-xs text-red-700 dark:text-red-300 space-y-0.5 list-disc list-inside">
                      <li>{translate('resetSystemItem1')}</li>
                      <li>{translate('resetSystemItem2')}</li>
                      <li>{translate('resetSystemItem3')}</li>
                      <li>{translate('resetSystemItem4')}</li>
                      <li>{translate('resetSystemItem5')}</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="mt-auto">
                <Button
                  onClick={() => setShowResetConfirmDialog(true)}
                  disabled={isResettingSystem}
                  variant="destructive"
                  className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold"
                >
                  <AlertTriangle className="w-4 h-4 mr-2" />
                  {isResettingSystem ? `${translate('resetSystemButton')}...` : translate('resetSystemButton')}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security Tools */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Shield className="w-5 h-5 mr-2" />
            {translate('configSecurityToolsTitle') || 'Herramientas de Seguridad'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Regenerate Passwords */}
            <div className="p-4 border rounded-lg flex flex-col flex-1">
              <h4 className="font-medium mb-2 flex items-center">
                <Key className="w-4 h-4 mr-2 text-orange-500" />
                {translate('configRegeneratePasswordsTitle') || 'Regenerar Contraseñas'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3">
                {translate('configRegeneratePasswordsDesc') || 'Genera nuevas contraseñas para todos los usuarios del sistema'}
              </p>
              <Button 
                onClick={regeneratePasswords}
                disabled={isLoading}
                variant="outline" 
                className="mt-auto w-full border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {translate('configRegenerateAllButton') || 'Regenerar Todas'}
              </Button>
            </div>

            {/* ✅ NUEVO: Reparar Usuarios */}
            <div className="p-4 border rounded-lg flex flex-col flex-1">
              <h4 className="font-medium mb-2 flex items-center">
                <Shield className="w-4 h-4 mr-2 text-blue-500" />
                {translate('configRepairUsersTitle') || 'Reparar Usuarios'}
              </h4>
              <p className="text-sm text-muted-foreground mb-3">
                {translate('configRepairUsersDesc') || 'Corrige usuarios con campos faltantes para garantizar acceso al login'}
              </p>
              <Button 
                onClick={repairExistingUsers}
                disabled={isLoading}
                variant="outline" 
                className="mt-auto w-full border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                {translate('configRepairUsersButton') || 'Reparar Usuarios'}
              </Button>
            </div>

            {/* System Health */}
            <div className="p-4 border rounded-lg flex flex-col h-full">
              <h4 className="font-medium mb-2 flex items-center">
                <CheckCircle className="w-4 h-4 mr-2 text-green-500" />
                {translate('configSystemStatusTitle') || 'Estado del Sistema'}
              </h4>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{translate('configDataIntegrityLabel') || 'Integridad de datos:'}</span>
                  <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-900 dark:text-emerald-200 dark:border-emerald-700">OK</Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>{translate('configValidAssignmentsLabel') || 'Asignaciones válidas:'}</span>
                  <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-900 dark:text-emerald-200 dark:border-emerald-700">OK</Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>{translate('configUniqueCodesLabel') || 'Códigos únicos:'}</span>
                  <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-900 dark:text-emerald-200 dark:border-emerald-700">OK</Badge>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

  {/* Users Management Section — moved to bottom */}

  {/* Modal de confirmación de importación (UI del proyecto) */}
      <Dialog open={showImportConfirmDialog} onOpenChange={setShowImportConfirmDialog}>
        <DialogContent
          // Evitar que desaparezca por clic fuera o Escape
          onPointerDownOutside={(e) => { try { e.preventDefault(); } catch {} }}
          onInteractOutside={(e) => { try { e.preventDefault(); } catch {} }}
          onEscapeKeyDown={(e) => { try { e.preventDefault(); } catch {} }}
          onOpenAutoFocus={(e) => {
            try {
              const el = document.getElementById('import-confirm-accept');
              if (el) { e.preventDefault(); (el as HTMLElement).focus(); }
            } catch {}
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {translate('configImportDataTitle') || 'Confirmar importación de datos'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-amber-50 dark:bg-amber-950 rounded-md text-sm">
              {translate('configImportConfirm') || '¿Estás seguro de que quieres importar estos datos? Esto sobrescribirá todos los datos existentes.'}
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setShowImportConfirmDialog(false);
                  setPendingImportData(null);
                  if (pendingImportInput) pendingImportInput.value = '';
                  setPendingImportInput(null);
                }}
              >
                {translate('configCancelButton') || 'Cancelar'}
              </Button>
              <Button
                id="import-confirm-accept"
                className="bg-green-600 hover:bg-green-700"
                onClick={() => {
                  const data = pendingImportData;
                  const inputEl = pendingImportInput;
                  setShowImportConfirmDialog(false);
                  setPendingImportData(null);
                  setPendingImportInput(null);
                  performImport(data, inputEl);
                  // limpiar input si existe
                  if (inputEl) inputEl.value = '';
                }}
              >
                {translate('configConfirmImportButton') || 'Aceptar e importar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Ventana emergente: Resultado de la última carga por Excel */}
      <Dialog open={showExcelSummaryDialog} onOpenChange={setShowExcelSummaryDialog}>
        <DialogContent
          // Mantener el foco dentro y evitar cierre accidental
          onInteractOutside={(e) => { try { e.preventDefault(); } catch {} }}
          onEscapeKeyDown={(e) => { try { e.preventDefault(); } catch {} }}
          onOpenAutoFocus={(e) => {
            try {
              const el = document.getElementById('excel-summary-close');
              if (el) { e.preventDefault(); (el as HTMLElement).focus(); }
            } catch {}
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center">
              {excelImportSummary?.errors ? (
                <AlertTriangle className="w-5 h-5 mr-2 text-orange-500" />
              ) : (
                <CheckCircle className="w-5 h-5 mr-2 text-green-600" />
              )}
              {translate('configBulkExcelLastResultTitle') || 'Last bulk upload result'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {excelImportSummary && (
              <div className="text-sm space-y-1">
                <div>{translate('configAdmins') || 'Admins'}: <span className="font-semibold">{excelImportSummary.admins}</span></div>
                <div>{translate('configTeachers') || 'Teachers'}: <span className="font-semibold">{excelImportSummary.teachers}</span></div>
                <div>{translate('configStudents') || 'Students'}: <span className="font-semibold">{excelImportSummary.students}</span></div>
                <div>{translate('configGuardians') || 'Guardians'}: <span className="font-semibold">{excelImportSummary.guardians}</span></div>
                <div>{translate('configErrors') || 'Errors'}: <span className={`font-semibold ${excelImportSummary.errors ? 'text-red-600' : ''}`}>{excelImportSummary.errors}</span></div>
              </div>
            )}
            {excelImportSummary?.errors && excelImportSummary?.errorMessages?.length ? (
              <div className="text-xs">
                <div className="font-medium mb-1">{translate('configErrorDetails') || 'Error details:'}</div>
                <ul className="list-disc list-inside space-y-1 max-h-64 overflow-auto pr-2">
                  {excelImportSummary.errorMessages.map((msg, idx) => (
                    <li key={`excel-error-dialog-${idx}`} className="text-red-700 dark:text-red-300">
                      {msg}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                variant="outline"
                className="border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
                id="excel-summary-close"
                onClick={() => setShowExcelSummaryDialog(false)}
              >
                {translate('close') || 'Close'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Diálogo: Crear Nuevo Año (reutilizable) */}
      <NewYearDialog
        open={showNewYearDialog}
        onOpenChange={setShowNewYearDialog}
        selectedYear={selectedYear}
        t={(key: string, fb?: string) => t(key, fb)}
        onCreated={(targetYear) => {
          try {
            setAvailableYears(LocalStorageManager.listYears());
            setSelectedYear(targetYear);
            toast({ title: t('yearCreated','Año creado'), description: String(targetYear) });
          } catch (e) {
            toast({ title: t('error','Error'), description: t('couldNotCreateYear','No se pudo crear el año'), variant: 'destructive' });
          }
        }}
      />

  {/* Dialogo de confirmación: Borrar Calificaciones (antes Actividades) */}
  <Dialog open={showConfirmDeleteActivities} onOpenChange={setShowConfirmDeleteActivities}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('confirmDeleteActivitiesTitle','Borrar Calificaciones')}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">{t('confirmDeleteActivitiesDesc', 'Se eliminarán todas las calificaciones (tareas y evaluaciones) del año seleccionado. Esta acción no se puede deshacer.')}</p>
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="outline" onClick={() => setShowConfirmDeleteActivities(false)} className="border-border text-foreground hover:bg-muted/40 dark:hover:bg-muted/30 hover:text-foreground focus-visible:ring-0 focus-visible:outline-none">
          {t('cancel','Cancelar')}
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            try {
              localStorage.removeItem('smart-student-tasks');
              localStorage.removeItem('smart-student-evaluations');
              try { LocalStorageManager.clearTestGradesForYear(selectedYear); } catch {}
              try {
                const key = LocalStorageManager.keyForTestGrades(selectedYear);
                window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify([]) }));
              } catch {}
              toast({ title: t('deleted','Eliminado'), description: t('activitiesDeleted','Calificaciones eliminadas del año seleccionado.') });
            } catch (e) {
              toast({ title: t('error','Error'), description: t('couldNotDelete','No se pudieron borrar los datos'), variant: 'destructive' });
            } finally {
              setShowConfirmDeleteActivities(false);
            }
          }}
        >
          {t('delete','Eliminar')}
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  {/* Dialogo de confirmación: Borrar Asistencia SQL (año seleccionado) */}
  <Dialog open={showConfirmDeleteAttendanceSQL} onOpenChange={setShowConfirmDeleteAttendanceSQL}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('confirmDeleteAttendanceSQLTitle','Borrar Asistencia en SQL')}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {t('confirmDeleteAttendanceSQLDesc','Se eliminarán de la base de datos SQL todos los registros de asistencia del año seleccionado. Esta acción no se puede deshacer.')}
      </p>
      <div className="flex justify-end gap-2 mt-2">
        <Button
          variant="outline"
          onClick={() => setShowConfirmDeleteAttendanceSQL(false)}
          className="border-border text-foreground hover:bg-muted/40 dark:hover:bg-muted/30 hover:text-foreground focus-visible:ring-0 focus-visible:outline-none"
        >
          {t('cancel','Cancelar')}
        </Button>
        <Button
          variant="destructive"
          onClick={async () => {
            try {
              setShowConfirmDeleteAttendanceSQL(false);
              setShowAttendanceDeleteSQLProgress(true);
              const result = await deleteAttendanceSQLByYear(selectedYear);
              if (result) {
                await countAttendanceByYear(selectedYear);
                await countAllAttendance();
                toast({ title: t('deleted','Eliminado'), description: t('sqlAttendanceDeleted','Asistencia SQL eliminada del año seleccionado.') });
              }
            } catch (e) {
              toast({ title: t('error','Error'), description: t('couldNotDelete','No se pudieron borrar los registros de asistencia SQL'), variant: 'destructive' });
            } finally {
              setTimeout(() => setShowAttendanceDeleteSQLProgress(false), 1200);
            }
          }}
        >
          {t('delete','Eliminar')}
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  {/* Dialogo de confirmación: Borrar Asistencia */}
  <Dialog open={showConfirmDeleteAttendance} onOpenChange={setShowConfirmDeleteAttendance}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('confirmDeleteAttendanceTitle','Borrar Asistencia')}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">{t('confirmDeleteAttendanceDesc','Se eliminará la asistencia del año seleccionado. Esta acción no se puede deshacer.')}</p>
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="outline" onClick={() => setShowConfirmDeleteAttendance(false)} className="border-border text-foreground hover:bg-muted/40 dark:hover:bg-muted/30 hover:text-foreground focus-visible:ring-0 focus-visible:outline-none">
          {t('cancel','Cancelar')}
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            try {
              LocalStorageManager.clearAttendanceForYear(selectedYear);
              try { window.dispatchEvent(new CustomEvent('attendanceChanged', { detail: { action: 'clear', year: selectedYear } })); } catch {}
              toast({ title: t('deleted','Eliminado'), description: t('attendanceDeleted','Asistencia eliminada del año seleccionado.') });
            } catch (e) {
              toast({ title: t('error','Error'), description: t('couldNotDelete','No se pudo borrar la asistencia'), variant: 'destructive' });
            } finally {
              setShowConfirmDeleteAttendance(false);
            }
          }}
        >
          {t('delete','Eliminar')}
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  {/* AlertDialog de confirmación: Borrar TODAS las calificaciones de Firebase */}
  <AlertDialog open={showConfirmDeleteAllSQL} onOpenChange={setShowConfirmDeleteAllSQL}>
    <AlertDialogContent className="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
          <AlertTriangle className="w-6 h-6" />
          Confirmar Eliminación de Calificaciones
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-3 pt-3">
            <div className="bg-red-50 dark:bg-red-950 border-2 border-red-300 dark:border-red-800 rounded-lg p-4">
              <p className="text-sm font-semibold text-red-800 dark:text-red-200 mb-2">
                Esta acción eliminará TODAS las calificaciones almacenadas en Firebase:
              </p>
              <ul className="text-sm text-red-700 dark:text-red-300 space-y-1 list-disc list-inside">
                <li><strong>TODOS los años</strong> (no solo {selectedYear})</li>
                <li>Aproximadamente <strong>{(firebaseTotalOverride ?? totalGrades ?? 0).toLocaleString()} registros</strong></li>
                <li><strong>Esta acción NO se puede deshacer</strong></li>
              </ul>
            </div>

            <p className="text-sm text-muted-foreground font-medium pt-2">
              ¿Estás seguro de que deseas eliminar todos los registros?
            </p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter className="gap-2">
        <AlertDialogCancel className="border-border text-foreground hover:bg-muted/40">
          Cancelar
        </AlertDialogCancel>
        <AlertDialogAction
          className="bg-red-600 hover:bg-red-700 text-white font-semibold"
          onClick={async () => {
            try {
              setShowConfirmDeleteAllSQL(false);
              setIsDeletingAllGrades(true); // Marcar que estamos eliminando TODO
              setShowDeleteSQLProgress(true);
              console.log('🗑️ Iniciando eliminación total de Firebase...');
              const result = await deleteAllSQLGrades();
              if (result) {
                // Actualizar contadores de Firebase
                await getFirebaseCounters(selectedYear);
                toast({ 
                  title: '✅ Eliminación Completada', 
                  description: `Todos los registros de Firebase han sido eliminados exitosamente.`,
                  variant: 'default'
                });
              } else {
                toast({ 
                  title: '⚠️ Eliminación Incompleta', 
                  description: 'No se pudieron eliminar todos los registros. Revisa los logs.',
                  variant: 'destructive'
                });
              }
            } catch (e: any) {
              console.error('❌ Error en eliminación total:', e);
              toast({ 
                title: '❌ Error', 
                description: `No se pudieron eliminar los registros: ${e?.message || 'Error desconocido'}`,
                variant: 'destructive'
              });
            } finally {
              // Actualizar contadores inmediatamente
              setTimeout(() => {
                getFirebaseCounters(selectedYear);
              }, 500);
              
              // Mantener el modal de progreso abierto un poco más para mostrar los logs
              setTimeout(() => {
                setShowDeleteSQLProgress(false);
                setIsDeletingAllGrades(false);
              }, 2000);
            }
          }}
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Sí, eliminar TODO
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  {/* Modal de confirmación para Reiniciar Sistema */}
  <AlertDialog open={showResetConfirmDialog} onOpenChange={setShowResetConfirmDialog}>
    <AlertDialogContent className="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
          <AlertTriangle className="w-6 h-6" />
          {translate('confirmResetSystemTitle')}
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-3 pt-3">
            <div className="bg-red-50 dark:bg-red-950 border-2 border-red-300 dark:border-red-800 rounded-lg p-4">
              <p className="text-sm font-semibold text-red-800 dark:text-red-200 mb-2">
                {translate('confirmResetSystemWarning')}
              </p>
              <ul className="text-sm text-red-700 dark:text-red-300 space-y-1 list-disc list-inside">
                <li><strong>{translate('confirmResetItem1')}</strong></li>
                <li><strong>{translate('confirmResetItem2')} ({selectedYear})</strong></li>
                <li><strong>{translate('confirmResetItem3')}</strong></li>
                <li><strong>{translate('confirmResetItem4')}</strong></li>
                <li><strong>{translate('confirmResetItem5')}</strong></li>
                <li><strong>{translate('confirmResetItem6')}</strong></li>
              </ul>
              <p className="text-sm font-semibold text-red-800 dark:text-red-200 mt-3">
                ✅ {translate('confirmResetAdminsPreserved')}
              </p>
            </div>

            <p className="text-sm text-muted-foreground font-medium pt-2">
              {translate('confirmResetSystemQuestion')}
            </p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter className="gap-2">
        <AlertDialogCancel className="border-border text-foreground hover:bg-muted/40" disabled={isResettingSystem}>
          {translate('cancel')}
        </AlertDialogCancel>
        <AlertDialogAction
          className="bg-red-600 hover:bg-red-700 text-white font-semibold"
          onClick={async () => {
            setShowResetConfirmDialog(false);
            await handleResetSystem();
          }}
          disabled={isResettingSystem}
        >
          <AlertTriangle className="w-4 h-4 mr-2" />
          {translate('confirmReset')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  {/* Modal de progreso para Reiniciar Sistema */}
  <Dialog open={showResetProgressModal} onOpenChange={(open) => !isResettingSystem && setShowResetProgressModal(open)}>
    <DialogContent 
      className="sm:max-w-md" 
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
      onPointerDownOutside={(e) => e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>{translate('resetSystemProgressTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground flex justify-between">
          <span>{translate('phase')}:</span>
          <span className="font-medium">{resetSystemProgress.phase}</span>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span>{resetSystemProgress.current}/{resetSystemProgress.total}</span>
            <span>{Math.round((resetSystemProgress.current / resetSystemProgress.total) * 100)}%</span>
          </div>
          <Progress value={(resetSystemProgress.current / resetSystemProgress.total) * 100} />
        </div>
        {resetSystemProgress.current === resetSystemProgress.total && (
          <div className="flex gap-2 justify-end">
            <Button size="sm" onClick={() => setShowResetProgressModal(false)}>
              {translate('close')}
            </Button>
          </div>
        )}
      </div>
    </DialogContent>
  </Dialog>

      {/* Todos los Usuarios del Sistema (ubicado al final) */}
      <UserManagementSection 
        showCreateUserDialog={showCreateUserDialog}
        setShowCreateUserDialog={setShowCreateUserDialog}
        createUserFormData={createUserFormData}
        setCreateUserFormData={setCreateUserFormData}
        handleCreateUser={handleCreateUser}
        resetCreateUserForm={resetCreateUserForm}
        getRoleColor={getRoleColor}
        getRoleIcon={getRoleIcon}
        availableCourses={availableCourses}
        availableSections={availableSections}
        availableSubjects={availableSubjects}
  refreshUsers={refreshUsers}
  selectedYear={selectedYear}
      />
    </div>
  );
}

// New component for user management
function UserManagementSection({ 
  showCreateUserDialog, 
  setShowCreateUserDialog, 
  createUserFormData, 
  setCreateUserFormData, 
  handleCreateUser, 
  resetCreateUserForm,
  getRoleColor,
  getRoleIcon,
  availableCourses,
  availableSections,
  availableSubjects,
  refreshUsers,
  selectedYear
}: {
  showCreateUserDialog: boolean;
  setShowCreateUserDialog: (value: boolean) => void;
  createUserFormData: any;
  setCreateUserFormData: (value: any) => void;
  handleCreateUser: () => Promise<void>;
  resetCreateUserForm: () => void;
  getRoleColor: (role: string) => string;
  getRoleIcon: (role: string) => React.ReactElement | null;
  availableCourses: any[];
  availableSections: any[];
  availableSubjects: any[];
  refreshUsers: number;
  selectedYear: number;
}) {
  const { toast } = useToast();
  const { translate } = useLanguage();
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [userToDelete, setUserToDelete] = useState<any>(null);

  // Datos necesarios para el formulario de apoderados (filtrado por curso/sección + texto)
  const [availableStudents, setAvailableStudents] = useState<any[]>([]);
  const [studentAssignments, setStudentAssignments] = useState<any[]>([]);


  useEffect(() => {
    loadAllUsers();
  }, [refreshUsers, selectedYear]);

  useEffect(() => {
    const load = () => {
      try {
        setAvailableStudents(LocalStorageManager.getStudentsForYear(selectedYear) || []);
      } catch {
        setAvailableStudents([]);
      }
      try {
        setStudentAssignments(LocalStorageManager.getStudentAssignmentsForYear(selectedYear) || []);
      } catch {
        setStudentAssignments([]);
      }
    };
    load();

    // Mantener sincronizado si cambian asignaciones/usuarios desde otras vistas
    const handler = () => load();
    try {
      window.addEventListener('studentAssignmentsChanged', handler as any);
      window.addEventListener('usersUpdated', handler as any);
      window.addEventListener('studentsUpdated', handler as any);
    } catch {}
    return () => {
      try {
        window.removeEventListener('studentAssignmentsChanged', handler as any);
        window.removeEventListener('usersUpdated', handler as any);
        window.removeEventListener('studentsUpdated', handler as any);
      } catch {}
    };
  }, [selectedYear, refreshUsers]);

  // Mantener sincronizado con eventos globales de cambios de usuarios
  useEffect(() => {
    const handler = () => loadAllUsers();
    try {
      window.addEventListener('usersUpdated', handler as any);
    } catch {}
    return () => {
      try { window.removeEventListener('usersUpdated', handler as any); } catch {}
    };
  }, [selectedYear]);

  useEffect(() => {
    filterUsers();
  }, [allUsers, searchTerm, filterRole]);

  const loadAllUsers = () => {
    try {
  const students = LocalStorageManager.getStudentsForYear(selectedYear);
  const teachers = LocalStorageManager.getTeachersForYear(selectedYear);
  const guardians = LocalStorageManager.getGuardiansForYear(selectedYear);
  const mainUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
  const adminsStorage = JSON.parse(localStorage.getItem('smart-student-administrators') || '[]');

  // Consolidar administradores REALES únicamente: solo desde smart-student-administrators
  const adminMap = new Map<string, any>();
  for (const a of adminsStorage) {
        if (!a) continue;
        const uname = (a.username || '').toString();
        if (!uname) continue;
        const existing = adminMap.get(uname);
        // Prefiere registro con más campos (password/displayName)
        if (!existing || (a.password && !existing.password)) {
          adminMap.set(uname, a);
        }
      }

      // Crear listado final iniciando con admins reales
      const userMap = new Map<string, any>();
      adminMap.forEach((admin, uname) => {
        userMap.set(uname, {
          id: admin.id || crypto.randomUUID(),
          username: uname,
          name: admin.displayName || admin.name || 'Administrador',
          email: admin.email || '',
          password: admin.password || 'N/A',
          type: 'admin',
          role: 'admin',
          createdAt: admin.createdAt || new Date(),
          isActive: admin.isActive !== undefined ? admin.isActive : true
        });
      });

      // Agregar estudiantes DEL AÑO SELECCIONADO
    students.forEach((student: any) => {
        if (student && student.username) {
      const mainUser = mainUsers.find((u: any) => u && u.username === student.username);
          userMap.set(student.username, {
            id: student.id || crypto.randomUUID(),
            username: student.username || 'Sin usuario',
            name: student.name || 'Sin nombre',
            email: student.email || '',
            password: mainUser?.password || 'N/A',
            type: 'student',
            role: 'student',
            uniqueCode: student.uniqueCode || '',
            courseId: student.courseId || '',
            sectionId: student.sectionId || '',
            createdAt: student.createdAt || new Date(),
            isActive: student.isActive !== undefined ? student.isActive : true
          });
        }
      });

      // Agregar profesores DEL AÑO SELECCIONADO
    teachers.forEach((teacher: any) => {
        if (teacher && teacher.username) {
      const mainUser = mainUsers.find((u: any) => u && u.username === teacher.username);
          userMap.set(teacher.username, {
            id: teacher.id || crypto.randomUUID(),
            username: teacher.username || 'Sin usuario',
            name: teacher.name || 'Sin nombre',
            email: teacher.email || '',
            password: mainUser?.password || 'N/A',
            type: 'teacher',
            role: 'teacher',
            uniqueCode: teacher.uniqueCode || '',
            selectedSubjects: teacher.selectedSubjects || [],
            assignedSections: teacher.assignedSections || [],
            createdAt: teacher.createdAt || new Date(),
            isActive: teacher.isActive !== undefined ? teacher.isActive : true
          });
        }
      });

      // Agregar apoderados DEL AÑO SELECCIONADO
      guardians.forEach((guardian: any) => {
        if (guardian && guardian.username) {
          const mainUser = mainUsers.find((u: any) => u && u.username === guardian.username);
          userMap.set(guardian.username, {
            id: guardian.id || crypto.randomUUID(),
            username: guardian.username || 'Sin usuario',
            name: guardian.name || 'Sin nombre',
            email: guardian.email || '',
            password: mainUser?.password || 'N/A',
            type: 'guardian',
            role: 'guardian',
            uniqueCode: guardian.uniqueCode || '',
            phone: guardian.phone || '',
            studentIds: guardian.studentIds || [],
            relationship: guardian.relationship || '',
            createdAt: guardian.createdAt || new Date(),
            isActive: guardian.isActive !== undefined ? guardian.isActive : true
          });
        }
      });

      const rolePriority: Record<string, number> = { admin: 0, teacher: 1, student: 2, guardian: 3 };
      const users = Array.from(userMap.values()).sort((a, b) => {
        const pa = rolePriority[a.type] ?? 99;
        const pb = rolePriority[b.type] ?? 99;
        if (pa !== pb) return pa - pb;
        const nameA = (a.name || '').toString();
        const nameB = (b.name || '').toString();
        return nameA.localeCompare(nameB);
      });
      setAllUsers(users);
    } catch (error) {
      console.error('Error loading users:', error);
      setAllUsers([]);
    }
  };

  const filterUsers = () => {
    let filtered = allUsers;

    if (searchTerm.trim()) {
      filtered = filtered.filter(user => 
        user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        user.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
        user.email?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (filterRole !== 'all') {
      filtered = filtered.filter(user => user.type === filterRole);
    }

    // Limitar a 10 resultados cuando se muestran "Todos" los usuarios (comportamiento por defecto)
    if (filterRole === 'all') {
      filtered = filtered.slice(0, 10);
    }

    setFilteredUsers(filtered);
  };

  const handleEditUser = (user: any) => {
    setEditingUser(user);
    setShowEditDialog(true);
  };

  const handleDeleteUser = (user: any) => {
    setUserToDelete(user);
    setShowDeleteDialog(true);
  };

  const confirmDeleteUser = () => {
    try {
      // Remove from respective collections
      if (userToDelete.type === 'student') {
  const students = LocalStorageManager.getStudentsForYear(selectedYear);
  const updatedStudents = students.filter((s: any) => s.id !== userToDelete.id);
  LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);
      } else if (userToDelete.type === 'teacher') {
  const teachers = LocalStorageManager.getTeachersForYear(selectedYear);
  const updatedTeachers = teachers.filter((t: any) => t.id !== userToDelete.id);
  LocalStorageManager.setTeachersForYear(selectedYear, updatedTeachers);
      } else if (userToDelete.type === 'guardian') {
  // Eliminar apoderado de la colección de apoderados del año
  const guardians = LocalStorageManager.getGuardiansForYear(selectedYear) || [];
  const updatedGuardians = guardians.filter((g: any) => g.id !== userToDelete.id && g.username !== userToDelete.username);
  LocalStorageManager.setGuardiansForYear(selectedYear, updatedGuardians);
  
  // También eliminar las relaciones guardian-student
  const relations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear) || [];
  const updatedRelations = relations.filter((r: any) => r.guardianId !== userToDelete.id);
  LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, updatedRelations);
  
  console.log('✅ Apoderado eliminado:', userToDelete.username);
      }

      // Remove from main users
      const mainUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const updatedMainUsers = mainUsers.filter((u: any) => u.username !== userToDelete.username);
      localStorage.setItem('smart-student-users', JSON.stringify(updatedMainUsers));

      // Notificar eliminación
      try {
        window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'delete', userType: userToDelete.type, source: 'admin-config' } }));
        if (userToDelete.type === 'student') {
          window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'delete' } }));
        }
      } catch {}

      loadAllUsers();
      setShowDeleteDialog(false);
      setUserToDelete(null);

      toast({
        title: translate('userDeleted') || 'User deleted',
        description: translate('userDeletedSuccessfully') || 'User has been deleted successfully',
        variant: 'default'
      });
    } catch (error) {
      toast({
        title: translate('error') || 'Error',
        description: translate('couldNotDeleteUser') || 'Could not delete user',
        variant: 'destructive'
      });
    }
  };

  const getRoleLabel = (type: string) => {
    switch (type) {
      case 'admin': return translate('roleAdmin') || 'Administrador';
      case 'teacher': return translate('roleTeacher') || 'Profesor';
      case 'student': return translate('roleStudent') || 'Estudiante';
      case 'guardian': return translate('roleGuardian') || (translate('userManagementGuardian') || 'Apoderado');
      default: return translate('user') || 'Usuario';
    }
  };


  return (
    <div className="space-y-6">
  <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div>
            <CardTitle className="flex items-center">
              <Users className="w-5 h-5 mr-2" />
              {translate('configAllUsersTitle') || 'Panel de Usuarios del Sistema'}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {translate('configAllUsersDesc') || 'Gestiona y administra todos los usuarios registrados en el sistema'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={() => setShowCreateUserDialog(true)}
              className="bg-blue-600 hover:bg-blue-500 text-white"
              size="sm"
            >
              <UserPlus className="w-4 h-4 mr-2" />
              {translate('userManagementNewUser') || 'Nuevo Usuario'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <Input
              placeholder={translate('configSearchPlaceholder') || 'Buscar por nombre, usuario o email...'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant={filterRole === 'all' ? 'default' : 'outline'}
              onClick={() => setFilterRole('all')}
              size="sm"
              className={filterRole === 'all' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200'}
            >
              {translate('configFilterAll') || 'Todos'} ({allUsers.length})
            </Button>
            <Button
              variant={filterRole === 'admin' ? 'default' : 'outline'}
              onClick={() => setFilterRole('admin')}
              size="sm"
              className={filterRole === 'admin' ? 'bg-red-600 text-white hover:bg-red-500' : 'border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-red-500 dark:text-red-300 dark:hover:bg-red-900/40 dark:hover:text-red-200'}
            >
              {translate('configFilterAdmins') || 'Admins'} ({allUsers.filter(u => u.type === 'admin').length})
            </Button>
            <Button
              variant={filterRole === 'teacher' ? 'default' : 'outline'}
              onClick={() => setFilterRole('teacher')}
              size="sm"
              className={filterRole === 'teacher' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200'}
            >
              {translate('configFilterTeachers') || 'Profesores'} ({allUsers.filter(u => u.type === 'teacher').length})
            </Button>
            <Button
              variant={filterRole === 'student' ? 'default' : 'outline'}
              onClick={() => setFilterRole('student')}
              size="sm"
              className={filterRole === 'student' ? 'bg-green-600 text-white hover:bg-green-500' : 'border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-green-500 dark:text-green-300 dark:hover:bg-green-900/40 dark:hover:text-green-200'}
            >
              {translate('configFilterStudents') || 'Estudiantes'} ({allUsers.filter(u => u.type === 'student').length})
            </Button>
            <Button
              variant={filterRole === 'guardian' ? 'default' : 'outline'}
              onClick={() => setFilterRole('guardian')}
              size="sm"
              className={filterRole === 'guardian' ? 'bg-purple-600 text-white hover:bg-purple-500' : 'border-purple-300 text-purple-700 hover:bg-purple-50 hover:text-purple-800 transition-colors dark:border-purple-500 dark:text-purple-300 dark:hover:bg-purple-900/40 dark:hover:text-purple-200'}
            >
              {translate('configFilterGuardians') || 'Apoderados'} ({allUsers.filter(u => u.type === 'guardian').length})
            </Button>
          </div>
        </div>

        {/* Users Table */}
        <div className="border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {translate('configTableUserColumn') || 'Usuario'}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {translate('configTableTypeColumn') || 'Tipo'}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {translate('configTableEmailColumn') || 'Email'}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {translate('configTableCreatedColumn') || 'Creado'}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {translate('configTableActionsColumn') || 'Acciones'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredUsers.map((user) => (
                  <tr key={user.username} className="hover:bg-muted/50">
                    <td className="px-4 py-4">
                      <div className="flex flex-col">
                        <div className="font-medium">{user.name}</div>
                        <div className="text-sm text-muted-foreground">@{user.username}</div>
                        {user.uniqueCode && (
                          <div className="text-xs text-muted-foreground">{user.uniqueCode}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <Badge className={getRoleColor(user.type)}>
                        {getRoleIcon(user.type)}
                        {getRoleLabel(user.type)}
                      </Badge>
                    </td>
                    <td className="px-4 py-4">
                      <div className="text-sm">{user.email || (translate('configNoEmailText') || 'Sin email')}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="text-sm text-muted-foreground">
                        {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleEditUser(user)}
                          className="border-blue-300 text-blue-700 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:hover:text-blue-200"
                        >
                          <Key className="w-3 h-3 mr-1" />
                          {translate('configEditButton') || 'Editar'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDeleteUser(user)}
                          className="text-red-600 border-blue-300 hover:bg-blue-50 hover:text-blue-800 transition-colors dark:border-red-500 dark:text-red-300 dark:hover:bg-red-900/40 dark:hover:text-red-200"
                        >
                          <Trash2 className="w-3 h-3 mr-1" />
                          {translate('configDeleteButton') || 'Eliminar'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredUsers.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              {translate('configNoUsersFound') || 'No se encontraron usuarios que coincidan con los filtros'}
            </div>
          )}
        </div>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{translate('configConfirmDeleteTitle') || 'Confirmar Eliminación'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p>
                {translate('configConfirmDeleteText')?.replace('{{username}}', userToDelete?.name || userToDelete?.username || 'este usuario') || 
                 `¿Estás seguro de que quieres eliminar al usuario ${userToDelete?.name || userToDelete?.username || 'este usuario'}?`}
              </p>
              <p className="text-sm text-muted-foreground">{translate('configDeleteCannotUndo') || 'Esta acción no se puede deshacer.'}</p>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                  {translate('configCancelButton') || 'Cancelar'}
                </Button>
                <Button variant="destructive" onClick={confirmDeleteUser}>
                  {translate('configDeleteUserButton') || 'Eliminar Usuario'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Edit User Dialog */}
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{translate('configEditUserTitle') || 'Editar Usuario'}</DialogTitle>
            </DialogHeader>
            <EditUserForm 
              user={editingUser} 
              onClose={() => setShowEditDialog(false)}
              onUserUpdated={loadAllUsers}
              getRoleColor={getRoleColor}
              getRoleIcon={getRoleIcon}
              selectedYear={selectedYear}
            />
          </DialogContent>
        </Dialog>

  {/* Create User Dialog (Shared) */}

        <UserFormDialog
          open={showCreateUserDialog}
          onOpenChange={(v) => {
            if (!v) resetCreateUserForm();
            setShowCreateUserDialog(v);
          }}
          form={{
            name: createUserFormData.name,
            rut: createUserFormData.rut,
            email: createUserFormData.email,
            username: createUserFormData.username,
            password: createUserFormData.password,
            confirmPassword: createUserFormData.confirmPassword,
            role: createUserFormData.role,
            autoGenerate: createUserFormData.autoGenerate,
            courseId: createUserFormData.courseId,
            section: createUserFormData.section,
            selectedSubjects: createUserFormData.selectedSubjects,
            phone: createUserFormData.phone,
            studentIds: createUserFormData.studentIds,
            relationship: createUserFormData.relationship,
          }}
          setForm={(updater) => {
            setCreateUserFormData((prev: typeof createUserFormData) => updater(prev as any) as any);
          }}
          validationErrors={{}}
          onSubmit={handleCreateUser}
          isEditing={false}
          availableCourses={availableCourses}
          availableSections={availableSections}
          availableSubjects={availableSubjects}
          availableStudents={availableStudents}
          studentAssignments={studentAssignments}
          showAutoGenerate={true}
          autoGenerateChecked={!!createUserFormData.autoGenerate}
          onToggleAutoGenerate={(checked) => setCreateUserFormData((prev: typeof createUserFormData) => ({ ...prev, autoGenerate: checked }))}
        />
      </CardContent>
    </Card>

    {/* ✅ ELIMINADO: Card y Dialog de "Reiniciar Sistema" - Sección removida por seguridad */}

    </div>
  );
}

// Guardian Student Selector with filters (for edit form)
function GuardianStudentSelector({
  formData,
  setFormData,
  handleInputChange,
  availableStudents,
  availableCourses,
  availableSections,
  translate
}: {
  formData: any;
  setFormData: (fn: (prev: any) => any) => void;
  handleInputChange: (field: string, value: any) => void;
  availableStudents: any[];
  availableCourses: any[];
  availableSections: any[];
  translate: (key: string) => string;
}) {
  const [filterCourseId, setFilterCourseId] = useState('');
  const [filterSectionId, setFilterSectionId] = useState('');

  // Filter sections based on selected course
  const sectionsForFilter = filterCourseId && filterCourseId !== 'all'
    ? availableSections.filter((s: any) => s.courseId === filterCourseId)
    : availableSections;

  // Filter students
  const assignedIds = formData.studentIds || [];
  const filteredStudents = availableStudents.filter((student: any) => {
    // Filter by course
    if (filterCourseId && filterCourseId !== 'all') {
      if (filterCourseId === 'unassigned') {
        if (student.courseId) return false;
      } else {
        if (student.courseId !== filterCourseId) return false;
      }
    }
    // Filter by section
    if (filterSectionId && filterSectionId !== 'all' && student.sectionId !== filterSectionId) return false;
    return true;
  });

  // Sort: assigned first, then unassigned
  const sortedStudents = [...filteredStudents].sort((a, b) => {
    const aAssigned = assignedIds.includes(a.id) ? 0 : 1;
    const bAssigned = assignedIds.includes(b.id) ? 0 : 1;
    if (aAssigned !== bAssigned) return aAssigned - bAssigned;
    return (a.name || '').localeCompare(b.name || '');
  });

  const toggleStudent = (studentId: string) => {
    setFormData((prev: any) => {
      const ids = prev.studentIds || [];
      if (ids.includes(studentId)) return { ...prev, studentIds: ids.filter((id: string) => id !== studentId) };
      return { ...prev, studentIds: [...ids, studentId] };
    });
  };

  return (
    <div className="space-y-4 p-4 bg-purple-50 dark:bg-purple-950 rounded-lg">
      <div>
        <Label htmlFor="phone">{translate('userManagementPhone') || 'Teléfono'}</Label>
        <Input id="phone" type="tel" inputMode="tel" value={formData.phone || ''} onChange={(e) => handleInputChange('phone', e.target.value)} placeholder={translate('userManagementPhonePlaceholder') || '+56 9 1234 5678'} />
      </div>
      <div>
        <Label htmlFor="relationship">{translate('userManagementRelationship') || 'Parentesco'}</Label>
        <Select value={formData.relationship || 'tutor'} onValueChange={(v) => handleInputChange('relationship', v as any)}>
          <SelectTrigger>
            <SelectValue placeholder={translate('userManagementSelectRelationship') || 'Selecciona parentesco'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mother">{translate('relationshipMother') || 'Madre'}</SelectItem>
            <SelectItem value="father">{translate('relationshipFather') || 'Padre'}</SelectItem>
            <SelectItem value="tutor">{translate('relationshipTutor') || 'Tutor'}</SelectItem>
            <SelectItem value="other">{translate('relationshipOther') || 'Otro'}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>{translate('userManagementStudentsInCharge') || 'Estudiantes a cargo'}</Label>
        <p className="text-xs text-muted-foreground mb-2">
          {translate('userManagementSelectStudentsForGuardian') || 'Selecciona los estudiantes que están a cargo de este apoderado'}
        </p>

        {/* Selected students as badges */}
        {assignedIds.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {assignedIds.map((sid: string) => {
              const st = availableStudents.find((s: any) => s.id === sid);
              if (!st) return null;
              const courseName = availableCourses.find((c: any) => c.id === st.courseId)?.name || '';
              const sectionName = availableSections.find((sec: any) => sec.id === st.sectionId)?.name || '';
              return (
                <Badge key={sid} className="bg-purple-600 text-white flex items-center gap-1 pr-1">
                  {st.name} {courseName && <span className="text-purple-200 text-xs">({courseName}{sectionName ? ` - ${sectionName}` : ''})</span>}
                  <button
                    type="button"
                    onClick={() => toggleStudent(sid)}
                    className="ml-1 hover:bg-purple-700 rounded-full p-0.5"
                    title={translate('remove') || 'Eliminar'}
                  >
                    <span className="sr-only">{translate('remove') || 'Eliminar'}</span>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </Badge>
              );
            })}
          </div>
        )}

        {/* Filters (course/section only, no search) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <Select value={filterCourseId || 'all'} onValueChange={(v) => { setFilterCourseId(v === 'all' ? '' : v); setFilterSectionId(''); }}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder={translate('userManagementAllCourses') || 'Todos los cursos'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{translate('userManagementAllCourses') || 'Todos los cursos'}</SelectItem>
              <SelectItem value="unassigned">{translate('userManagementNoAssignedCourse') || 'Sin curso asignado'}</SelectItem>
              {availableCourses.map((c: any) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterSectionId || 'all'} onValueChange={(v) => setFilterSectionId(v === 'all' ? '' : v)} disabled={!filterCourseId || filterCourseId === 'unassigned'}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder={translate('userManagementAllSections') || 'Todas las secciones'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{translate('userManagementAllSections') || 'Todas las secciones'}</SelectItem>
              {sectionsForFilter.map((s: any) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Student list */}
        <div className="mt-2 max-h-56 overflow-y-auto space-y-1 border rounded p-2 bg-background">
          {sortedStudents.length === 0 && (
            <div className="text-sm text-muted-foreground py-2 text-center">
              {availableStudents.length === 0
                ? (translate('userManagementNoStudents') || 'No hay estudiantes registrados en el sistema')
                : (translate('noStudentsMatchFilter') || 'No hay estudiantes que coincidan con los filtros')}
            </div>
          )}
          {sortedStudents.map((s: any) => {
            const isAssigned = assignedIds.includes(s.id);
            const courseName = availableCourses.find((c: any) => c.id === s.courseId)?.name || '';
            const sectionName = availableSections.find((sec: any) => sec.id === s.sectionId)?.name || '';
            return (
              <div
                key={s.id}
                className={`flex items-center space-x-2 p-1.5 rounded cursor-pointer transition-colors ${isAssigned ? 'bg-purple-100 dark:bg-purple-900' : 'hover:bg-muted'}`}
                onClick={() => toggleStudent(s.id)}
              >
                <input
                  type="checkbox"
                  id={`gs-${s.id}`}
                  checked={isAssigned}
                  onChange={() => toggleStudent(s.id)}
                  className="rounded"
                />
                <Label htmlFor={`gs-${s.id}`} className="text-sm cursor-pointer flex-1">
                  {s.name} <span className="text-muted-foreground">@{s.username}</span>
                  {courseName && <span className="ml-1 text-xs text-muted-foreground">({courseName}{sectionName ? ` - ${sectionName}` : ''})</span>}
                </Label>
              </div>
            );
          })}
        </div>
        {assignedIds.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">{assignedIds.length} {assignedIds.length === 1 ? (translate('studentSelected') || 'estudiante seleccionado') : (translate('studentsSelectedPlural') || 'estudiantes seleccionados')}</p>
        )}
      </div>
    </div>
  );
}

// Edit User Form Component
function EditUserForm({ user, onClose, onUserUpdated, getRoleColor, getRoleIcon, selectedYear }: { 
  user: any; 
  onClose: () => void; 
  onUserUpdated: () => void; 
  getRoleColor: (role: string) => string;
  getRoleIcon: (role: string) => React.ReactElement | null;
  selectedYear: number;
}) {
  const { toast } = useToast();
  const { translate } = useLanguage();
  const [formData, setFormData] = useState({
    name: user?.name || '',
    username: user?.username || '',
    email: user?.email || '',
    password: '',
    confirmPassword: '',
    isActive: user?.isActive !== undefined ? user.isActive : true,
    selectedSubjects: user?.selectedSubjects || [],
    courseId: user?.courseId || '',
    sectionId: user?.sectionId || '',
    // Teacher/student/guardian editable fields
    assignedSections: user?.assignedSections || [],
    phone: user?.phone || '',
    studentIds: user?.studentIds || [],
    relationship: user?.relationship || 'tutor'
  });
  const [isLoading, setIsLoading] = useState(false);

  // Load available subjects, courses, and sections
  const [availableSubjects] = useState(() => {
    try {
    return LocalStorageManager.getSubjectsForYear(selectedYear);
    } catch {
      return [];
    }
  });
  
  const [availableCourses] = useState(() => {
    try {
    return LocalStorageManager.getCoursesForYear(selectedYear);
    } catch {
      return [];
    }
  });
  
  const [availableSections] = useState(() => {
    try {
    return LocalStorageManager.getSectionsForYear(selectedYear);
    } catch {
      return [];
    }
  });

  // Students for guardian editing
  const [availableStudents] = useState(() => {
    try { return LocalStorageManager.getStudentsForYear(selectedYear); } catch { return []; }
  });
  

  useEffect(() => {
    if (user) {
      setFormData({
        name: user.name || '',
        username: user.username || '',
        email: user.email || '',
        password: '',
        confirmPassword: '',
        isActive: user.isActive !== undefined ? user.isActive : true,
        selectedSubjects: user.selectedSubjects || [],
        courseId: (user as any).courseId || '',
        sectionId: (user as any).sectionId || '',
        assignedSections: (user as any).assignedSections || [],
        phone: (user as any).phone || '',
        studentIds: (user as any).studentIds || [],
        relationship: (user as any).relationship || 'tutor'
      });
    }
  }, [user]);

  const handleInputChange = (field: string, value: any) => {
    setFormData((prev: any) => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubjectToggle = (subjectName: string) => {
    setFormData((prev: any) => ({
      ...prev,
      selectedSubjects: prev.selectedSubjects.includes(subjectName)
        ? prev.selectedSubjects.filter((s: string) => s !== subjectName)
        : [...prev.selectedSubjects, subjectName]
    }));
  };

  const handleSaveUser = async () => {
    if (!formData.name.trim() || !formData.username.trim()) {
      toast({
        title: translate('error') || 'Error',
        description: translate('editUserRequiredFields') || 'El nombre y usuario son requeridos',
        variant: 'destructive'
      });
      return;
    }

    if (formData.password && formData.password !== formData.confirmPassword) {
      toast({
        title: translate('error') || 'Error',
        description: translate('editUserPasswordMismatch') || 'Las contraseñas no coinciden',
        variant: 'destructive'
      });
      return;
    }

    setIsLoading(true);
    try {
      // Update user in respective collection
      if (user.type === 'student') {
        const students = LocalStorageManager.getStudentsForYear(selectedYear);
  const updatedStudents = students.map((s: any) => 
          s.id === user.id 
            ? { 
                ...s, 
                name: formData.name,
                username: formData.username,
                email: formData.email,
                isActive: formData.isActive,
                courseId: formData.courseId,
                sectionId: formData.sectionId
              }
            : s
        );
        LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);
      } else if (user.type === 'teacher') {
        const teachers = LocalStorageManager.getTeachersForYear(selectedYear);
  const updatedTeachers = teachers.map((t: any) => 
          t.id === user.id 
            ? { 
                ...t, 
                name: formData.name,
                username: formData.username,
                email: formData.email,
                isActive: formData.isActive,
                selectedSubjects: formData.selectedSubjects,
                assignedSections: formData.assignedSections || []
              }
            : t
        );
        LocalStorageManager.setTeachersForYear(selectedYear, updatedTeachers);
      } else if (user.type === 'guardian') {
        const guardians = LocalStorageManager.getGuardiansForYear(selectedYear);
        const updatedGuardians = guardians.map((g: any) =>
          g.id === user.id
            ? {
                ...g,
                name: formData.name,
                username: formData.username,
                email: formData.email,
                isActive: formData.isActive,
                phone: formData.phone || '',
                studentIds: formData.studentIds || [],
                relationship: formData.relationship || 'tutor'
              }
            : g
        );
        LocalStorageManager.setGuardiansForYear(selectedYear, updatedGuardians);

        // Update guardian-student relations: remove existing for this guardian and add new ones
        const existingRelations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear) || [];
        const filtered = existingRelations.filter((r: any) => r.guardianId !== user.id);
        const newRelations = (formData.studentIds || []).map((studentId: string, index: number) => ({
          id: `gsr-${user.id}-${studentId}-${Date.now()}-${index}`,
          guardianId: user.id,
          studentId,
          relationship: formData.relationship || 'tutor',
          isPrimary: index === 0,
          createdAt: new Date()
        }));
        LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, [...filtered, ...newRelations]);
        try { window.dispatchEvent(new CustomEvent('guardiansUpdated', { detail: { action: 'update' } })); } catch {}
      }

      // Update in main users - include guardian-specific fields if guardian
      const mainUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const updatedMainUsers = mainUsers.map((u: any) => 
        u.username === user.username 
          ? { 
              ...u, 
              name: formData.name,
              displayName: formData.name,
              username: formData.username,
              email: formData.email,
              isActive: formData.isActive,
              ...(formData.password ? { password: formData.password } : {}),
              // Guardian-specific fields
              ...(user.type === 'guardian' ? {
                phone: formData.phone || '',
                studentIds: formData.studentIds || [],
                relationship: formData.relationship || 'tutor'
              } : {}),
              // Student-specific fields
              ...(user.type === 'student' ? {
                courseId: formData.courseId || '',
                sectionId: formData.sectionId || ''
              } : {})
            }
          : u
      );
      localStorage.setItem('smart-student-users', JSON.stringify(updatedMainUsers));

      // Eventos de actualización para sincronizar otras vistas
      try {
        window.dispatchEvent(new CustomEvent('usersUpdated', { detail: { action: 'update', userType: user.type, source: 'admin-config' } }));
        if (user.type === 'student') {
          window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', { detail: { action: 'update' } }));
        }
        if (user.type === 'guardian') {
          try { window.dispatchEvent(new CustomEvent('guardiansUpdated', { detail: { action: 'update' } })); } catch {}
        }
      } catch {}

      onUserUpdated();
      onClose();

      toast({
        title: translate('editUserUpdatedTitle') || 'Usuario actualizado',
        description: translate('editUserUpdatedDescription') || 'Los cambios se han guardado correctamente',
        variant: 'default'
      });
    } catch (error) {
      toast({
        title: translate('error') || 'Error',
        description: translate('editUserUpdateError') || 'No se pudo actualizar el usuario',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-6">
      {/* Basic Information */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">{translate('editUserBasicInfo') || 'Información Básica'}</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="name">{translate('editUserFullName') || 'Nombre completo'} *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => handleInputChange('name', e.target.value)}
              placeholder={translate('editUserFullNamePlaceholder') || 'Ingresa el nombre completo'}
            />
          </div>
          
          <div>
            <Label htmlFor="username">{translate('editUserUsername') || 'Usuario'} *</Label>
            <Input
              id="username"
              value={formData.username}
              onChange={(e) => handleInputChange('username', e.target.value)}
              placeholder={translate('editUserUsernamePlaceholder') || 'Ingresa el nombre de usuario'}
            />
          </div>
          
          <div>
            <Label htmlFor="email">{translate('editUserEmail') || 'Email'}</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => handleInputChange('email', e.target.value)}
              placeholder={translate('editUserEmailPlaceholder') || 'email@ejemplo.com'}
            />
          </div>

          <div>
            <Label>{translate('editUserType') || 'Tipo de Usuario'}</Label>
            <div className="mt-2">
              <Badge className={getRoleColor(user.type)}>
                {getRoleIcon(user.type)}
                {user.type === 'admin' ? (translate('editUserTypeAdmin') || 'Administrador') :
                 user.type === 'teacher' ? (translate('editUserTypeTeacher') || 'Profesor') :
                 user.type === 'guardian' ? (translate('editUserTypeGuardian') || translate('userManagementGuardian') || 'Apoderado') :
                 (translate('editUserTypeStudent') || 'Estudiante')}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <Switch
            id="active"
            checked={formData.isActive}
            onCheckedChange={(checked) => handleInputChange('isActive', checked)}
          />
          <Label htmlFor="active">{translate('editUserActive') || 'Usuario activo'}</Label>
        </div>
      </div>

      {/* Password Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">{translate('editUserChangePassword') || 'Cambiar Contraseña'}</h3>
        <p className="text-sm text-muted-foreground">
          {translate('editUserPasswordInfo') || 'Deja estos campos vacíos si no quieres cambiar la contraseña'}
        </p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="password">{translate('editUserNewPassword') || 'Nueva contraseña'}</Label>
            <Input
              id="password"
              type="password"
              value={formData.password}
              onChange={(e) => handleInputChange('password', e.target.value)}
              placeholder={translate('editUserNewPasswordPlaceholder') || 'Nueva contraseña'}
            />
          </div>
          
          <div>
            <Label htmlFor="confirmPassword">{translate('editUserConfirmPassword') || 'Confirmar contraseña'}</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={formData.confirmPassword}
              onChange={(e) => handleInputChange('confirmPassword', e.target.value)}
              placeholder={translate('editUserConfirmPasswordPlaceholder') || 'Confirma la nueva contraseña'}
            />
          </div>
        </div>
      </div>

      {/* Student-specific fields */}
      {user.type === 'student' && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">{translate('editUserAcademicInfo') || 'Información Académica'}</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="course">{translate('editUserCourse') || 'Curso'}</Label>
              <Select
                value={formData.courseId}
                onValueChange={(value) => handleInputChange('courseId', value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={translate('editUserSelectCourse') || 'Seleccionar curso'} />
                </SelectTrigger>
                <SelectContent>
                  {availableCourses.map((course: any) => (
                    <SelectItem key={course.id} value={course.id}>
                      {course.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <Label htmlFor="section">{translate('editUserSection') || 'Sección'}</Label>
              <Select
                value={formData.sectionId}
                onValueChange={(value) => handleInputChange('sectionId', value)}
                disabled={!formData.courseId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={translate('editUserSelectSection') || 'Seleccionar sección'} />
                </SelectTrigger>
                <SelectContent>
                  {availableSections
                    .filter((section: any) => !formData.courseId || section.courseId === formData.courseId)
                    .map((section: any) => (
                      <SelectItem key={section.id} value={section.id}>
                        {translate('editUserSectionPrefix') || 'Sección'} {section.name}
                      </SelectItem>
                    ))
                  }
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <div>
            <Label>{translate('editUserUniqueCode') || 'Código único:'} <span className="font-mono">{user.uniqueCode}</span></Label>
          </div>
        </div>
      )}

      {/* Teacher-specific fields */}
      {user.type === 'teacher' && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">{translate('editUserSubjects') || 'Asignaturas'}</h3>
          
          <div>
            <Label>{translate('editUserUniqueCode') || 'Código único:'} <span className="font-mono">{user.uniqueCode}</span></Label>
          </div>
          
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {availableSubjects.map((subject: any) => (
              <div key={subject.id} className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id={`subject-${subject.id}`}
                  checked={formData.selectedSubjects.includes(subject.name)}
                  onChange={() => handleSubjectToggle(subject.name)}
                  className="rounded"
                />
                <Label htmlFor={`subject-${subject.id}`} className="text-sm">
                  {subject.name}
                </Label>
              </div>
            ))}
          </div>

          {/* Assigned sections for teacher */}
          <div className="space-y-2">
            <Label>{translate('editUserAssignedSections') || 'Secciones asignadas'}</Label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
              {availableSections.map((section: any) => {
                const course = availableCourses.find((c: any) => c.id === section.courseId);
                const checked = (formData.assignedSections || []).includes(section.id);
                return (
                  <div key={section.id} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id={`as-${section.id}`}
                      checked={checked}
                      onChange={() => {
                        setFormData((prev: any) => ({
                          ...prev,
                          assignedSections: checked ? (prev.assignedSections || []).filter((s: string) => s !== section.id) : [...(prev.assignedSections || []), section.id]
                        }));
                      }}
                    />
                    <Label htmlFor={`as-${section.id}`} className="text-sm">{course?.name || 'Curso'} — {section.name}</Label>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Guardian-specific fields */}
      {user.type === 'guardian' && (
        <GuardianStudentSelector
          formData={formData}
          setFormData={setFormData}
          handleInputChange={handleInputChange}
          availableStudents={availableStudents}
          availableCourses={availableCourses}
          availableSections={availableSections}
          translate={translate}
        />
      )}

      {/* Action buttons */}
      <div className="flex gap-2 pt-4 border-t">
        <Button
          onClick={handleSaveUser}
          disabled={isLoading}
          className="bg-blue-500 hover:bg-blue-600 text-white flex-1"
        >
          {isLoading ? (translate('editUserSaving') || 'Guardando...') : (translate('editUserSaveChanges') || 'Guardar Cambios')}
        </Button>
        <Button
          variant="outline"
          onClick={onClose}
          disabled={isLoading}
        >
          {translate('editUserCancel') || 'Cancelar'}
        </Button>
      </div>
    </div>
  );
}
