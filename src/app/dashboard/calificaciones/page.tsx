"use client";

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { toPercentFromConfigured } from '@/lib/grading';
import { useAuth } from '@/contexts/auth-context';
import { useLanguage } from '@/contexts/language-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getHeaderBgClass, getHeaderBorderClass, getTitleTextClass, getBodyTextClass } from '@/lib/ui-colors';
import { Badge } from '@/components/ui/badge';
import { isFirebaseEnabled, getCurrentProvider } from '@/lib/sql-config';
import { getSubjectsForLevel } from '@/lib/subjects-colors';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { useGradesSQL } from '@/hooks/useGradesSQL';
import { useAttendanceSQL } from '@/hooks/useAttendanceSQL';
import MonitoCalificaciones from '@/components/monito-calificaciones';
// Virtualización (carga condicional para no romper SSR si no está instalado)
let FixedSizeList: any = null;
try { FixedSizeList = require('react-window').FixedSizeList; } catch {}

// Tipos básicos
type TestGrade = {
  id: string;
  testId: string;
  studentId: string;
  studentName: string;
  score: number; // 0-100
  courseId: string | null;
  sectionId: string | null;
  subjectId: string | null;
  title?: string;
  gradedAt: number;
}

type Course = { id: string; name: string };
type Section = { id: string; name: string; courseId: string };

type Subject = { id: string; name: string };

type Option = { value: string; label: string };

type Task = {
  id: string;
  title: string;
  description: string;
  subject: string;
  // IDs opcionales que pueden venir en distintas fuentes del LS
  subjectId?: string | null;
  course: string;
  courseId?: string | null;
  assignedById: string;
  assignedByName: string;
  assignedTo: 'course' | 'student';
  assignedStudentIds?: string[];
  dueDate: string;
  createdAt: string;
  // Algunas fuentes usan startAt/openAt; se soportan como opcionales
  startAt?: string;
  openAt?: string;
  sectionId?: string | null;
  status: 'pending' | 'submitted' | 'reviewed' | 'delivered' | 'finished';
  priority: 'low' | 'medium' | 'high';
  taskType: 'tarea' | 'evaluacion' | 'prueba';
  topic?: string;
  numQuestions?: number;
  timeLimit?: number;
}

type PendingTask = {
  taskId: string;
  title: string;
  taskType: 'tarea' | 'evaluacion' | 'prueba';
  createdAt: string;
  subject: string;
  course: string;
  courseId?: string | null;
  sectionId?: string | null;
  assignedTo: 'course' | 'student';
  assignedStudentIds?: string[];
  columnIndex: number; // N1=0, N2=1, etc.
  topic?: string;
  description?: string;
}


function loadJson<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; } }

export default function GradesPage() {
  const { user } = useAuth();
  const { translate } = useLanguage();
  const COLOR = 'indigo' as const;
  
  // Hook SQL para cargar calificaciones
  const { 
    isConnected: isSQLConnected, 
    getGradesByYear, 
    getGradesByCourseAndSection, // 🔥 NUEVA función optimizada
    getActivitiesByYear 
  } = useGradesSQL();


  
  // Tick para forzar recomputar memos basados en localStorage
  const [refreshTick, setRefreshTick] = useState(0);
  // Año global (sin selector visual aún): sincronizado con admin-selected-year
  const [selectedYear, setSelectedYear] = useState<number>(() => {
    const saved = Number(localStorage.getItem('admin-selected-year') || '');
    return Number.isFinite(saved) && saved > 0 ? saved : new Date().getFullYear();
  });

  // Hook SQL para cargar asistencia (para promedio de estudiante)
  const { getAttendanceByYear } = useAttendanceSQL();


  const [studentAttendanceStats, setStudentAttendanceStats] = useState<{
    avg: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
  } | null>(null);

  // (Lógica de asistencia movida más abajo para tener acceso a filtros)



  // Helper: convierte a ISO de forma segura evitando RangeError cuando la fecha es inválida
  const toIso = (val: any): string => {
    try {
      if (val == null) return new Date().toISOString();
      // Si viene numérico o string numérico, probar como número primero
      if (typeof val === 'number' && isFinite(val)) {
        const d = new Date(val);
        return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
      }
      if (typeof val === 'string') {
        // 1) Probar parse directo de string (ISO u otros formatos aceptados)
        let d = new Date(val);
        if (isFinite(d.getTime())) return d.toISOString();
        // 2) Si es string numérico, parsear como número (timestamp)
  const num = Number(val);
        if (isFinite(num)) {
          d = new Date(num);
          if (isFinite(d.getTime())) return d.toISOString();
        }
        // 3) Intentar Date.parse
        const ts = Date.parse(val);
        if (isFinite(ts)) {
          d = new Date(ts);
          if (isFinite(d.getTime())) return d.toISOString();
        }
        // Fallback
        return new Date().toISOString();
      }
      // Otros tipos: intentar new Date(val)
      const d = new Date(val);
      return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  };

  // Parser específico para fechas de CSV en formato DD-MM-YYYY o DD/MM/YYYY (día primero)
  const parseCsvDayFirstDate = (raw: string): number | null => {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    // Evitar procesar cadenas ISO (que contienen 'T')
    if (trimmed.includes('T')) return null;
    const m = trimmed.match(/^([0-9]{1,2})[\/-]([0-9]{1,2})[\/-]([0-9]{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900)) return null;
    // Usar mediodía local para evitar desplazamientos a día anterior por zona horaria (UTC-3/UTC-4)
    const dt = new Date(year, month - 1, day, 12, 0, 0, 0);
    const ts = dt.getTime();
    return isFinite(ts) ? ts : null;
  };

  // Normalizador robusto para gradedAt que acepta números, ISO, timestamps y formato CSV DD-MM-YYYY
  const normalizeGradedAt = (val: any): number => {
    try {
      if (val == null) return Date.now();
      if (typeof val === 'number' && isFinite(val)) return val;
      if (typeof val === 'string') {
        const csvTs = parseCsvDayFirstDate(val);
        if (csvTs != null) {
          if (localStorage.getItem('debug-semester')) {
            console.log(`🗓️ [gradedAt-normalize] CSV detectado '${val}' → ${new Date(csvTs).toISOString()}`);
          }
          return csvTs;
        }
        // Intentar parse directo (ISO u otros reconocidos)
        const direct = new Date(val);
        if (isFinite(direct.getTime())) return direct.getTime();
        // String numérico
        const num = Number(val);
        if (isFinite(num)) return num;
        // Date.parse fallback
        const parsed = Date.parse(val);
        if (isFinite(parsed)) return parsed;
        return Date.now();
      }
      const d = new Date(val);
      return isFinite(d.getTime()) ? d.getTime() : Date.now();
    } catch {
      return Date.now();
    }
  };

  // Helper de traducción con fallback: si translate devuelve la clave o un valor vacío, usa el fallback
  const tr = (key: string, fallback: string) => {
    try {
      const val = translate(key);
      if (!val || val === key) return fallback;
      return val;
    } catch {
      return fallback;
    }
  };

  // Datos base
  const [grades, setGrades] = useState<TestGrade[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [studentAssignments, setStudentAssignments] = useState<any[]>([]);
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);

  // === Promedio General (para estudiante o apoderado cuando hay estudiante seleccionado) ===
  const overallAverage = useMemo(() => {
    try {
      const scores: number[] = (grades || []).map(g => Number(g.score ?? g.scoreValue ?? g.grade ?? 0)).filter(n => typeof n === 'number' && !isNaN(n));
      if (scores.length === 0) return null;
      const avg = scores.reduce((a,b)=>a+b,0)/scores.length;
      return Math.round(avg * 10) / 10; // one decimal rounding
    } catch (e) {
      return null;
    }
  }, [grades]);

  const getAvgMessageKey = (avg: number | null) => {
    if (avg == null) return null;
    if (avg >= 85) return 'avgMsgExcellent';
    if (avg >= 75) return 'avgMsgVeryGood';
    if (avg >= 70) return 'avgMsgGood';
    if (avg >= 60) return 'avgMsgPass';
    return 'avgMsgKeepGoing';
  };
  
  // 🎓 APODERADO: Estudiantes asignados al guardian
  const [guardianStudents, setGuardianStudents] = useState<any[]>([]);
  const [selectedGuardianStudent, setSelectedGuardianStudent] = useState<string | null>(null);

  // Helper: decidir si mostrar la tarjeta de Promedio General (evaluada en tiempo de render)
  const shouldShowAverageCard = () => {
    return (user?.role === 'student') || (user?.role === 'guardian' && Boolean(selectedGuardianStudent));
  };
  // Timeline completo (todas las tareas/evaluaciones/pruebas relevantes para mostrar burbujas N1..N10, no solo pendientes)
  const [timelineTasks, setTimelineTasks] = useState<PendingTask[]>([]);
  // Actividades SQL (cuando hay conexión)
  const [activitiesSQL, setActivitiesSQL] = useState<any[]>([]);
  // Avisos de migración SQL
  const [sqlMigrating, setSqlMigrating] = useState<{ years: number[] } | null>(null);
  const [sqlMigratedInfo, setSqlMigratedInfo] = useState<{ years: number[]; totalInserted: number } | null>(null);
  // Estado salud Firebase (para que el indicador verde signifique conexión real a Firebase)
  const [firebaseHealthy, setFirebaseHealthy] = useState<boolean | null>(null);


  // Arreglo heurístico de textos con mojibake común en cargas masivas (UTF-8 mal decodificado)
  const fixMojibake = (txt?: string | null) => {
    if (!txt) return '';
    let s = String(txt);
    // Eliminar caracteres de control ASCII de bajo rango
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E\x0F]/g, '');
    // Intentar reparar secuencias con carácter de reemplazo � (U+FFFD) antes de eliminarlo
    // Ejemplos frecuentes en datos reales
    s = s
      .replace(/(H)\uFFFD(bitat)/g, '$1á$2')
      .replace(/(h)\uFFFD(bitat)/g, '$1á$2')
      .replace(/(N)\uFFFD(meros)/g, '$1ú$2')
      .replace(/(n)\uFFFD(meros)/g, '$1ú$2')
      .replace(/s\uFFFDmbolo(s)?/gi, (m, p1) => `símbolo${p1 ? 's' : ''}`)
      .replace(/n\uFFFDmeric(a|o|as|os)/gi, (m, p1) => `numéric${p1}`)
      .replace(/comparaci\uFFFDn/gi, 'comparación')
      .replace(/geograf\uFFFDa/gi, 'geografía')
      .replace(/educaci\uFFFDn/gi, 'educación')
      .replace(/evaluaci\uFFFDn/gi, 'evaluación')
      .replace(/comunicaci\uFFFDn/gi, 'comunicación')
      .replace(/alimentaci\uFFFDn/gi, 'alimentación')
      .replace(/matem\uFFFDticas/gi, 'matemáticas')
      .replace(/f\uFFFDsica/gi, 'física')
      .replace(/biolog\uFFFDa/gi, 'biología')
      .replace(/tecnolog\uFFFDa/gi, 'tecnología')
      .replace(/m\uFFFDsica/gi, 'música');
    // Eliminar carácter de reemplazo Unicode � (U+FFFD) que indica encoding inválido (residuales)
    s = s.replace(/\uFFFD/g, '');
    // Normalizar espacios no separables y similares
    s = s.replace(/\u00A0/g, ' ');
    // Intento de doble decodificación (Latin1 -> UTF-8) si parece mojibake generalizado
    try {
      if (typeof TextDecoder !== 'undefined') {
        const accented = /[ÃÂ¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿]/.test(s);
        if (accented) {
          const bytes = new Uint8Array([...s].map(c => c.charCodeAt(0) & 0xFF));
          const rec = new TextDecoder('utf-8').decode(bytes);
            // Heurística: si la versión re-decodificada tiene más caracteres españoles correctos, adoptarla
          const score = (t: string) => (t.match(/[áéíóúñÁÉÍÓÚÑ]/g) || []).length;
          if (score(rec) > score(s)) s = rec;
        }
      }
    } catch {}
    // Intentar corregir doble decodificación UTF-8 -> ISO-8859-1
    // Patrón general: secuencias Ã + letra acentuada; aplicamos reemplazos específicos primero
    const replacements: Array<[RegExp, string]> = [
      [/Ã¡/g, 'á'], [/Ã©/g, 'é'], [/Ãí/g, 'í'], [/Ã³/g, 'ó'], [/Ãº/g, 'ú'], [/Ã±/g, 'ñ'], [/Ã¼/g, 'ü'],
      [/Ã/g, 'Á'], [/Ã‰/g, 'É'], [/Ã/g, 'Í'], [/Ã“/g, 'Ó'], [/Ãš/g, 'Ú'], [/Ã‘/g, 'Ñ'], [/Ãœ/g, 'Ü'],
      [/Ã‚/g, 'Â'], [/Ã€/g, 'À'], [/Ãƒ/g, 'Ã'], [/Ãˆ/g, 'È'], [/ÃŠ/g, 'Ê'],
      [/Ã§/g, 'ç'], [/Ã‡/g, 'Ç'], [/Ã¦/g, 'æ'], [/Ã…/g, 'Å'], [/Ã¸/g, 'ø'], [/ÃŸ/g, 'ß']
    ];
    replacements.forEach(([rgx, to]) => { s = s.replace(rgx, to); });
    // Casos donde se perdió la ñ completa y quedó "ao" en vez de "año".
    // Patrón específico muy frecuente en los datos: "Las estaciones del ao".
    s = s.replace(/\b(estaciones\s+del)\s+ao\b/gi, (_, prefix) => `${prefix} año`);
    // Determinantes + ao -> año (del, el, al, un, este, cada, por)
    s = s.replace(/\b(del|el|al|un|este|cada|por)\s+ao\b/gi, (_, det) => `${det} año`);
    // "ao" aislado como palabra (riesgo mínimo en contexto educativo frente a "ano")
    s = s.replace(/\bao\b/gi, 'año');
    // Restaurar "anos" -> "años" cuando la palabra parece plural y no está precedida por "del" + anatomía (evitar órganos del ano)
    s = s.replace(/\b(anos)\b/gi, (m) => 'años');
  // Final en "cin" → "ción" (muy común en español: educación, evaluación, comunicación, alimentación...)
  s = s.replace(/([a-záéíóúñ])cin\b/gi, '$1ción');
  // Palabras frecuentes que pierden vocal inicial acentuada
  s = s.replace(/\brganos\b/g, 'órganos').replace(/\bRganos\b/g, 'Órganos');
    // Singular 'rgano'
    s = s.replace(/\brgano\b/g, 'órgano').replace(/\bRgano\b/g, 'Órgano');
    // Otras palabras comunes sin acento por pérdida
    s = s.replace(/evaluacion/gi, 'evaluación')
      .replace(/educacion/gi, 'educación')
      .replace(/comunicacion/gi, 'comunicación')
      .replace(/alimentacion/gi, 'alimentación')
      .replace(/asignacion/gi, 'asignación')
      .replace(/organizacion/gi, 'organización')
      .replace(/nacion/gi, 'nación')
      .replace(/relacion/gi, 'relación');
    // Casos donde se eliminó la vocal acentuada por completo (muy vistos en datos)
    s = s
      .replace(/\bhbitat\b/gi, 'hábitat')
      .replace(/\bsmbolo(s)?\b/gi, (m, p1) => `símbolo${p1 ? 's' : ''}`)
      .replace(/\bsimbolo(s)?\b/gi, (m, p1) => `símbolo${p1 ? 's' : ''}`)
      .replace(/\bnmeric(a|o|as|os)\b/gi, (m, p1) => `numéric${p1}`)
      .replace(/\bnumeric(a|o|as|os)\b/gi, (m, p1) => `numéric${p1}`)
      // Falta de 'e' en numéricas/numérico(s)
      .replace(/\bnumric(a|o|as|os)\b/gi, (m, p1) => `numéric${p1}`)
      .replace(/\bnmeros\b/gi, 'números')
      .replace(/\bnumeros\b/gi, 'números')
      .replace(/\bcomparacin\b/gi, 'comparación')
      .replace(/\bmatemticas\b/gi, 'matemáticas')
      .replace(/\bqumica\b/gi, 'química')
      .replace(/\bfisica\b/gi, 'física')
      // Básica/Básico sin vocal acentuada o con vocal perdida por completo
      .replace(/\bbsic(a|o|as|os)\b/gi, (m, p1) => `básic${p1}`)
      .replace(/\bbasica(s)?\b/gi, (m, p1) => `básica${p1 || ''}`)
      .replace(/\bbasico(s)?\b/gi, (m, p1) => `básico${p1 || ''}`)
      .replace(/\bbiologa\b/gi, 'biología');
    // Casos específicos reportados en tooltips
    s = s.replace(/\bcomprensin\b/gi, 'comprensión');
    // Eliminar "Â" sobrante antes de signos y espacios
    s = s.replace(/Â(?=[\s¡!¿?\-:;,\.])/g, '');
    // Quitar caracteres de reemplazo
    s = s.replace(/�+/g, '');
    // Colapsar espacios
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  };

  // Normalizador robusto para nombres de asignaturas (sin tildes ni puntuación)
  const normSubj = (s: any) => String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Tratamiento especial: convertir guiones y guiones bajos en espacios ANTES de limpiar
    .replace(/[_\-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '') // elimina comas y otros signos, preservando espacios
    .replace(/\s+/g, ' ')
    .trim();

  // Canonizador de nombres de asignaturas para tolerar variaciones de importación (acentos y cortes)
  const canonicalSubject = (s?: string) => {
    // Primero intentar arreglar mojibake si existe
    const fixedInput = fixMojibake(String(s || ''));
    const n = normSubj(fixedInput);
    // Reparaciones de patrones donde un importador eliminó la vocal acentuada completa (geografía -> geografa, educación -> educacin, física -> fsica, comunicación -> comunicacin)
    let fixed = n
      .replace(/\bgeografa\b/g, 'geografia')
      .replace(/\beducacin\b/g, 'educacion')
      .replace(/\bfsica\b/g, 'fisica')
      .replace(/\bcomunicacin\b/g, 'comunicacion')
      // Muy frecuente: "matemticas" (pérdida de la á completa) → matematicas
      .replace(/\bmatemticas\b/g, 'matematicas');
    // Si hubo cambios, log opcional (solo primeras veces para no saturar)
    if (fixed !== n && typeof window !== 'undefined') {
      const key = '__canon_fix_logged__';
      const already = (window as any)[key] || 0;
      if (already < 10) {
        console.log(`🧪 [canonicalSubject] FIX aplicado: '${n}' → '${fixed}'`);
        (window as any)[key] = already + 1;
      }
    }
    const v = fixed;
    // Normalizaciones específicas conocidas
    if (v.startsWith('lenguaje y comunic')) return 'lenguaje y comunicacion';
    if (v.startsWith('matemat')) return 'matematicas';
    if (v.startsWith('ciencias naturales')) return 'ciencias naturales';
    // Historia: distintos formatos posibles
    // Casos observados tras normalizar (se eliminan comas):
    //  - 'historia geografia y ciencias sociales' (coma removida antes de geografía)
    //  - 'historia y geografia y ciencias sociales'
    //  - 'historia y geografia'
    //  - 'historia geografia' (cuando se pierde la 'y' por formato CSV)
    //  - 'historia geografa' (mojibake: í → a)
    if (
      v.startsWith('historia y geografia') ||
      v.startsWith('historia geografia y ciencias sociales') ||
      v.startsWith('historia y geografia y ciencias sociales') ||
      v === 'historia geografia' ||
      v === 'historia geografia y ciencias sociales' ||
      v.startsWith('historia geografa y ciencias sociales') || // variante con pérdida de í (mojibake)
      v.startsWith('historia geografa') || // variante corta con mojibake
      v === 'historia geografa'
    ) return 'historia y geografia';
    // Extra: si contiene ambas palabras separadas pero sin 'y', unificamos
    if (/^historia\s+geograf[ia](\b|\s)/.test(v)) return 'historia y geografia';
    if (v.startsWith('educacion fisica')) return 'educacion fisica';
    if (v.startsWith('artes visuales')) return 'artes visuales';
    if (v.startsWith('musica')) return 'musica';
    if (v.startsWith('tecnologia')) return 'tecnologia';
    if (v.startsWith('orientacion')) return 'orientacion';
    // Asignaturas de Educación Media
    if (v.startsWith('quimica') || v === 'quimica') return 'quimica';
    if (v.startsWith('biologia') || v === 'biologia') return 'biologia';
    if (v.startsWith('fisica') && !v.includes('educacion')) return 'fisica'; // Física (ciencia), no Ed. Física
    if (v.startsWith('filosofia') || v === 'filosofia') return 'filosofia';
    if (v.startsWith('educacion ciudadana') || v === 'educacion ciudadana') return 'educacion ciudadana';
    return v;
  };

  // Distancia de edición mínima (Levenshtein) ligera para tolerar 1-2 caracteres faltantes
  const nearEqual = (a: string, b: string, threshold = 2) => {
    if (a === b) return true;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > threshold) return false;
    const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // borrado
          dp[i][j - 1] + 1,      // inserción
          dp[i - 1][j - 1] + cost // sustitución
        );
      }
    }
    return dp[m][n] <= threshold;
  };

  // Filtros (combinar curso+sección en un solo filtro usando sectionId)
  const [levelFilter, setLevelFilter] = useState<'all' | 'basica' | 'media'>('all');
  const [comboSectionId, setComboSectionId] = useState<string>('all');
  const [subjectFilter, setSubjectFilter] = useState<string>('all');
  const [semester, setSemester] = useState<'all' | '1' | '2'>('all');
  
  // 🔥 NUEVO: Control para consultas optimizadas a Firebase
  const [useOptimizedQuery, setUseOptimizedQuery] = useState(true); // ✅ HABILITADO por defecto: consultar Firebase según filtros
  const [isLoadingOptimized, setIsLoadingOptimized] = useState(false);
  const [isUsingOptimizedData, setIsUsingOptimizedData] = useState(false); // Indica si los datos actuales vienen de consulta optimizada
  
  // Overlay inicial enfocado (solo estudiante) y progreso
  const [showInitialOverlay, setShowInitialOverlay] = useState<boolean>(true);
  const [overlayProgress, setOverlayProgress] = useState<number>(0);
  const [autoSemesterDone, setAutoSemesterDone] = useState<boolean>(false);
  const [sqlFetchDone, setSqlFetchDone] = useState<boolean>(false);
  const [sqlFetchProgress, setSqlFetchProgress] = useState<number>(0);
  // Estado y refs para controlar cuándo mostrar el overlay de sincronización
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const lastSyncShownAtRef = useRef<number>(0);
  const lastGradesReloadAtRef = useRef<number>(0);
  const canStartSync = useCallback(() => {
    const now = Date.now();
    // Cooldown de 5s para evitar parpadeos si llegan muchos eventos
    if (now - (lastSyncShownAtRef.current || 0) < 5000) return false;
    lastSyncShownAtRef.current = now;
    return true;
  }, []);
  // Calendario de semestres (configurable en Admin)
  type SemestersCfg = { first: { start: string; end: string }; second: { start: string; end: string } };
  const [semestersCfg, setSemestersCfg] = useState<SemestersCfg | null>(null);
  // Semestres: ahora por año (smart-student-semesters-YYYY) con fallback a clave global antigua
  const SEM_KEY_PREFIX = 'smart-student-semesters';
  const semesterKey = (y: number) => `${SEM_KEY_PREFIX}-${y}`;

  // Estado de cascada
  const [cascadeCourseId, setCascadeCourseId] = useState<string | null>(null);
  const [cascadeSectionId, setCascadeSectionId] = useState<string | null>(null);
  const [cascadeSubject, setCascadeSubject] = useState<string | null>(null);
  const [studentFilter, setStudentFilter] = useState<'all' | string>('all');

  // Cargar promedio de asistencia (Estudiante logueado O Admin/Profesor filtrando)
  useEffect(() => {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🔄 [loadAttendance useEffect] Hook ejecutándose');
    console.log('   selectedYear:', selectedYear);
    console.log('   userRole:', user?.role);
    console.log('   studentFilter:', studentFilter);
    console.log('   cascadeSectionId:', cascadeSectionId);
    console.log('   cascadeCourseId:', cascadeCourseId);
    console.log('   comboSectionId:', comboSectionId);
    console.log('   semester:', semester);
    console.log('   getAttendanceByYear exists:', !!getAttendanceByYear);
    console.log('═══════════════════════════════════════════════════════════');

    const loadAttendance = async () => {
      console.log('🔄 [loadAttendance INIT] Función ejecutándose...');

      if (!selectedYear) {
        console.warn('⚠️ [loadAttendance] No hay año seleccionado');
        return;
      }

      // Caso 1: Estudiante logueado (ver su propia asistencia)
      if (user?.role === 'student') {
        console.log('🎓 [ASISTENCIA ESTUDIANTE] Cargando asistencia para estudiante logueado');
        console.log('   user.id:', user.id);
        console.log('   user.username:', user.username);
        try {
          const records = await getAttendanceByYear(selectedYear);
          console.log('📊 [ASISTENCIA ESTUDIANTE] Total registros:', records?.length || 0);
          
          if (records && records.length > 0) {
            // Normalizar identificadores del estudiante para comparación robusta
            const norm = (v: any) => String(v ?? '').toLowerCase().trim();
            const normRut = (v: any) => norm(v).replace(/\./g, '').replace(/-/g, '');

            const studentIdStr = norm(user.id);
            const studentUsernameStr = norm(user.username);
            const studentRutStr = norm((user as any)?.rut);
            const studentRutCleanStr = normRut((user as any)?.rut);
            const studentNameStr = norm((user as any)?.displayName || (user as any)?.name);
            
            // Filtrar por estudiante con comparación robusta
            const myRecords = records.filter((r: any) => {
              const recStudentId = norm(r.studentId);
              const recStudentUsername = norm(r.studentUsername || r.username);
              const recStudentRut = norm(r.studentRut || r.rut || r.RUT);
              const recStudentRutClean = normRut(r.studentRut || r.rut || r.RUT);
              const recStudentName = norm(r.studentName || r.estudiante || r.nombre);

              return (
                (studentIdStr && recStudentId === studentIdStr) ||
                (studentUsernameStr && (recStudentId === studentUsernameStr || recStudentUsername === studentUsernameStr)) ||
                (studentRutStr && (recStudentId === studentRutStr || recStudentRut === studentRutStr)) ||
                (studentRutCleanStr && (recStudentId === studentRutCleanStr || recStudentRutClean === studentRutCleanStr)) ||
                (studentNameStr && recStudentName === studentNameStr)
              );
            });
            
            console.log('📋 [ASISTENCIA ESTUDIANTE] Registros filtrados:', myRecords.length);
            
            let present = 0;
            let late = 0;
            let absent = 0;
            let excused = 0;
            
            myRecords.forEach((r: any) => {
              const rawSt = r.status || r.estado || r.Status || r.Estado;
              const st = String(rawSt || '').replace(/['"]/g, '').replace(/\.$/, '').trim().toLowerCase();
              
              if (['present', 'presente', 'asistente', 'p', '1', 'true'].includes(st)) present++;
              else if (['late', 'tarde', 'atrasado', 'atraso', 'l', 't'].includes(st)) late++;
              else if (['absent', 'ausente', 'falta', 'a', '0', 'false'].includes(st)) absent++;
              else if (['excused', 'justificado', 'licencia', 'e', 'j'].includes(st)) excused++;
            });
            
            const total = present + late + absent + excused;
            const positive = present + late;
            
            console.log('📈 [ASISTENCIA ESTUDIANTE] Stats:', { present, late, absent, excused, total, avg: total > 0 ? Math.round((positive / total) * 100) : 0 });
            
            if (total > 0) {
              setStudentAttendanceStats({
                avg: Math.round((positive / total) * 100),
                present,
                late,
                absent,
                excused
              });
            } else {
              console.warn('⚠️ [ASISTENCIA ESTUDIANTE] No se encontraron registros para este estudiante');
              setStudentAttendanceStats(null);
            }
          } else {
            setStudentAttendanceStats(null);
          }
        } catch (e) {
          console.error('Error loading attendance for grades page (student):', e);
          setStudentAttendanceStats(null);
        }
      }
      // Caso 2: Apoderado (ver asistencia del estudiante seleccionado)
      else if (user?.role === 'guardian' && selectedGuardianStudent) {
        console.log('👨‍👩‍👧 [ASISTENCIA APODERADO] Cargando asistencia para estudiante seleccionado');
        console.log('   selectedGuardianStudent:', selectedGuardianStudent);
        
        // Buscar el objeto completo del estudiante seleccionado
        const selectedStudent = guardianStudents.find(s => String(s.id) === String(selectedGuardianStudent));
        console.log('   Estudiante encontrado:', selectedStudent?.displayName || selectedStudent?.name);
        console.log('   username del estudiante:', selectedStudent?.username);
        
        try {
          const records = await getAttendanceByYear(selectedYear);
          console.log('📊 [ASISTENCIA APODERADO] Total registros:', records?.length || 0);
          
          if (records && records.length > 0) {
            // Normalizar identificadores del estudiante para comparación robusta
            const norm = (v: any) => String(v ?? '').toLowerCase().trim();
            const normRut = (v: any) => norm(v).replace(/\./g, '').replace(/-/g, '');

            const studentIdStr = norm(selectedGuardianStudent);
            const studentUsernameStr = norm(selectedStudent?.username);
            const studentRutStr = norm(selectedStudent?.rut);
            const studentRutCleanStr = normRut(selectedStudent?.rut);
            const studentNameStr = norm(selectedStudent?.displayName || selectedStudent?.name);
            
            console.log('🔍 [ASISTENCIA APODERADO] Buscando con:', { studentIdStr, studentUsernameStr, studentNameStr });
            
            // Filtrar por el estudiante seleccionado con comparación robusta
            const myRecords = records.filter((r: any) => {
              const recStudentId = norm(r.studentId);
              const recStudentUsername = norm(r.studentUsername || r.username);
              const recStudentRut = norm(r.studentRut || r.rut || r.RUT);
              const recStudentRutClean = normRut(r.studentRut || r.rut || r.RUT);
              const recStudentName = norm(r.studentName || r.estudiante || r.nombre);

              return (
                (studentIdStr && recStudentId === studentIdStr) ||
                (studentUsernameStr && (recStudentId === studentUsernameStr || recStudentUsername === studentUsernameStr)) ||
                (studentRutStr && (recStudentId === studentRutStr || recStudentRut === studentRutStr)) ||
                (studentRutCleanStr && (recStudentId === studentRutCleanStr || recStudentRutClean === studentRutCleanStr)) ||
                (studentNameStr && recStudentName === studentNameStr)
              );
            });
            
            console.log('📋 [ASISTENCIA APODERADO] Registros filtrados para estudiante:', myRecords.length);
            
            let present = 0;
            let late = 0;
            let absent = 0;
            let excused = 0;
            
            myRecords.forEach((r: any) => {
              const rawSt = r.status || r.estado || r.Status || r.Estado;
              const st = String(rawSt || '').replace(/['"]/g, '').replace(/\.$/, '').trim().toLowerCase();
              
              if (['present', 'presente', 'asistente', 'p', '1', 'true'].includes(st)) present++;
              else if (['late', 'tarde', 'atrasado', 'atraso', 'l', 't'].includes(st)) late++;
              else if (['absent', 'ausente', 'falta', 'a', '0', 'false'].includes(st)) absent++;
              else if (['excused', 'justificado', 'licencia', 'e', 'j'].includes(st)) excused++;
            });
            
            const total = present + late + absent + excused;
            const positive = present + late;
            
            console.log('📈 [ASISTENCIA APODERADO] Stats:', { present, late, absent, excused, total, avg: total > 0 ? Math.round((positive / total) * 100) : 0 });
            
            if (total > 0) {
              setStudentAttendanceStats({
                avg: Math.round((positive / total) * 100),
                present,
                late,
                absent,
                excused
              });
            } else {
              console.warn('⚠️ [ASISTENCIA APODERADO] No se encontraron registros para el estudiante seleccionado');
              setStudentAttendanceStats(null);
            }
          } else {
            setStudentAttendanceStats(null);
          }
        } catch (e) {
          console.error('Error loading attendance for grades page (guardian):', e);
          setStudentAttendanceStats(null);
        }
      }
      // Caso 3: Admin o Profesor (ver asistencia según filtros)
      else if (user?.role === 'admin' || user?.role === 'teacher') {
        console.log('🔄 [loadAttendance] studentFilter:', studentFilter, 'cascadeSectionId:', cascadeSectionId);
        
        // Si hay un estudiante seleccionado específicamente
        if (studentFilter !== 'all' && studentFilter) {
           try {
            const records = await getAttendanceByYear(selectedYear);
            console.log('👤 [ASISTENCIA ESTUDIANTE] Buscando asistencia para estudiante:', studentFilter);
            console.log('📊 [ASISTENCIA ESTUDIANTE] Total registros en BD:', records?.length || 0);
            
            if (records && records.length > 0) {
              // Buscar al estudiante en la lista de usuarios para obtener todos sus identificadores
              const targetId = String(studentFilter);
              const studentObj = users.find(u => 
                String(u.id) === targetId || 
                String(u.username) === targetId
              );
              
              // Construir set de identificadores posibles del estudiante
              const possibleIds = new Set<string>();
              possibleIds.add(targetId);
              if (studentObj) {
                if (studentObj.id) possibleIds.add(String(studentObj.id));
                if (studentObj.username) possibleIds.add(String(studentObj.username));
                if (studentObj.rut) {
                  possibleIds.add(String(studentObj.rut));
                  // RUT limpio (sin puntos ni guiones)
                  possibleIds.add(String(studentObj.rut).replace(/\./g, '').replace(/-/g, '').toLowerCase());
                }
                if (studentObj.displayName) possibleIds.add(String(studentObj.displayName));
              }
              
              console.log('👤 [ASISTENCIA ESTUDIANTE] Identificadores posibles:', Array.from(possibleIds));
              
              // Filtrar registros del estudiante con búsqueda robusta
              const cleanRut = (val: string) => String(val || '').replace(/\./g, '').replace(/-/g, '').toLowerCase();
              
              const myRecords = records.filter((r: any) => {
                const rStudentId = String(r.studentId || '');
                const rUsername = String(r.username || r.studentUsername || '');
                const rRut = String(r.rut || '');
                const rName = String(r.nombre || r.studentName || '');
                
                return possibleIds.has(rStudentId) || 
                       possibleIds.has(rUsername) || 
                       possibleIds.has(rRut) ||
                       possibleIds.has(cleanRut(rRut)) ||
                       possibleIds.has(rName);
              });
              
              console.log('✅ [ASISTENCIA ESTUDIANTE] Registros encontrados:', myRecords.length);
              
              // Calcular estadísticas con mapeo robusto de estados
              let present = 0, late = 0, absent = 0, excused = 0;
              myRecords.forEach((r: any) => {
                const rawSt = r.status || r.estado || r.Status || r.Estado;
                const st = String(rawSt || '').replace(/['"]/g, '').replace(/\.$/, '').trim().toLowerCase();
                
                if (['present', 'presente', 'asistente', 'p', '1', 'true'].includes(st)) present++;
                else if (['late', 'tarde', 'atrasado', 'atraso', 'l', 't'].includes(st)) late++;
                else if (['absent', 'ausente', 'falta', 'a', '0', 'false'].includes(st)) absent++;
                else if (['excused', 'justificado', 'licencia', 'e', 'j'].includes(st)) excused++;
              });
              
              const total = present + late + absent + excused;
              const positive = present + late;
              
              console.log('📈 [ASISTENCIA ESTUDIANTE] Estadísticas:', { present, late, absent, excused, total, avg: total > 0 ? Math.round((positive / total) * 100) : 0 });
              
              // Mostrar siempre si hay filtro activo, aunque sea 0
              setStudentAttendanceStats({ 
                avg: total > 0 ? Math.round((positive / total) * 100) : 0, 
                present, late, absent, excused 
              });
            } else {
               console.warn('⚠️ [ASISTENCIA ESTUDIANTE] No hay registros de asistencia en la BD');
               setStudentAttendanceStats(null);
            }
          } catch (e) {
            console.error('Error loading attendance for grades page (admin/teacher student):', e);
            setStudentAttendanceStats(null);
          }
        }
        // Si NO hay estudiante seleccionado, pero SÍ hay Sección O Curso (vista agregada de curso/sección)
        else if (cascadeSectionId || cascadeCourseId || (comboSectionId && comboSectionId !== 'all')) {
          // Cuando solo hay curso seleccionado (comboSectionId === 'all'), usamos null para targetSectionId
          // y filtramos por curso completo más abajo.
          const targetSectionId = (cascadeSectionId || (comboSectionId && comboSectionId !== 'all')) ? (cascadeSectionId || comboSectionId) : null;
          console.log('═══════════════════════════════════════════════════════════');
          console.log('🎯 [ASISTENCIA CURSO] INICIO CÁLCULO PARA CURSO COMPLETO');
          console.log('   Sección ID:', targetSectionId);
          console.log('   Curso ID:', cascadeCourseId);
          console.log('   Año:', selectedYear);
          console.log('   Semestre:', semester);
          console.log('═══════════════════════════════════════════════════════════');
          try {
            const records = await getAttendanceByYear(selectedYear);
            console.log('📊 [ASISTENCIA CURSO] Registros totales cargados desde BD:', records?.length || 0);
            
            if (!records || records.length === 0) {
              console.log('ℹ️ [ASISTENCIA CURSO] No hay registros de asistencia en la base de datos para el año', selectedYear);
              setStudentAttendanceStats(null);
              return;
            }
            
            // 🔍 DIAGNÓSTICO CRÍTICO: Muestra COMPLETA del primer registro
            console.log('🔬 [ASISTENCIA CURSO] Primer registro COMPLETO:', JSON.stringify(records[0], null, 2));
            
            if (records && records.length > 0) {
              // 1. Obtener objeto sección y curso para normalizar nombres (soporte CSV)
              const secObj = targetSectionId
                ? sections.find(s => String(s.id) === String(targetSectionId))
                : null;
              // Si no hay sección específica (vista de curso completo), usamos cascadeCourseId
              const courseObj = secObj
                ? courses.find(c => String(c.id) === String(secObj.courseId))
                : courses.find(c => String(c.id) === String(cascadeCourseId));
              
              console.log('🔍 [ASISTENCIA CURSO] Sección:', secObj?.name, 'Curso:', courseObj?.name);
              
              // Normalizador agresivo para cursos (ej: "1ro Básico" == "1° Básico" == "Primero Básico")
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
              
              const normalizeSectionName = (s: string) => {
                 return String(s||'').toLowerCase()
                   .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                   .replace(/\bseccion\b|\bsec\b/g, '')
                   .replace(/[^a-z0-9]/g, '');
              };

              const targetSecName = secObj ? normalizeSectionName(secObj.name) : ''; 
              const targetCourseName = courseObj ? normalizeCourseName(courseObj.name) : '';
              
              console.log('🔑 [ASISTENCIA CURSO] Normalizados - Sección:', targetSecName, 'Curso:', targetCourseName);
              
              // 2. Identificar estudiantes de la sección (por ID, Username y RUT)
              // Robustecemos el Set para incluir todos los identificadores posibles de los estudiantes de esta sección
              const sectionStudents = new Set<string>();
              const assignmentsForSection = targetSectionId
                ? studentAssignments.filter(a => String(a.sectionId) === String(targetSectionId))
                : studentAssignments.filter(a => String(a.courseId) === String(cascadeCourseId));
              
              assignmentsForSection.forEach(a => {
                 const sId = String(a.studentId || '');
                 const sUser = String(a.studentUsername || '');
                 if (sId) sectionStudents.add(sId);
                 if (sUser) sectionStudents.add(sUser);
                 
                 // Buscar usuario completo para agregar RUT e ID cruzados
                 const u = users.find(user => String(user.id) === sId || String(user.username) === sUser);
                 if (u) {
                   if (u.rut) {
                     sectionStudents.add(String(u.rut));
                     // Agregar RUT limpio también
                     sectionStudents.add(String(u.rut).replace(/\./g, '').replace(/-/g, '').toLowerCase());
                   }
                   if (u.username) sectionStudents.add(String(u.username));
                   if (u.id) sectionStudents.add(String(u.id));
                 }
              });
              
              console.log(`👥 [ASISTENCIA CURSO] Estudiantes en sección: ${assignmentsForSection.length} asignaciones, ${sectionStudents.size} IDs únicos rastreados`);
              
              // 3. Filtrar registros
              const semFilter = semester !== 'all' ? semester : null;
              console.log('📅 [ASISTENCIA CURSO] Filtro semestre:', semFilter);
              
              // Muestra de registros para debug
              if (records.length > 0) {
                console.log('📋 [ASISTENCIA CURSO] Muestra registro (primero):', {
                  studentId: records[0].studentId,
                  username: records[0].username,
                  rut: records[0].rut,
                  // Firebase usa 'course'/'section', CSV usa 'curso'/'seccion'
                  course: records[0].course,
                  section: records[0].section,
                  curso: records[0].curso,
                  seccion: records[0].seccion,
                  courseId: records[0].courseId,
                  sectionId: records[0].sectionId,
                  date: records[0].date,
                  fecha: records[0].fecha,
                  status: records[0].status,
                  estado: records[0].estado
                });
              }
              
              const sectionRecords = records.filter((r: any) => {
                // Helper para chequear semestre con lógica ampliada y soporte de formatos
                const checkSemester = () => {
                  if (!semFilter) return true;
                  
                  let d: Date;
                  const rawDate = r.date || r.fecha || r.timestamp;
                  
                  // Soporte explícito para DD-MM-YYYY y DD/MM/YYYY (común en CSVs latinos)
                  if (typeof rawDate === 'string') {
                    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(rawDate)) {
                       const [day, month, year] = rawDate.split('-').map(Number);
                       d = new Date(year, month - 1, day);
                    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawDate)) {
                       const [day, month, year] = rawDate.split('/').map(Number);
                       d = new Date(year, month - 1, day);
                    } else {
                       d = new Date(rawDate);
                    }
                  } else {
                     d = new Date(rawDate);
                  }

                  if (isNaN(d.getTime())) return false;
                  
                  const m = d.getMonth(); // 0=Ene, 11=Dic
                  // 🔧 CALENDARIO ESCOLAR CHILENO:
                  // Semestre 1: Marzo a Junio (meses 2-5)
                  // Semestre 2: Julio a Diciembre (meses 6-11)
                  const rSem = (m >= 2 && m <= 5) ? '1' : (m >= 6 && m <= 11) ? '2' : null;
                  
                  if (!rSem) {
                    console.warn('⚠️ [ASISTENCIA] Fecha fuera de semestres escolares:', rawDate, 'mes:', m);
                    return false;
                  }
                  
                  return semFilter === rSem;
                };

                if (!checkSemester()) return false;

                // A) Coincidencia por sectionId directamente (Firebase)
                if (targetSectionId && r.sectionId && String(r.sectionId) === String(targetSectionId)) {
                  return true;
                }
                // A2) Si no hay sección específica (vista por curso), intentar matchear por courseId
                if (!targetSectionId && cascadeCourseId && r.courseId && String(r.courseId) === String(cascadeCourseId)) {
                  return true;
                }
                
                // B) Coincidencia por ID de estudiante (más confiable para CSVs)
                const sid = String(r.studentId || '');
                const suser = String(r.username || '');
                const srut = String(r.rut || '');
                const cleanRut = (val: string) => String(val || '').replace(/\./g, '').replace(/-/g, '').toLowerCase();
                
                if ((sid && sectionStudents.has(sid)) || 
                    (suser && sectionStudents.has(suser)) || 
                    (srut && (sectionStudents.has(srut) || sectionStudents.has(cleanRut(srut))))) {
                   return true;
                }
                
                // C) Coincidencia por Nombre de Curso/Sección (fallback para CSVs sin IDs)
                const recordCourse = r.course || r.curso;
                const recordSection = r.section || r.seccion;
                
                // Si tiene datos de curso/sección, validar que coincidan
                if (recordCourse || recordSection) {
                  const rCurso = normalizeCourseName(recordCourse || '');
                  const rSeccion = normalizeSectionName(recordSection || '');
                  
                  // Coincidencia positiva: debe coincidir al menos curso O sección
                  const courseMatch = rCurso && targetCourseName && rCurso === targetCourseName;
                  const sectionMatch = rSeccion && targetSecName && rSeccion === targetSecName;
                  
                  if (courseMatch || sectionMatch) {
                    // Si uno coincide, verificar que el otro no contradiga (si está presente)
                    if (courseMatch && rSeccion && targetSecName && rSeccion !== targetSecName) return false;
                    if (sectionMatch && rCurso && targetCourseName && rCurso !== targetCourseName) return false;
                    return true;
                  }
                }
                
                return false;
              });
              
              console.log('✅ [ASISTENCIA CURSO] Registros filtrados:', sectionRecords.length);

              // Si no hay registros para esta combinación de curso/sección/semestre,
              // limpiamos la tarjeta en lugar de mostrar 0% (que parece un dato real).
              if (!sectionRecords.length) {
                console.warn('⚠️ [ASISTENCIA CURSO] No se encontraron registros para la sección/curso seleccionados.');
                console.warn('   Revisa:');
                console.warn('   - Filtro semestre:', semester);
                console.warn('   - targetSectionId:', targetSectionId);
                console.warn('   - Estudiantes esperados:', sectionStudents.size);
                console.warn('   - Total registros disponibles:', records.length);
                setStudentAttendanceStats(null);
                return;
              }

              // Mostrar muestra de registros encontrados para diagnóstico
              console.log('📋 [ASISTENCIA CURSO] Muestra registros filtrados (primeros 3):', sectionRecords.slice(0, 3).map((r: any) => ({
                studentId: r.studentId,
                date: r.date || r.fecha,
                status: r.status || r.estado,
                course: r.course || r.curso,
                section: r.section || r.seccion
              })));

              // Calcular promedio de asistencia del curso
              // El promedio debe ser: (Total Presentes + Tarde) / Total Registros * 100
              let present = 0, late = 0, absent = 0, excused = 0;
              const unmappedStatuses = new Set<string>();

              sectionRecords.forEach((r: any) => {
                // Soportar variaciones de mayúsculas, espacios y claves (CSV/Firebase)
                const rawSt = r.status || r.estado || r.Status || r.Estado;
                // Limpiar comillas, espacios y puntos finales para normalizar
                const st = String(rawSt || '').replace(/['"]/g, '').replace(/\.$/, '').trim().toLowerCase();
                
                if (['present', 'presente', 'asistente', 'p', '1', 'true'].includes(st)) present++;
                else if (['late', 'tarde', 'atrasado', 'atraso', 'l', 't'].includes(st)) late++;
                else if (['absent', 'ausente', 'falta', 'a', '0', 'false'].includes(st)) absent++;
                else if (['excused', 'justificado', 'licencia', 'e', 'j'].includes(st)) excused++;
                else if (st) unmappedStatuses.add(st);
              });

              if (unmappedStatuses.size > 0) {
                console.warn('⚠️ [ASISTENCIA CURSO] Estados no reconocidos:', Array.from(unmappedStatuses));
                console.warn('   Necesitas agregar estos estados al mapeo en el código');
              }

              const total = present + late + absent + excused;
              
              console.log('🔢 [ASISTENCIA CURSO] Conteo antes de calcular:', { 
                present, 
                late, 
                absent, 
                excused, 
                total,
                registrosOriginales: sectionRecords.length 
              });
              
              // Si hay registros pero no se pudo mapear ninguno, es un error de formato
              if (total === 0) {
                 if (sectionRecords.length > 0) {
                   console.error('❌ [ASISTENCIA CURSO] Registros encontrados pero ninguno tiene estado válido.');
                   console.error('   Estados únicos en los registros:', [...new Set(sectionRecords.map((r: any) => r.status || r.estado))]);
                 }
                 setStudentAttendanceStats(null);
                 return;
              }

              const positive = present + late;

              const stats = {
                avg: Math.round((positive / total) * 100),
                present,
                late,
                absent,
                excused,
              };

              console.log('📈 [ASISTENCIA CURSO] Estadísticas calculadas:', stats);
              console.log('   Fórmula: (', positive, '/', total, ') * 100 =', stats.avg, '%');
              
              if (stats.avg === 0) {
                console.warn('⚠️ [ASISTENCIA] Promedio 0% detectado con registros válidos.');
                console.warn('   Esto indica que todos los registros se contaron como Ausente o Justificado.');
              }

              setStudentAttendanceStats(stats);
            } else {
               console.warn('⚠️ [ASISTENCIA CURSO] No hay registros de asistencia para el año seleccionado.');
               setStudentAttendanceStats(null);
            }
          } catch (e) {
             console.error('Error loading attendance for grades page (admin/teacher section):', e);
             setStudentAttendanceStats(null);
          }
        } else {
          // Sin filtros suficientes
          setStudentAttendanceStats(null);
        }
      }
    };
    
    loadAttendance();
  }, [user, selectedYear, getAttendanceByYear, studentFilter, cascadeSectionId, cascadeCourseId, comboSectionId, semester, studentAssignments, sections, courses, users, selectedGuardianStudent, guardianStudents]);
  // Guards para evitar ráfagas y recargas concurrentes entre eventos
  const reloadingGradesRef = useRef(false);
  const reloadingActsRef = useRef(false);
  const lastGradesEventTsRef = useRef<number>(0);
  const lastActsEventTsRef = useRef<number>(0);
  const initialLoadDoneRef = useRef(false); // Evitar múltiples cargas iniciales

  // Conteos de respaldo: estudiantes únicos con nota por sección (derivados de grades)
  const gradedStudentIdsBySection = useMemo(() => {
    const map = new Map<string, Set<string>>();
    try {
      (grades || []).forEach((g: any) => {
        const secId = g?.sectionId != null ? String(g.sectionId) : '';
        const stuId = g?.studentId != null ? String(g.studentId) : '';
        if (!secId || !stuId) return;
        let set = map.get(secId);
        if (!set) { set = new Set<string>(); map.set(secId, set); }
        set.add(stuId);
      });
    } catch {}
    return map;
  }, [grades]);

  // Carga inicial
  useEffect(() => {
    // Verificar salud de Firebase (solo si está habilitado) para que el indicador verde signifique conexión real
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
    // Ejecutar una sola vez al montar
    checkHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Carga inicial
  useEffect(() => {
    const loadGradesData = async () => {
      // Evitar recargas múltiples (solo la primera vez por año)
      if (initialLoadDoneRef.current) {
        console.log('⏭️ Carga inicial ya realizada, omitiendo...');
        return;
      }
      
      const { LocalStorageManager } = require('@/lib/education-utils');
      
      // Cargar año actual desde admin-selected-year (si cambia en otra pestaña)
      try {
        const saved = Number(localStorage.getItem('admin-selected-year') || '');
        if (Number.isFinite(saved) && saved > 0 && saved !== selectedYear) setSelectedYear(saved);
      } catch {}
      
      // 🚀 CARGA INSTANTÁNEA: Mostrar LocalStorage PRIMERO (no esperar SQL)
      const localGrades = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
      const cleanedLocal = Array.isArray(localGrades)
        ? localGrades.filter(g => !String(g?.testId || '').startsWith('demo-'))
        : [];
      
      console.log(`📊 [Calificaciones] Carga inicial para año ${selectedYear}:`, {
        totalLocal: localGrades?.length || 0,
        sinDemo: cleanedLocal.length,
        isEmpty: cleanedLocal.length === 0
      });
      
      // 🔧 NORMALIZAR courseId y sectionId en LocalStorage si es necesario
      if (cleanedLocal.length > 0) {
        const sectionsData = LocalStorageManager.getSectionsForYear(selectedYear);
        const coursesData = LocalStorageManager.getCoursesForYear(selectedYear);
        
        console.log(`🔍 [Normalizador] Verificando datos: sections=${sectionsData?.length || 0}, courses=${coursesData?.length || 0}`);
        console.log(`🔍 [Normalizador] Muestra de calificación ANTES: courseId=${cleanedLocal[0]?.courseId}, sectionId=${cleanedLocal[0]?.sectionId}`);
        
        if (Array.isArray(sectionsData) && sectionsData.length > 0 && 
            Array.isArray(coursesData) && coursesData.length > 0) {
          
          console.log(`✅ [Normalizador] Iniciando normalización...`);
          
          // Mapa: nombre de curso → UUID
          const courseNameMap = new Map<string, string>();
          coursesData.forEach(c => {
            const normalized = String(c.name).toLowerCase()
              .replace(/\s+/g, '_')
              .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
              .replace(/ó/g, 'o').replace(/ú/g, 'u');
            courseNameMap.set(normalized, String(c.id));
            // Alias sin vocales: "1ro_basico" → "1ro_bsico"
            courseNameMap.set(normalized.replace('_basico', '_bsico'), String(c.id));
            courseNameMap.set(normalized.replace('_medio', '_mdio'), String(c.id));
          });
          
          // Mapa: courseUUID + letra → sectionUUID
          const sectionMap = new Map<string, string>();
          sectionsData.forEach(s => {
            const courseId = String(s.courseId).toLowerCase();
            const letter = String(s.name).trim().toLowerCase();
            const key = `${courseId}_${letter}`;
            sectionMap.set(key, String(s.id));
          });
          
          let needsNormalization = false;
          let debugCount = 0;
          const normalized = cleanedLocal.map(g => {
            const courseIdOriginal = String(g.courseId || '').toLowerCase().trim();
            const sectionIdOriginal = String(g.sectionId || '').toLowerCase().trim();
            
            // Debug primera calificación
            if (debugCount === 0) {
              console.log(`🔍 [Normalizador] Primera calificación:`, {
                courseIdOriginal,
                sectionIdOriginal,
                courseIdStored: g.courseId
              });
              debugCount++;
            }
            
            // Detectar si courseId es UUID o texto
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseIdOriginal);
            const courseUUID = isUUID ? courseIdOriginal : courseNameMap.get(courseIdOriginal);
            
            if (!courseUUID) {
              if (debugCount === 1) {
                console.warn(`⚠️ [Normalizador] Curso no encontrado:`, courseIdOriginal);
                debugCount++;
              }
              return g;
            }
            
            // Si courseId cambió, normalizar
            const courseIdNormalized = String(g.courseId).toLowerCase().trim();
            if (courseUUID !== courseIdNormalized) {
              if (debugCount < 3) {
                console.log(`✏️ [Normalizador] courseId cambiará: ${courseIdNormalized} → ${courseUUID}`);
                debugCount++;
              }
              needsNormalization = true;
            }
            
            // Si sectionId es letra, convertir a UUID
            const isSectionUUID = /^[0-9a-f]{8}-/i.test(sectionIdOriginal);
            if (!isSectionUUID && sectionIdOriginal.length === 1) {
              const sectionUUID = sectionMap.get(`${courseUUID}_${sectionIdOriginal}`);
              if (sectionUUID) {
                if (debugCount < 3) {
                  console.log(`✏️ [Normalizador] sectionId cambiará: ${sectionIdOriginal} → ${sectionUUID}`);
                  debugCount++;
                }
                needsNormalization = true;
                return { ...g, courseId: courseUUID, sectionId: sectionUUID };
              }
            }
            
            // Retornar con courseId normalizado
            return { ...g, courseId: courseUUID, sectionId: sectionIdOriginal };
          });
          
          console.log(`🔍 [Normalizador] Resultado: needsNormalization=${needsNormalization}`);
          
          if (needsNormalization) {
            console.log(`🔧 [Normalizador] ✅ Aplicando normalización a ${normalized.length} calificaciones...`);
            console.log(`🔍 [Normalizador] Muestra DESPUÉS: courseId=${normalized[0]?.courseId}, sectionId=${normalized[0]?.sectionId}`);
            setGrades(normalized);
            // Guardar normalizado
            LocalStorageManager.setTestGradesForYear(selectedYear, normalized);
            console.log(`✅ [Normalizador] Guardado en LocalStorage exitosamente`);
          } else {
            console.log(`ℹ️ [Normalizador] No se requiere normalización, usando datos originales`);
            setGrades(cleanedLocal);
          }
        } else {
          console.log(`⚠️ [Normalizador] Faltan datos: sections o courses vacíos`);
          setGrades(cleanedLocal);
        }
      } else {
        console.log(`⚠️ [Normalizador] cleanedLocal vacío`);
        setGrades(cleanedLocal);
      }
      
      if (cleanedLocal.length > 0) {
        console.log(`⚡ Carga instantánea: ${cleanedLocal.length} calificaciones desde LocalStorage`);
      } else {
        console.log(`⚠️ LocalStorage vacío - esperando SQL/Firebase`);
      }
      
      // Debug: Estado de conexión SQL
      console.log(`🔍 [DEBUG] SQL Connection State:`, {
        isSQLConnected,
        hasGetGradesByYear: !!getGradesByYear,
        selectedYear
      });
      
      // 🔄 CARGA EN SEGUNDO PLANO: Intentar SQL/Firebase sin bloquear UI
      // 🔥 PARA ADMIN: Cargar todas las calificaciones incluso en modo optimizado
      // Para otros roles: respetar el modo optimizado que espera filtros
      const shouldLoadAll = user?.role === 'admin' || !useOptimizedQuery;
      
      if (getGradesByYear && shouldLoadAll) {
        // Ejecutar carga SQL en segundo plano (async sin await bloqueante)
        (async () => {
          try {
            console.log(`🔥 Cargando desde Firebase/SQL para año ${selectedYear}... (admin o modo no optimizado)`);
            setIsSyncing(true);
            if (canStartSync()) {
              setSqlFetchDone(false);
            }
            setSqlFetchProgress(0);
            
            // Simular progreso de carga
            const progressInterval = setInterval(() => {
              setSqlFetchProgress(prev => {
                if (prev >= 90) return prev;
                return prev + 10;
              });
            }, 100);

            // 🎓 FILTRO PARA ESTUDIANTES: Solo cargar sus calificaciones
            let rawSqlGrades;
            if (user?.role === 'student' || user?.role === 'estudiante') {
              console.log(`🎓 [Estudiante] Cargando solo calificaciones del usuario: ${user.username}`);
              
              // Obtener IDs posibles del estudiante
              const studentIds = [
                user.id,
                user.rut,
                user.username,
                `10000000-8` // RUT de Sofia (temporal - eliminar después)
              ].filter(Boolean);
              
              console.log(`🔍 [Estudiante] Buscando por IDs:`, studentIds);
              
              // Cargar todas y filtrar en cliente (Firebase no soporta OR en queries complejas)
              const allGrades = await getGradesByYear(selectedYear);
              
              rawSqlGrades = allGrades.filter((g: any) => {
                const matchId = studentIds.includes(String(g.studentId));
                const matchUsername = String(g.studentUsername) === user.username;
                const matchName = String(g.studentName || '').toLowerCase().includes((user.displayName || '').toLowerCase());
                return matchId || matchUsername || matchName;
              });
              
              console.log(`✅ [Estudiante] Filtradas ${rawSqlGrades.length} de ${allGrades.length} calificaciones`);
            } else {
              // Admin/Profesor: Cargar todas
              rawSqlGrades = await getGradesByYear(selectedYear);
            }
            
            clearInterval(progressInterval);
            setSqlFetchProgress(100);
            
            // Validar que se recibió un array válido
            if (!rawSqlGrades || !Array.isArray(rawSqlGrades)) {
              console.warn(`⚠️ Firebase returned invalid format, manteniendo LocalStorage`);
              setSqlFetchDone(true);
              setIsSyncing(false);
              return;
            }
            
            if (rawSqlGrades.length === 0) {
              console.warn(`⚠️ Firebase sin datos para ${selectedYear}, manteniendo LocalStorage`);
              setSqlFetchDone(true);
              setIsSyncing(false);
              return;
            }
            
            console.log(`✅ Firebase retornó ${rawSqlGrades.length} calificaciones`);
            
            // 🔍 DEBUG: Mostrar estructura de las primeras calificaciones
            if (rawSqlGrades.length > 0) {
              console.log(`🔍 [DEBUG] Muestra de calificaciones de Firebase (primeras 3):`, 
                rawSqlGrades.slice(0, 3).map(g => ({
                  studentName: g.studentName,
                  score: g.score,
                  courseId: g.courseId,
                  sectionId: g.sectionId,
                  subjectId: g.subjectId || g.subject,
                  title: g.title
                }))
              );
            }
            
            // 🔧 NORMALIZAR courseId y sectionId: Firebase usa formatos variables
            console.log(`🔧 [Firebase] Normalizando courseId y sectionId...`);
            
            // Mapa: nombre de curso → UUID
            const courseNameMap = new Map<string, string>();
            courses.forEach(c => {
              const normalized = String(c.name).toLowerCase()
                .replace(/\s+/g, '_')
                .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
                .replace(/ó/g, 'o').replace(/ú/g, 'u');
              courseNameMap.set(normalized, String(c.id));
              // Alias sin vocales
              courseNameMap.set(normalized.replace('_basico', '_bsico'), String(c.id));
              courseNameMap.set(normalized.replace('_medio', '_mdio'), String(c.id));
            });
            
            // Mapa: courseUUID + letra → sectionUUID
            const sectionMap = new Map<string, string>();
            sections.forEach(s => {
              const courseId = String(s.courseId).toLowerCase();
              const letter = String(s.name).trim().toLowerCase();
              const key = `${courseId}_${letter}`;
              sectionMap.set(key, String(s.id));
            });
            console.log(`📋 [Firebase] Mapas creados: ${courseNameMap.size} cursos, ${sectionMap.size} secciones`);
            
            let normalizedCount = 0;
            const sqlGrades = rawSqlGrades.map(grade => {
              const courseIdOriginal = String(grade.courseId || '').toLowerCase().trim();
              const sectionIdOriginal = String(grade.sectionId || '').toLowerCase().trim();
              
              // Detectar si courseId es UUID o texto
              const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseIdOriginal);
              const courseUUID = isUUID ? courseIdOriginal : courseNameMap.get(courseIdOriginal);
              
              if (!courseUUID) {
                console.warn(`⚠️ [Firebase] Curso no encontrado: ${courseIdOriginal}`);
                return {
                  ...grade,
                  gradedAt: normalizeGradedAt(grade.gradedAt)
                };
              }
              
              // Si sectionId es letra, convertir a UUID
              const isSectionUUID = /^[0-9a-f]{8}-/i.test(sectionIdOriginal);
              let sectionUUID = sectionIdOriginal;
              
              if (!isSectionUUID && sectionIdOriginal.length === 1) {
                const mapped = sectionMap.get(`${courseUUID}_${sectionIdOriginal}`);
                if (mapped) {
                  sectionUUID = mapped;
                  normalizedCount++;
                }
              }
              
              return {
                ...grade,
                courseId: courseUUID,
                sectionId: sectionUUID,
                gradedAt: normalizeGradedAt(grade.gradedAt)
              };
            });
            
            console.log(`✅ [Firebase] Normalizadas ${normalizedCount} de ${sqlGrades.length} calificaciones`);
            console.log(`🔍 [Firebase] Muestra DESPUÉS: courseId=${sqlGrades[0]?.courseId}, sectionId=${sqlGrades[0]?.sectionId}`);
            
            // 🔥 SIEMPRE actualizar con datos de Firebase (es la fuente de verdad)
            setGrades(sqlGrades);
            console.log(`✅ Actualizando estado con datos de Firebase: ${sqlGrades.length} calificaciones`);
            console.log(`📊 [DEBUG] Estado actualizado con ${sqlGrades.length} registros desde Firebase`);
            
            // Opcional: Sincronizar a LocalStorage para cache
            try {
              const { LocalStorageManager } = require('@/lib/education-utils');
              LocalStorageManager.setTestGradesForYear(selectedYear, sqlGrades);
              console.log(`💾 Calificaciones sincronizadas a LocalStorage`);
            } catch (syncError) {
              console.warn('⚠️ No se pudo sincronizar a LocalStorage:', syncError);
            }
            
            setSqlFetchDone(true);
            setIsSyncing(false);
          } catch (e: any) {
            console.error('❌ Error en carga Firebase:', e?.message || e);
            setSqlFetchDone(true);
            setSqlFetchProgress(0);
            setIsSyncing(false);
            // Mantener los datos de LocalStorage que ya se mostraron
          }
        })();
      } else {
        console.warn(`⚠️ getGradesByYear no disponible, usando solo LocalStorage`);
        setSqlFetchDone(true);
      }
      
      // Marcar carga inicial como completada
      initialLoadDoneRef.current = true;
    };
    
    loadGradesData();
    
    // Cargar otros datos
    try {
      const { LocalStorageManager } = require('@/lib/education-utils');
      setCourses(LocalStorageManager.getCoursesForYear(selectedYear));
      setSections(LocalStorageManager.getSectionsForYear(selectedYear));
      setSubjects(LocalStorageManager.getSubjectsForYear(selectedYear));
      // Estudiantes por año (catálogo students); fallback a usuarios globales
      try {
        const studentsYear = LocalStorageManager.getStudentsForYear(selectedYear);
        if (Array.isArray(studentsYear) && studentsYear.length) {
          // Mezclar con usuarios existentes manteniendo otros roles
          const others = loadJson<any[]>('smart-student-users', []).filter(u => u.role && u.role !== 'student' && u.role !== 'estudiante');
          setUsers([...studentsYear, ...others]);
        } else {
          setUsers(loadJson<any[]>('smart-student-users', []));
        }
      } catch { setUsers(loadJson<any[]>('smart-student-users', [])); }
      // Student assignments por año (si existen); fallback global
      const perYearAssigns = (() => { try { return LocalStorageManager.getStudentAssignmentsForYear(selectedYear); } catch { return null; } })();
      console.log(`📊 [Calificaciones] StudentAssignments por año ${selectedYear}:`, perYearAssigns?.length || 0);
      if (Array.isArray(perYearAssigns) && perYearAssigns.length) {
        console.log(`✅ Usando asignaciones del año ${selectedYear}`);
        setStudentAssignments(perYearAssigns);
      } else {
        const globalAssigns = loadJson<any[]>(`smart-student-student-assignments-${selectedYear}`, []);
        console.log(`⚠️ No hay asignaciones para ${selectedYear}, usando con año:`, globalAssigns.length);
        setStudentAssignments(globalAssigns);
      }
    } catch {
      setCourses(loadJson<Course[]>('smart-student-courses', []));
      setSections(loadJson<Section[]>('smart-student-sections', []));
      setSubjects(loadJson<Subject[]>('smart-student-subjects', []));
      const globalAssigns = loadJson<any[]>(`smart-student-student-assignments-${selectedYear}`, []);
      console.log(`⚠️ Error en carga, usando asignaciones con año:`, globalAssigns.length);
      setStudentAssignments(globalAssigns);
    }
    // ❌ ELIMINADO: NO sobrescribir las asignaciones que ya cargamos arriba
    // Las líneas siguientes pisaban los datos correctos con arrays vacíos
    // setUsers(loadJson<any[]>('smart-student-users', []));
    // setStudentAssignments(loadJson<any[]>('smart-student-student-assignments', []));

  // Cargar tareas pendientes de calificación
  loadPendingTasks();
    
  // Sincronizar calificaciones de tareas con el sistema de calificaciones de forma diferida
  // para no bloquear el primer pintado cuando hay mucha data.
  setTimeout(() => { try { syncTaskGrades(); } catch {} }, 0);

    const onStorage = (e: StorageEvent) => {
      const { LocalStorageManager } = require('@/lib/education-utils');
      const gradesKey = LocalStorageManager.keyForTestGrades(selectedYear);
      if (e.key === gradesKey && e.newValue) {
        try { setGrades(JSON.parse(e.newValue)); } catch {}
        // Recalcular pendientes ya que puede que una tarea quede calificada
        loadPendingTasks();
        setRefreshTick(t => t + 1);
      }
  if (e.key === 'admin-selected-year' && e.newValue) {
        const y = Number(e.newValue);
        if (Number.isFinite(y) && y > 0) {
          // Reset filtros si el cambio vino de otra pestaña
          setLevelFilter('all');
          setCascadeCourseId(null);
          setCascadeSectionId(null);
          setCascadeSubject(null);
          setComboSectionId('all');
          setSubjectFilter('all');
          setStudentFilter('all');
          setSelectedGuardianStudent(null); // Reset estudiante del apoderado
          setSemester('all');
          setSelectedYear(y);
          try {
            const arr = LocalStorageManager.getTestGradesForYear(y) as TestGrade[]; setGrades(arr);
            setCourses(LocalStorageManager.getCoursesForYear(y));
            setSections(LocalStorageManager.getSectionsForYear(y));
            setSubjects(LocalStorageManager.getSubjectsForYear(y));
    try { const st = LocalStorageManager.getStudentsForYear(y); if (Array.isArray(st)) setUsers(prev => { const others = prev.filter(p => p.role && p.role !== 'student'); return [...st, ...others]; }); } catch {}
            try {
              const assigns = LocalStorageManager.getStudentAssignmentsForYear(y);
              if (Array.isArray(assigns)) setStudentAssignments(assigns);
            } catch {}
          } catch (err) { 
            console.warn('[Calificaciones] Error al cargar datos del año', y, err);
            // NO vaciar setGrades([]) - mantener estado actual
          }
          // Al cambiar año, recargar pendientes en el nuevo contexto
          loadPendingTasks();
          setRefreshTick(t => t + 1);
        }
      }
      // Escuchar cambios en comentarios de tareas para sincronizar calificaciones
      if (e.key === 'smart-student-task-comments') {
        syncTaskGrades();
        setRefreshTick(t => t + 1);
      }
      // Recargar tareas pendientes si se modifican las tareas
      if (e.key === 'smart-student-tasks') {
        // Al cambiar tareas (incluye evaluationResults), sincronizar calificaciones
        syncTaskGrades();
        loadPendingTasks();
        setRefreshTick(t => t + 1);
      }
      // Recargar si se modifican evaluaciones
      if (e.key === 'smart-student-evaluations') {
        loadPendingTasks();
        setRefreshTick(t => t + 1);
      }
      // Resultados de evaluaciones de estudiantes (deben reflejarse como notas)
      if (e.key === 'smart-student-evaluation-results') {
        try { syncTaskGrades(); } catch {}
        loadPendingTasks();
        setRefreshTick(t => t + 1);
      }
      // Reaccionar a creación/edición de Pruebas (historial por usuario)
      if (e.key && e.key.startsWith('smart-student-tests')) {
        loadPendingTasks();
        setRefreshTick(t => t + 1);
      }
      // Reaccionar a revisiones de Pruebas desde el profesor (fuente de verdad para 80/70 exactos)
      if (e.key && e.key.startsWith('smart-student-test-reviews_')) {
        try { syncTaskGrades(); } catch {}
        setRefreshTick(t => t + 1);
      }
      // Actualizar calendario de semestres si cambia desde Admin
      if (e.key && (e.key === SEM_KEY_PREFIX || e.key.startsWith(`${SEM_KEY_PREFIX}-`))) {
        try { setSemestersCfg(JSON.parse(e.newValue || 'null')); setRefreshTick(t => t + 1); } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    // Cargar calendario inicial
    try {
      const specific = localStorage.getItem(semesterKey(selectedYear));
      const legacy = !specific ? localStorage.getItem(SEM_KEY_PREFIX) : null;
      const raw = specific || legacy;
      if (raw) setSemestersCfg(JSON.parse(raw)); else setSemestersCfg(null);
    } catch {}
    // Eventos personalizados del flujo de evaluación/pruebas
    const onEvaluationCompleted = () => {
      try { syncTaskGrades(); } catch {}
      loadPendingTasks();
      setRefreshTick(t => t + 1);
    };
    const onTaskNotificationsUpdated = () => setRefreshTick(t => t + 1);
    const onSQLGradesUpdated = async (e?: any) => {
      const ts = Number((e as CustomEvent)?.detail?.timestamp || Date.now());
      if (ts < (lastGradesEventTsRef.current || 0)) return; // procesar sólo el más reciente
      lastGradesEventTsRef.current = ts;
      if (reloadingGradesRef.current) return;
      // Throttle: evitar recargas demasiado frecuentes (<5s)
      const now = Date.now();
      if (now - (lastGradesReloadAtRef.current || 0) < 5000) {
        return;
      }
      lastGradesReloadAtRef.current = now;
      reloadingGradesRef.current = true;
      
      const detail = (e as CustomEvent)?.detail;
      const skipFirebaseReload = detail?.skipFirebaseReload === true;
      
      console.log('📊 SQL grades updated - refreshing calificaciones...', detail);
      
      if (skipFirebaseReload) {
        console.log('⏭️ skipFirebaseReload=true: Cargando directamente desde LocalStorage (Firebase sincronizará en background)');
        
        // Cargar inmediatamente desde LocalStorage sin intentar Firebase
        try {
          const { LocalStorageManager } = require('@/lib/education-utils');
          const local = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
          const normalized = Array.isArray(local)
            ? local.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }))
            : [];
          console.log(`📥 LocalStorage (caché): ${normalized.length} calificaciones para ${selectedYear}`);
          if (normalized.length > 0) {
            setGrades(normalized);
          } else {
            console.warn(`⚠️ LocalStorage vacío para el año ${selectedYear}`);
          }
        } catch (err) {
          console.warn('⚠️ No se pudo recargar desde LocalStorage:', err);
        }
        
        reloadingGradesRef.current = false;
        setRefreshTick(t => t + 1);
        return;
      }
      
      if (canStartSync()) {
        setSqlFetchDone(false); // Mostrar indicador de carga (si pasa el gate)
      }
      setIsSyncing(true);
      setSqlFetchProgress(10);
      
      // Intentar recargar desde SQL/Firebase (admin siempre, otros roles según useOptimizedQuery)
      let sqlSuccess = false;
      const shouldReloadFromFirebase = user?.role === 'admin' || !useOptimizedQuery;
      if (getGradesByYear && shouldReloadFromFirebase) {
        try {
          console.log(`🔄 Recargando calificaciones para año ${selectedYear} desde SQL/Firebase...`);
          setSqlFetchProgress(30);
          
          const rawSqlGrades = await getGradesByYear(selectedYear);
          
          setSqlFetchProgress(80);
          
          if (rawSqlGrades && Array.isArray(rawSqlGrades) && rawSqlGrades.length > 0) {
            console.log(`✅ Recargadas ${rawSqlGrades.length} calificaciones desde SQL/Firebase`);
            
            // Convertir formato SQL a formato esperado por la UI
            const sqlGrades = rawSqlGrades.map(grade => ({
              ...grade,
              gradedAt: normalizeGradedAt(grade.gradedAt) // Convertir a timestamp seguro (CSV soportado)
            }));
            
            setGrades(sqlGrades);
            sqlSuccess = true;
            setSqlFetchProgress(100);
          } else {
            console.warn(`⚠️ SQL retornó array vacío para el año ${selectedYear}`);
          }
        } catch (error) {
          console.error('❌ Error recargando desde SQL/Firebase:', error);
        }
      }
      
      // Si SQL falló o no trajo datos, intentar LocalStorage
      if (!sqlSuccess) {
        try {
          console.log(`🔄 Fallback: Recargando desde LocalStorage para año ${selectedYear}...`);
          const { LocalStorageManager } = require('@/lib/education-utils');
          const local = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
          const normalized = Array.isArray(local)
            ? local.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }))
            : [];
          console.log(`📥 LocalStorage: ${normalized.length} calificaciones para ${selectedYear}`);
          if (normalized.length > 0) {
            setGrades(normalized);
          } else {
            console.warn(`⚠️ LocalStorage también vacío para el año ${selectedYear}`);
          }
          setSqlFetchProgress(100);
        } catch (err) {
          console.warn('⚠️ No se pudo recargar desde LocalStorage:', err);
        }
      }
      
      setSqlFetchDone(true);
      setIsSyncing(false);
      setTimeout(() => setSqlFetchProgress(0), 500);
      
      setRefreshTick(t => t + 1);
      reloadingGradesRef.current = false;
    };
    const onSQLActivitiesUpdated = async (e?: any) => {
      const ts = Number((e as CustomEvent)?.detail?.timestamp || Date.now());
      if (ts < (lastActsEventTsRef.current || 0)) return;
      lastActsEventTsRef.current = ts;
      if (reloadingActsRef.current) return;
      reloadingActsRef.current = true;
      
      const detail = (e as CustomEvent)?.detail;
      const skipFirebaseReload = detail?.skipFirebaseReload === true;
      
      console.log('🫧 SQL activities updated - refreshing bubbles...', detail);
      
      if (skipFirebaseReload) {
        console.log('⏭️ skipFirebaseReload=true: Usando LocalStorage para actividades (Firebase sincronizará en background)');
        
        // Modo LocalStorage: basta con recalcular pendientes desde LS
        try {
          loadPendingTasks();
          console.log('📥 (local) Pendientes recalculados tras evento de actividades');
        } catch (err) {
          console.warn('⚠️ (local) No se pudieron recargar pendientes:', err);
        }
        
        reloadingActsRef.current = false;
        setRefreshTick(t => t + 1);
        return;
      }
      
      // Recargar actividades y pendientes
      if (getActivitiesByYear) {
        try {
          console.log(`🔄 Recargando actividades para año ${selectedYear}...`);
          const res: any = await (getActivitiesByYear as any)(selectedYear, { courseId: cascadeCourseId || undefined });
          const arr = Array.isArray(res) ? res : Array.isArray(res?.activities) ? res.activities : [];
          if (arr && Array.isArray(arr) && arr.length > 0) {
            console.log(`✅ Recargadas ${arr.length} actividades desde SQL/Firebase`);
            setActivitiesSQL(arr);
            loadPendingTasks();
          } else {
            console.warn(`⚠️ No se encontraron actividades para el año ${selectedYear}`);
            setActivitiesSQL([]);
          }
        } catch (e) {
          console.error('❌ Error recargando actividades:', e);
          setActivitiesSQL([]);
        }
      } else {
        // Modo LocalStorage: basta con recalcular pendientes desde LS
        try {
          loadPendingTasks();
          console.log('📥 (local) Pendientes recalculados tras evento de actividades');
        } catch (err) {
          console.warn('⚠️ (local) No se pudieron recargar pendientes:', err);
        }
      }
      
      setRefreshTick(t => t + 1);
      reloadingActsRef.current = false;
    };
    const onSqlMigrationStarted = (e: any) => {
      try { setSqlMigrating({ years: (e?.detail?.years || []) as number[] }); setSqlMigratedInfo(null); } catch { setSqlMigrating({ years: [] }); }
    };
    const onSqlMigrationCompleted = (e: any) => {
      try { setSqlMigrating(null); setSqlMigratedInfo({ years: (e?.detail?.years || []) as number[], totalInserted: Number(e?.detail?.totalInserted) || 0 }); setRefreshTick(t => t + 1); } catch { setSqlMigrating(null); }
    };
    // Progreso de import SQL (emitted por admin upload modal via Firestore snapshot)
    const onSqlImportProgress = (e: any) => {
      try {
        const d = (e as CustomEvent)?.detail || {};
        const pct = Number(d.percent || 0);
        setSqlFetchProgress(Math.max(0, Math.min(100, pct)));
        // Si llega a 100% o current>=total, marcar como done
        if (pct >= 100 || (Number(d.current || 0) >= Number(d.total || 0) && Number(d.total || 0) > 0)) {
          setSqlFetchDone(true);
          setIsSyncing(false);
          // pequeño reseteo visual
          setTimeout(() => setSqlFetchProgress(0), 800);
        } else {
          // Solo mostrar overlay si pasa el gate; en cualquier caso, marcar syncing activo
          if (canStartSync()) setSqlFetchDone(false);
          setIsSyncing(true);
        }
      } catch (err) {
        // ignore
      }
    };
    
    // Evento para cuando se completa una importación masiva de datos
    const onDataImported = async (e: any) => {
      const detail = (e as CustomEvent)?.detail;
      const skipFirebaseReload = detail?.skipFirebaseReload === true;
      
      console.log('📦 Data imported event received:', detail);
      
      // Si es una importación de calificaciones, recargar automáticamente
      if (detail?.type === 'grades') {
        console.log('🔄 Recargando calificaciones después de importación masiva...');
        
        // Si tiene flag skipFirebaseReload, usar SOLO LocalStorage
        if (skipFirebaseReload) {
          console.log('⏭️ skipFirebaseReload=true: Cargando directamente desde LocalStorage (dataImported)');
          
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            const local = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
            const normalized = Array.isArray(local)
              ? local.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }))
              : [];
            console.log(`📥 LocalStorage (caché - dataImported): ${normalized.length} calificaciones`);
            if (normalized.length > 0) {
              setGrades(normalized);
            }
          } catch (err) {
            console.warn('⚠️ (dataImported) No se pudo recargar desde LocalStorage:', err);
          }
          
          setRefreshTick(t => t + 1);
          return;
        }
        
        // Modo normal: Intentar SQL/Firebase (admin siempre, otros roles según useOptimizedQuery)
        let sqlSuccess = false;
        const shouldReloadFromFirebase = user?.role === 'admin' || !useOptimizedQuery;
        if (getGradesByYear && shouldReloadFromFirebase) {
          try {
            const rawSqlGrades = await getGradesByYear(selectedYear);
            if (rawSqlGrades && Array.isArray(rawSqlGrades) && rawSqlGrades.length > 0) {
              console.log(`✅ Recargadas ${rawSqlGrades.length} calificaciones post-importación desde SQL/Firebase`);
              const sqlGrades = rawSqlGrades.map(grade => ({
                ...grade,
                gradedAt: normalizeGradedAt(grade.gradedAt)
              }));
              setGrades(sqlGrades);
              setSqlFetchDone(true);
              sqlSuccess = true;
            } else {
              console.warn(`⚠️ SQL/Firebase retornó vacío post-importación`);
            }
          } catch (error) {
            console.error('❌ Error recargando desde SQL/Firebase post-importación:', error);
          }
        }
        
        // Fallback a LocalStorage si SQL no funcionó
        if (!sqlSuccess) {
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            const local = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
            const normalized = Array.isArray(local)
              ? local.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }))
              : [];
            console.log(`📥 (post-import) Fallback LocalStorage: ${normalized.length} calificaciones`);
            if (normalized.length > 0) {
              setGrades(normalized);
            }
          } catch (err) {
            console.warn('⚠️ (post-import) No se pudo recargar desde LocalStorage:', err);
          }
        }
        
        // Recargar actividades (intentar siempre, sin flag)
        if (getActivitiesByYear) {
          try {
            const res: any = await (getActivitiesByYear as any)(selectedYear, { courseId: cascadeCourseId || undefined });
            const arr = Array.isArray(res) ? res : Array.isArray(res?.activities) ? res.activities : [];
            if (arr && Array.isArray(arr)) {
              console.log(`✅ Recargadas ${arr.length} actividades post-importación`);
              setActivitiesSQL(arr);
              loadPendingTasks();
            }
          } catch (e) {
            console.error('❌ Error recargando actividades post-importación:', e);
          }
        }
        
        setRefreshTick(t => t + 1);
      }
    };
    // Refuerzo: algunas rutas emiten 'dataUpdated' en vez de 'dataImported'
    const onDataUpdated = async (e: any) => {
      const detail = (e as CustomEvent)?.detail;
      const skipFirebaseReload = detail?.skipFirebaseReload === true;
      
      console.log('📦 Data updated event received:', detail);
      
      if (detail?.type === 'grades') {
        console.log('🔄 Recargando calificaciones después de dataUpdated...');
        
        // Si tiene flag skipFirebaseReload, usar SOLO LocalStorage
        if (skipFirebaseReload) {
          console.log('⏭️ skipFirebaseReload=true: Cargando directamente desde LocalStorage (dataUpdated)');
          
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            const local = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
            const normalized = Array.isArray(local)
              ? local.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }))
              : [];
            console.log(`📥 LocalStorage (caché - dataUpdated): ${normalized.length} calificaciones`);
            if (normalized.length > 0) {
              setGrades(normalized);
            }
          } catch (err) {
            console.warn('⚠️ (dataUpdated) No se pudo recargar desde LocalStorage:', err);
          }
          
          setRefreshTick(t => t + 1);
          return;
        }
        
        // Modo normal: intentar SQL/Firebase (admin siempre, otros roles según useOptimizedQuery)
        let sqlSuccess = false;
        const shouldReloadFromFirebase = user?.role === 'admin' || !useOptimizedQuery;
        if (getGradesByYear && shouldReloadFromFirebase) {
          try {
            const rawSqlGrades = await getGradesByYear(selectedYear);
            if (Array.isArray(rawSqlGrades) && rawSqlGrades.length > 0) {
              console.log(`✅ Recargadas ${rawSqlGrades.length} calificaciones desde SQL/Firebase (dataUpdated)`);
              const sqlGrades = rawSqlGrades.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }));
              setGrades(sqlGrades);
              setSqlFetchDone(true);
              sqlSuccess = true;
            } else {
              console.warn(`⚠️ SQL/Firebase retornó vacío (dataUpdated)`);
            }
          } catch (err) {
            console.error('❌ Error recargando desde SQL/Firebase (dataUpdated):', err);
          }
        }
        
        // Fallback a LocalStorage si SQL no funcionó
        if (!sqlSuccess) {
          try {
            const { LocalStorageManager } = require('@/lib/education-utils');
            const local = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];
            const normalized = Array.isArray(local)
              ? local.map(g => ({ ...g, gradedAt: normalizeGradedAt(g.gradedAt) }))
              : [];
            console.log(`📥 (dataUpdated) Fallback LocalStorage: ${normalized.length} calificaciones`);
            if (normalized.length > 0) {
              setGrades(normalized);
            }
          } catch (err) {
            console.warn('⚠️ (dataUpdated) No se pudo recargar desde LocalStorage:', err);
          }
        }
        
        // Recargar actividades (intentar siempre)
        if (getActivitiesByYear) {
          try {
            const acts: any = await (getActivitiesByYear as any)(selectedYear, { courseId: cascadeCourseId || undefined });
            const arr = Array.isArray(acts) ? acts : Array.isArray(acts?.activities) ? acts.activities : [];
            if (Array.isArray(arr)) {
              setActivitiesSQL(arr);
              loadPendingTasks();
            }
          } catch (err) {
            console.error('❌ Error recargando actividades (dataUpdated):', err);
          }
        }
        
        setRefreshTick(t => t + 1);
      }
    };
    
    window.addEventListener('evaluationCompleted', onEvaluationCompleted as any);
    window.addEventListener('taskNotificationsUpdated', onTaskNotificationsUpdated as any);
  window.addEventListener('sqlGradesUpdated', onSQLGradesUpdated as any);
  window.addEventListener('sqlActivitiesUpdated', onSQLActivitiesUpdated as any);
  window.addEventListener('sqlMigrationStarted', onSqlMigrationStarted as any);
  window.addEventListener('sqlMigrationCompleted', onSqlMigrationCompleted as any);
    window.addEventListener('dataImported', onDataImported as any);
    window.addEventListener('dataUpdated', onDataUpdated as any);
  window.addEventListener('sqlImportProgress', onSqlImportProgress as any);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('evaluationCompleted', onEvaluationCompleted as any);
      window.removeEventListener('taskNotificationsUpdated', onTaskNotificationsUpdated as any);
      window.removeEventListener('sqlGradesUpdated', onSQLGradesUpdated as any);
      window.removeEventListener('sqlActivitiesUpdated', onSQLActivitiesUpdated as any);
      window.removeEventListener('sqlMigrationStarted', onSqlMigrationStarted as any);
      window.removeEventListener('sqlMigrationCompleted', onSqlMigrationCompleted as any);
      window.removeEventListener('dataImported', onDataImported as any);
      window.removeEventListener('dataUpdated', onDataUpdated as any);
      window.removeEventListener('sqlImportProgress', onSqlImportProgress as any);
    };
  }, [selectedYear, refreshTick, isSQLConnected, getGradesByYear, getActivitiesByYear]);

  // 🔥 NUEVO: Efecto para consultas optimizadas cuando cambian los filtros
  useEffect(() => {
    // 🔧 FIX: Deshabilitar para profesores cuando ya hay filtros completos activos
    // El filtrado normal en filteredGrades ya maneja correctamente el caso de profesor
    if (user?.role === 'teacher') {
      const hasCompleteContext = semester !== 'all' && (levelFilter !== 'all' || cascadeSectionId || comboSectionId !== 'all');
      if (hasCompleteContext) {
        console.log('⏭️ [Optimized Query] Deshabilitado para profesor con filtros completos - usando filtrado normal');
        setIsUsingOptimizedData(false);
        return;
      }
    }
    
    // Ejecutar si está habilitada la optimización y existe el método de consulta (independiente de isSQLConnected)
    if (!useOptimizedQuery || !getGradesByCourseAndSection) {
      console.log('⏭️ [Optimized Query] Deshabilitado o método no disponible');
      return;
    }
    
    // Solo ejecutar si hay una sección específica seleccionada (no "all") y semestre definido
    if (semester === 'all') {
      console.log('⏭️ [Optimized Query] Selecciona un semestre para consultar Firebase');
      setIsUsingOptimizedData(false);
      return;
    }
    
    // Solo ejecutar si hay una sección específica seleccionada (no "all")
    if (comboSectionId === 'all' && !cascadeSectionId) {
      console.log('⏭️ [Optimized Query] Sin sección específica, usando datos completos del año');
      setIsUsingOptimizedData(false);
      return;
    }
    
    // 🔥 NUEVO: Solo ejecutar consulta si hay asignatura seleccionada (evita cargar todos los datos)
    const hasSubjectFilter = (subjectFilter && subjectFilter !== 'all') || (cascadeSubject && cascadeSubject !== '');
    if (!hasSubjectFilter) {
      console.log('⏭️ [Optimized Query] Selecciona una asignatura para consultar Firebase (optimización de rendimiento)');
      setIsUsingOptimizedData(false);
      // NO cargar datos hasta que se seleccione asignatura
      return;
    }
    
    // Determinar la sección activa (prioritario comboSectionId, fallback cascadeSectionId)
    const activeSectionId = comboSectionId !== 'all' ? comboSectionId : cascadeSectionId;
    if (!activeSectionId) {
      console.log('⏭️ [Optimized Query] Sin sección activa determinada');
      return;
    }
    
    // Extraer courseId y sectionId del combo
    const section = sections.find(s => String(s.id) === String(activeSectionId));
    if (!section) {
      console.warn('⚠️ [Optimized Query] No se encontró la sección:', activeSectionId);
      return;
    }
    
    const courseId = String(section.courseId);
    // Derivar letra real de la sección para usarla como filtro en Firebase (sectionId de los documentos)
    const getLetter = (name?: string) => {
      if (!name) return null as string | null;
      const t = String(name).trim();
      if (/^[A-Za-zÑñ]$/.test(t)) return t.toLowerCase();
      const m = t.match(/([A-Za-zÑñ])\s*$/);
      return (m?.[1] || '').toLowerCase() || null;
    };
    const sectionLetter = getLetter(section.name);
  // Para evitar mismatches por normalización de subjectId en Firebase, consultamos sin filtrar por asignatura
  // y dejamos que la UI aplique el filtro con su normalización robusta.
  const subjectId = null;
    
    console.log('🚀 [Optimized Query] Ejecutando consulta optimizada a Firebase:', {
      courseId,
      sectionId: sectionLetter || activeSectionId,
      year: selectedYear,
      subjectId
    });
    
    setIsLoadingOptimized(true);
    setIsUsingOptimizedData(false); // Resetear mientras carga
    setIsSyncing(true);
    if (canStartSync()) {
      setSqlFetchDone(false); // Mostrar indicador de carga (si pasa gate)
    }
    setSqlFetchProgress(10);
    
    // Importante: pasamos la LETRA como sectionId para que el backend filtre por "a"/"b".
    getGradesByCourseAndSection(courseId, sectionLetter || null, selectedYear, subjectId)
      .then((optimizedGrades) => {
        console.log(`✅ [Optimized Query] Recibidas ${optimizedGrades.length} calificaciones de Firebase`);
        
        setSqlFetchProgress(80);
        
        // 🎓 FILTRO PARA ESTUDIANTES: Solo mostrar sus calificaciones
        let filteredGrades = optimizedGrades;
        if (user?.role === 'student' || user?.role === 'estudiante') {
          console.log(`🎓 [Optimized Query - Estudiante] Filtrando calificaciones para: ${user.username}`);
          
          const studentIds = [
            user.id,
            user.rut,
            user.username
          ].filter(Boolean);
          
          filteredGrades = optimizedGrades.filter((g: any) => {
            const matchId = studentIds.includes(String(g.studentId));
            const matchUsername = String(g.studentUsername) === user.username;
            const matchName = String(g.studentName || '').toLowerCase().includes((user.displayName || '').toLowerCase());
            return matchId || matchUsername || matchName;
          });
          
          console.log(`✅ [Optimized Query - Estudiante] Filtradas ${filteredGrades.length} de ${optimizedGrades.length} calificaciones`);
        }
        
        // 🎓 FILTRO PARA APODERADOS: Solo mostrar calificaciones del estudiante seleccionado
        if (user?.role === 'guardian' && selectedGuardianStudent) {
          console.log(`👨‍👩‍👧 [Optimized Query - Apoderado] Filtrando calificaciones para estudiante: ${selectedGuardianStudent}`);
          
          // Buscar el estudiante seleccionado para obtener sus identificadores
          const selectedStudent = guardianStudents.find(s => String(s.id) === String(selectedGuardianStudent));
          const studentIds = selectedStudent ? [
            selectedStudent.id,
            selectedStudent.rut,
            selectedStudent.username
          ].filter(Boolean) : [selectedGuardianStudent];
          
          filteredGrades = optimizedGrades.filter((g: any) => {
            const matchId = studentIds.includes(String(g.studentId));
            const matchUsername = selectedStudent?.username && String(g.studentUsername) === selectedStudent.username;
            const matchName = selectedStudent?.displayName && String(g.studentName || '').toLowerCase().includes((selectedStudent.displayName || '').toLowerCase());
            return matchId || matchUsername || matchName;
          });
          
          console.log(`✅ [Optimized Query - Apoderado] Filtradas ${filteredGrades.length} de ${optimizedGrades.length} calificaciones`);
        }
        
        // Convertir formato si es necesario
        const formatted = filteredGrades.map(g => ({
          ...g,
          gradedAt: normalizeGradedAt(g.gradedAt)
        }));
        
        // 🔧 FIX: NO sobrescribir si el resultado optimizado está vacío pero ya había calificaciones cargadas
        // Esto evita que las calificaciones desaparezcan cuando el query optimizado falla o retorna vacío
        if (formatted.length > 0 || grades.length === 0) {
          setGrades(formatted as any);
          setIsUsingOptimizedData(true); // Marcar que estamos usando datos optimizados
          console.log(`✅ [Optimized Query] ${formatted.length} calificaciones cargadas y mostradas`);
        } else {
          console.warn(`⚠️ [Optimized Query] Query retornó vacío pero ya hay ${grades.length} calificaciones cargadas. Manteniendo estado actual.`);
          setIsUsingOptimizedData(false); // No usar datos optimizados si están vacíos
        }
        
        setIsLoadingOptimized(false);
        setSqlFetchProgress(100);
  setSqlFetchDone(true);
  setIsSyncing(false);
        
        // No sincronizar a LocalStorage para consultas optimizadas (son datos filtrados)
      })
      .catch((error) => {
        console.error('❌ [Optimized Query] Error:', error);
        setIsUsingOptimizedData(false);
        setIsLoadingOptimized(false);
        setSqlFetchProgress(0);
        setSqlFetchDone(true);
        setIsSyncing(false);
      });
      
  }, [useOptimizedQuery, comboSectionId, cascadeSectionId, subjectFilter, cascadeSubject, selectedYear, sections, getGradesByCourseAndSection, isSQLConnected, user, selectedGuardianStudent, guardianStudents]);

  // Resetear la bandera de carga inicial cuando cambie el año
  useEffect(() => {
    initialLoadDoneRef.current = false;
    console.log(`🔄 Año cambiado a ${selectedYear}, reseteando bandera de carga inicial`);
  }, [selectedYear]);

  // 🎓 APODERADO: Cargar estudiantes asignados
  useEffect(() => {
    if (!user || user.role !== 'guardian') {
      setGuardianStudents([]);
      setSelectedGuardianStudent(null);
      return;
    }
    
    console.log(`👨‍👩‍👧 [Guardian] Cargando estudiantes asignados para: ${user.username}`);
    
    let assignedStudentIds: string[] = [];
    
    // Prioridad 1: Buscar en smart-student-guardians-{year} (datos de carga masiva)
    const guardiansForYear = loadJson<any[]>(`smart-student-guardians-${selectedYear}`, []);
    const guardianFromYear = guardiansForYear.find((g: any) => 
      g.username?.toLowerCase() === user.username?.toLowerCase() ||
      g.id === (user as any).id
    );
    
    if (guardianFromYear?.studentIds && guardianFromYear.studentIds.length > 0) {
      assignedStudentIds = guardianFromYear.studentIds;
      console.log(`👨‍👩‍👧 [Guardian] studentIds desde guardiansForYear:`, assignedStudentIds);
    }
    
    // Prioridad 2: Buscar en smart-student-guardian-student-relations-{year}
    if (assignedStudentIds.length === 0) {
      let guardianRelations = loadJson<any[]>(`smart-student-guardian-student-relations-${selectedYear}`, []);
      if (guardianRelations.length === 0) {
        guardianRelations = loadJson<any[]>('smart-student-guardian-student-relations', []);
      }
      
      assignedStudentIds = guardianRelations
        .filter((rel: any) => rel.guardianId === (user as any).id || rel.guardianUsername === user.username)
        .map((rel: any) => rel.studentId);
      
      if (assignedStudentIds.length > 0) {
        console.log(`👨‍👩‍👧 [Guardian] studentIds desde relations:`, assignedStudentIds);
      }
    }
    
    // Prioridad 3: Buscar en smart-student-users (fullUserData.studentIds)
    if (assignedStudentIds.length === 0) {
      const usersData = loadJson<any[]>('smart-student-users', []);
      const fullUserData = usersData.find((u: any) => 
        u.username?.toLowerCase() === user.username?.toLowerCase()
      );
      if (fullUserData?.studentIds && fullUserData.studentIds.length > 0) {
        assignedStudentIds = fullUserData.studentIds;
        console.log(`👨‍👩‍👧 [Guardian] studentIds desde smart-student-users:`, assignedStudentIds);
      }
    }
    
    // Buscar los objetos de estudiante completos
    const allStudents = users.filter(u => u?.role === 'student' || u?.role === 'estudiante');
    const myStudents = allStudents.filter(student => {
      const sid = String(student.id || '');
      const susername = String(student.username || '');
      const srut = String(student.rut || '');
      return assignedStudentIds.some(aid => 
        String(aid) === sid || 
        String(aid) === susername || 
        String(aid) === srut
      );
    });
    
    console.log(`👨‍👩‍👧 [Guardian] Estudiantes encontrados: ${myStudents.length}`, myStudents.map(s => s.displayName || s.name));
    setGuardianStudents(myStudents);
    
    // Si solo hay un estudiante, seleccionarlo automáticamente
    if (myStudents.length === 1 && !selectedGuardianStudent) {
      setSelectedGuardianStudent(String(myStudents[0].id));
    }
  }, [user, selectedYear, users]);

  // 🎓 APODERADO: Auto-configurar filtros cuando se selecciona un estudiante
  useEffect(() => {
    if (!user || user.role !== 'guardian' || !selectedGuardianStudent) {
      return;
    }
    
    // Helper local para determinar nivel del curso
    const getCourseLevelLocal = (name?: string): 'basica' | 'media' | null => {
      if (!name) return null;
      const n = name.trim().toLowerCase();
      if (n.includes('básica') || n.includes('basico') || n.includes('básico') || n.includes('basica')) return 'basica';
      if (n.includes('medio') || n.includes('media')) return 'media';
      const match = n.match(/^(\d{1,2})/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= 1 && num <= 8) return 'basica';
        if (num >= 9 && num <= 12) return 'media';
      }
      return null;
    };
    
    // Buscar el estudiante seleccionado
    const student = guardianStudents.find(s => String(s.id) === String(selectedGuardianStudent));
    if (!student) return;
    
    console.log(`👨‍👩‍👧 [Guardian] Configurando filtros para estudiante:`, student.displayName || student.name);
    
    // Buscar la asignación del estudiante
    const studentAssign = studentAssignments.find(a => 
      String(a.studentId) === String(student.id) || 
      String(a.studentUsername) === String(student.username)
    );
    
    if (!studentAssign) {
      console.warn(`⚠️ [Guardian] No se encontró asignación para el estudiante ${student.id}`);
      return;
    }
    
    console.log(`👨‍👩‍👧 [Guardian] Asignación encontrada:`, studentAssign);
    
    // Obtener sección y curso
    const studentSection = sections.find(s => String(s.id) === String(studentAssign.sectionId));
    if (!studentSection) {
      console.warn(`⚠️ [Guardian] No se encontró sección ${studentAssign.sectionId}`);
      return;
    }
    
    const studentCourse = courses.find(c => String(c.id) === String(studentSection.courseId));
    if (!studentCourse) {
      console.warn(`⚠️ [Guardian] No se encontró curso ${studentSection.courseId}`);
      return;
    }
    
    // Determinar nivel
    const level = getCourseLevelLocal(studentCourse.name);
    console.log(`👨‍👩‍👧 [Guardian] Auto-configurando: Nivel=${level}, Curso=${studentCourse.name}, Sección=${studentSection.name}`);
    
    // Configurar filtros automáticamente
    if (level) setLevelFilter(level);
    setCascadeCourseId(studentCourse.id);
    setCascadeSectionId(studentSection.id);
    setComboSectionId(studentSection.id);
    setStudentFilter(String(student.id));
    // No seleccionar asignatura para mostrar todas
    setCascadeSubject(null);
    setSubjectFilter('all');
    
    // 🎓 Auto-seleccionar el semestre actual para que el apoderado vea las calificaciones de inmediato
    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 1-12
    // Primer semestre: marzo-julio (meses 3-7), Segundo semestre: agosto-diciembre (meses 8-12)
    const autoSem = currentMonth >= 8 ? '2' : '1';
    console.log(`👨‍👩‍👧 [Guardian] Auto-seleccionando semestre ${autoSem} (mes actual: ${currentMonth})`);
    setSemester(autoSem);
    
  }, [selectedGuardianStudent, guardianStudents, studentAssignments, sections, courses, user]);

  // Semestre por defecto: al entrar y solo una vez (para el año actual)
  useEffect(() => {
    try {
      if (autoSemesterDone) return;
      const now = new Date();
      const currentYear = now.getFullYear();
      if (selectedYear !== currentYear) return; // solo auto-aplica en el año actual
      if (semester !== 'all') { setAutoSemesterDone(true); return; }
      const sameDayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const today = sameDayFloor(now);
      const parseYmdLocal = (ymd?: string) => {
        if (!ymd) return undefined as unknown as Date | undefined;
        const [y, m, d] = String(ymd).split('-').map(Number);
        if (!y || !m || !d) return undefined as unknown as Date | undefined;
        return new Date(y, (m || 1) - 1, d || 1);
      };
      const startEndFor = (cfg: any, which: '1' | '2') => {
        const start = parseYmdLocal(which === '1' ? cfg?.first?.start : cfg?.second?.start);
        const end = parseYmdLocal(which === '1' ? cfg?.first?.end : cfg?.second?.end);
        return { start, end } as { start?: Date; end?: Date };
      };
      let def: '1' | '2' = '1';
      if (semestersCfg) {
        const s1 = startEndFor(semestersCfg, '1');
        const s2 = startEndFor(semestersCfg, '2');
        if (s1.start && s1.end && today >= s1.start && today <= s1.end) def = '1';
        else if (s2.start && s2.end && today >= s2.start && today <= s2.end) def = '2';
        else {
          // Fallback por mes si hoy no cae dentro de los rangos configurados
          const m = now.getMonth();
          def = m <= 5 ? '1' : '2'; // Ene-Jun => 1; Jul-Dic => 2
        }
      } else {
        const m = now.getMonth();
        def = m <= 5 ? '1' : '2';
      }
      setSemester(def);
      setAutoSemesterDone(true);
    } catch {}
  }, [autoSemesterDone, semester, semestersCfg, selectedYear]);

  // Progreso visual del overlay inicial (solo si estudiante)
  useEffect(() => {
    if (user?.role !== 'student') { setShowInitialOverlay(false); return; }
    if (!showInitialOverlay) return;
    let raf: number | null = null;
    let start: number | null = null;
    const animate = (ts: number) => {
      if (start == null) start = ts;
      const elapsed = ts - start;
      // Avanza suave hasta 90% en ~4s
      const target = Math.min(90, Math.floor((elapsed / 4000) * 90));
      setOverlayProgress(p => (p < target ? target : p));
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    // Fallback: ocultar si demora demasiado (2s para UI rápida)
    const to = setTimeout(() => setShowInitialOverlay(false), 2000);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(to);
    };
  }, [user, showInitialOverlay]);

  // Ocultar overlay cuando la vista mínima esté lista (estudiante: sección+semestre)
  // NO esperar SQL para mejorar percepción de velocidad
  useEffect(() => {
    if (user?.role !== 'student') return;
    if (!showInitialOverlay) return;
    const semOK = semester === '1' || semester === '2';
    const sectionOK = Boolean(cascadeSectionId || (comboSectionId && comboSectionId !== 'all'));
    
    // Cerrar overlay apenas tengamos filtros básicos (no esperar SQL)
    if (semOK && sectionOK) {
      // pulir progreso a 100% y cerrar rápido
      setOverlayProgress(100);
      const t = setTimeout(() => setShowInitialOverlay(false), 100);
      return () => clearTimeout(t);
    }
  }, [user, showInitialOverlay, semester, cascadeSectionId, comboSectionId]);

  // Cargar actividades SQL cuando cambian año o conexión (EN SEGUNDO PLANO)
  useEffect(() => {
    const loadActivities = async () => {
      try {
        if (!isSQLConnected || !getActivitiesByYear) { 
          setActivitiesSQL([]); 
          return; 
        }
        
        // Carga en segundo plano sin bloquear
        console.log(`🔄 Cargando actividades SQL en segundo plano para ${selectedYear}...`);
        // Si hay curso en cascada seleccionado, úsalo como filtro para reducir lecturas en Firestore
        const acts = await (getActivitiesByYear as any)(selectedYear, {
          courseId: cascadeCourseId || undefined
        });
        
        // Validar que acts sea un array válido
        if (!acts || !Array.isArray(acts)) {
          console.warn('⚠️ getActivitiesByYear returned invalid format:', acts);
          setActivitiesSQL([]);
          return;
        }
        setActivitiesSQL(acts);
      } catch (e) {
        console.warn('No se pudieron cargar actividades SQL:', e);
        setActivitiesSQL([]);
      }
    };
    loadActivities();
  }, [isSQLConnected, selectedYear, getActivitiesByYear, cascadeCourseId]);

  // Generar calificaciones derivadas de evaluaciones existentes al cargar o cambiar de año
  useEffect(() => {
    // Diferir también al cambiar de año para evitar jank si hay grandes volúmenes
    const t = setTimeout(() => { try { syncTaskGrades(); } catch {} }, 0);
    return () => clearTimeout(t);
  }, [selectedYear]);

  // Función para sincronizar calificaciones desde tareas/comentarios del profesor
  const syncTaskGrades = () => {
    try {
      console.log('🔄 Sincronizando calificaciones de tareas...');
      const { LocalStorageManager } = require('@/lib/education-utils');
      
      // Cargar datos necesarios
  const tasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
      const comments = JSON.parse(localStorage.getItem('smart-student-task-comments') || '[]');
  const currentGrades: TestGrade[] = LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[];

      // Si hay conexión SQL activa, evitamos generar calificaciones locales
      // porque la fuente principal es SQL o el fallback ya se resolvió arriba.
      // IMPORTANTE: No tocar el estado actual de grades para no interferir con la carga SQL.
      if (isSQLConnected) {
        console.log('⏭️ SQL conectado: omito syncTaskGrades local (preservando estado actual)');
        return;
      }

      // Evitar trabajo pesado si ya existen notas y la cola es grande
      const heavy = (Array.isArray(tasks) ? tasks.length : 0) + (Array.isArray(comments) ? comments.length : 0) > 5000;
      if (Array.isArray(currentGrades) && currentGrades.length > 0 && heavy) {
        console.log(`⏭️ Omitiendo sync pesado: ${currentGrades.length} notas ya cargadas, tareas+comentarios=${(tasks?.length||0)+(comments?.length||0)}`);
        return;
      }
      const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const subjects = JSON.parse(localStorage.getItem('smart-student-subjects') || '[]');
      const studentAssignments = JSON.parse(localStorage.getItem(`smart-student-student-assignments-${selectedYear}`) || '[]');
      const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');

      // Índices auxiliares
      const taskById = new Map<string, any>();
      Array.isArray(tasks) && tasks.forEach((t: any) => taskById.set(String(t.id), t));
      const userById = new Map<string, any>();
      Array.isArray(users) && users.forEach((u: any) => userById.set(String(u.id), u));
      const subjectByNameOrId = (task: any) => {
        const found = subjects.find((s: any) => String(s.id) === String(task?.subjectId) || String(s.name) === String(task?.subject));
        return found?.id || task?.subject || null;
      };
      const sectionForStudent = (studentId: string) => {
        const asg = studentAssignments.find((a: any) => String(a.studentId) === String(studentId));
        return asg?.sectionId || null;
      };
      
  const newGrades: TestGrade[] = [];
  let replacements = 0;
      const queued = new Set<string>();

      // 1) Nueva fuente principal: comentarios de entrega con grade numérico (calificación del profesor)
      const gradedSubmissions = Array.isArray(comments)
        ? comments.filter((c: any) => c && c.taskId && (c.grade !== undefined && c.grade !== null) && !isNaN(Number(c.grade)))
        : [];

      console.log(`📝 Encontradas ${gradedSubmissions.length} entregas calificadas (comentarios con grade)`);

  gradedSubmissions.forEach((c: any) => {
        try {
          const task = taskById.get(String(c.taskId));
          if (!task) return;
          const student = userById.get(String(c.studentId)) || users.find((u: any) => String(u.username) === String(c.studentUsername));
          if (!student) return;
          const score = Math.max(0, Math.min(100, Number(toPercentFromConfigured(Number(c.grade)))));
          const subjId = subjectByNameOrId(task);
          const courseId = task.courseId || task.course || null;
          const secId = task.sectionId || sectionForStudent(String(student.id));
          const key = `${task.id}-${student.id}`;
          const existing = currentGrades.find((g: any) => String(g.testId) === String(task.id) && String(g.studentId) === String(student.id));
          const base: TestGrade = {
            id: key,
            testId: String(task.id),
            studentId: String(student.id),
            studentName: student.displayName || student.name || student.username,
            score: Math.round(score * 100) / 100,
            courseId: courseId ? String(courseId) : null,
            sectionId: secId ? String(secId) : null,
            subjectId: subjId,
            title: task.title,
            gradedAt: new Date(c.reviewedAt || c.timestamp || Date.now()).getTime(),
          };
          if (!existing) {
            if (!queued.has(base.id)) { newGrades.push(base); queued.add(base.id); }
          } else {
            // Actualizar si cambió el puntaje o la fecha de revisión es más reciente
            const newer = (c.reviewedAt ? new Date(c.reviewedAt).getTime() : Date.now());
            if (Number(existing.score) !== base.score || newer > Number(existing.gradedAt)) {
              // Reemplazar existente
              const idx = currentGrades.findIndex((g: any) => g.testId === existing.testId && g.studentId === existing.studentId);
              if (idx >= 0) {
                currentGrades[idx] = { ...existing, ...base };
                replacements++;
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Error procesando entrega calificada:', err);
        }
      });

      // 2) Compatibilidad: comentarios de profesor con calificación en texto (legacy)
      try {
        const gradeComments = comments.filter((comment: any) => {
          const text = (comment.content || comment.comment || '').toLowerCase();
          const hasGrade = /nota|calificaci[oó]n|puntaje|punto|\/\d+|\d+\/\d+|\d+\s*pts|\d+\s*puntos|\d+\s*%/i.test(text);
          const isFromTeacher = comment.authorRole === 'teacher' || comment.authorRole === 'profesor' || comment.userRole === 'teacher';
          return hasGrade && isFromTeacher;
        });
        console.log(`📝 (Compat) Comentarios con texto de calificación: ${gradeComments.length}`);
        gradeComments.forEach((comment: any) => {
          try {
            const text = String(comment.content || comment.comment || '');
            const patterns = [
              /nota[:\s]*(\d+(?:\.\d+)?)/i,
              /calificaci[oó]n[:\s]*(\d+(?:\.\d+)?)/i,
              /puntaje[:\s]*(\d+(?:\.\d+)?)/i,
              /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/,
              /(\d+(?:\.\d+)?)\s*pts/i,
              /(\d+(?:\.\d+)?)\s*puntos/i,
              /(\d+(?:\.\d+)?)\s*%/,
              /^(\d+(?:\.\d+)?)$/
            ];
            let score: number | null = null;
            for (const pattern of patterns) {
              const m = text.match(pattern);
              if (m) {
                if (pattern.source.includes('\\/')) {
                  // Formato fraccional "X / Y" => porcentaje
                  const num = parseFloat(m[1]);
                  const den = parseFloat(m[2]);
                  score = den > 0 ? (num / den) * 100 : null;
                } else if (/\%/.test(pattern.source)) {
                  // Ya es porcentaje explícito
                  score = parseFloat(m[1]);
                } else {
                  // Número suelto: interpretar cuidadosamente
                  let raw = parseFloat(m[1]);
                  if (!isFinite(raw)) { score = null; break; }
                  // Casos:
                  // - 0..1 => 0-1: tratar como 0-1 => *100
                  // - >1 y <=10 => escala 0-10 => *10
                  // - 10..100 => ya es porcentaje
                  // - >100 => probablemente 0..1000 => dividir por 10 (límite 100)
                  score = toPercentFromConfigured(raw) ?? undefined as any;
                }
                break;
              }
            }
            if (score == null || !isFinite(score)) return;
            const task = taskById.get(String(comment.taskId));
            if (!task) return;
            const student = userById.get(String(comment.studentId)) || users.find((u: any) => String(u.username) === String(comment.studentUsername));
            if (!student) return;
            const subjId = subjectByNameOrId(task);
            const courseId = task.courseId || task.course || null;
            const secId = task.sectionId || sectionForStudent(String(student.id));
            const key = `${task.id}-${student.id}`;
            if (!currentGrades.some((g: any) => String(g.testId) === String(task.id) && String(g.studentId) === String(student.id)) && !queued.has(key)) {
              newGrades.push({
                id: key,
                testId: String(task.id),
                studentId: String(student.id),
                studentName: student.displayName || student.name || student.username,
                score: Math.round(score * 100) / 100,
                courseId: courseId ? String(courseId) : null,
                sectionId: secId ? String(secId) : null,
                subjectId: subjId,
                title: task.title,
                gradedAt: new Date(comment.reviewedAt || comment.timestamp || Date.now()).getTime(),
              });
              queued.add(key);
            }
          } catch {/* ignore one off */}
        });
      } catch {/* legacy path errors ignored */}

  // Integración de resultados de Evaluación en tareas: task.evaluationResults (inmediato por estudiante)
      try {
        tasks.forEach((task: any) => {
          const results = task?.evaluationResults;
          if (!results || typeof results !== 'object') return;
          Object.entries(results as Record<string, any>).forEach(([studentUsername, res]) => {
            try {
              const total = Number(res?.totalQuestions) || 0;
              const rawScore = Number(res?.score);
              let pct = total > 0 ? (rawScore / total) * 100 : Number(res?.completionPercentage) || 0;
              if (!isFinite(pct)) return;
              pct = Math.max(0, Math.min(100, pct));
              const student = users.find((u: any) => String(u.username) === String(studentUsername));
              if (!student) return;
              const subject = subjects.find((s: any) => s.name === task.subject || String(s.id) === String(task.subjectId));
              const exists = currentGrades.some((g: any) => g.testId === task.id && String(g.studentId) === String(student.id));
              if (exists) return;
              const newGrade: TestGrade = {
                id: `${task.id}-${student.id}`,
                testId: task.id,
                studentId: student.id,
                studentName: student.displayName || student.name || student.username,
                score: Math.round(pct * 100) / 100,
                courseId: task.courseId || null,
                sectionId: task.sectionId || null,
                subjectId: subject?.id || task.subject || null,
        title: task.title,
        gradedAt: new Date(res?.completedAt || Date.now()).getTime(),
              };
              if (!queued.has(newGrade.id)) {
                newGrades.push(newGrade);
                queued.add(newGrade.id);
              }
            } catch {/* row error */}
          });
        });
      } catch (err) {
        console.warn('Error integrando evaluationResults:', err);
      }

  // Integración directa desde smart-student-evaluation-results (inmediato por estudiante)
      try {
        const evalResults = JSON.parse(localStorage.getItem('smart-student-evaluation-results') || '[]');
        if (Array.isArray(evalResults)) {
          evalResults.forEach((res: any) => {
            try {
              const task = taskById.get(String(res?.taskId));
              const student = userById.get(String(res?.studentId)) || users.find((u: any) => String(u.username) === String(res?.studentUsername));
              if (!task || !student) return;
              const pctRaw = Number(res?.percentage);
              if (!isFinite(pctRaw)) return;
              const pct = Math.max(0, Math.min(100, pctRaw));
              const subjId = subjectByNameOrId(task);
              const courseId = task.courseId || task.course || null;
              const secId = task.sectionId || sectionForStudent(String(student.id));
              const key = `${task.id}-${student.id}`;
              const base: TestGrade = {
                id: key,
                testId: String(task.id),
                studentId: String(student.id),
                studentName: student.displayName || student.name || student.username,
                score: Math.round(pct * 100) / 100,
                courseId: courseId ? String(courseId) : null,
                sectionId: secId ? String(secId) : null,
                subjectId: subjId,
                title: task.title,
                gradedAt: new Date(res?.completedAt || Date.now()).getTime(),
              };
              const existing = currentGrades.find((g: any) => String(g.testId) === String(task.id) && String(g.studentId) === String(student.id));
              if (!existing) {
                if (!queued.has(base.id)) { newGrades.push(base); queued.add(base.id); }
              } else {
                if (Number(existing.score) !== base.score || Number(existing.gradedAt) < base.gradedAt) {
                  const idx = currentGrades.findIndex((g: any) => g.testId === existing.testId && g.studentId === existing.studentId);
                  if (idx >= 0) { currentGrades[idx] = { ...existing, ...base }; replacements++; }
                }
              }
            } catch {/* one result error */}
          });
        }
      } catch (err) {
        console.warn('Error integrando smart-student-evaluation-results:', err);
      }

      // 2.5) Asegurar evaluaciones: si hay tareas de tipo evaluacion con evaluationResults embebidos pero no se generó nota (por timing), crearla.
      try {
        tasks.filter((t: any) => String(t.taskType) === 'evaluacion' && t.evaluationResults && typeof t.evaluationResults === 'object')
          .forEach((t: any) => {
            Object.entries(t.evaluationResults as Record<string, any>).forEach(([studentUsername, res]: any) => {
              try {
                const student = users.find((u: any) => String(u.username) === String(studentUsername));
                if (!student) return;
                const key = `${t.id}-${student.id}`;
                if (currentGrades.some(g => String(g.testId) === String(t.id) && String(g.studentId) === String(student.id))) return;
                const total = Number(res?.totalQuestions) || 0;
                const rawScore = Number(res?.score);
                let pct = total > 0 ? (rawScore / total) * 100 : Number(res?.completionPercentage) || 0;
                if (!isFinite(pct)) return;
                pct = Math.max(0, Math.min(100, pct));
                const subjId = subjectByNameOrId(t);
                const secId = t.sectionId || sectionForStudent(String(student.id));
                const base: TestGrade = {
                  id: key,
                  testId: String(t.id),
                  studentId: String(student.id),
                  studentName: student.displayName || student.name || student.username,
                  score: Math.round(pct * 100) / 100,
                  courseId: t.courseId || null,
                  sectionId: secId ? String(secId) : null,
                  subjectId: subjId,
                  title: t.title,
                  gradedAt: new Date(res?.completedAt || t.createdAt || Date.now()).getTime(),
                };
                if (!queued.has(base.id)) { newGrades.push(base); queued.add(base.id); }
              } catch {/* ignore */}
            });
          });
      } catch {/* ignore ensure eval */}

      // Integración de revisiones del profesor para PRUEBAS (smart-student-test-reviews_*)
      try {
        const collectReviews = (): Array<any> => {
          const acc: any[] = [];
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith('smart-student-test-reviews_')) continue;
              const arr = JSON.parse(localStorage.getItem(key) || '[]');
              if (Array.isArray(arr)) acc.push(...arr.map((r: any) => ({...r, _key: key})));
            }
          } catch {}
          return acc;
        };
        const reviews = collectReviews();
        const normalize = (s: string) => {
          try {
            return String(s || '')
              .toLowerCase()
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/\s+/g, ' ')
              .trim();
          } catch { return String(s || ''); }
        };
        const parseNumAny = (v: any): number | null => {
          if (v === 0) return 0;
          if (v == null) return null;
          if (typeof v === 'number' && isFinite(v)) return v;
          const s = String(v).trim();
          if (!s) return null;
          const m = s.replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
          if (!m) return null;
          const n = Number(m[0]);
          return isFinite(n) ? n : null;
        };
        const clampPct = (x: number) => Math.max(0, Math.min(100, x));
        reviews.forEach((r: any) => {
          try {
            const testId = String(r.testId || (r._key || '').split('_')[1] || '');
            if (!testId) return;
            const student = userById.get(String(r.studentId)) || users.find((u: any) => normalize(String(u.displayName || u.name || u.username)) === normalize(String(r.studentName || '')));
            if (!student) return;
            const totalQ = parseNumAny(r.totalQuestions);
            const totalPts = parseNumAny(r.totalPoints);
            const rawPct = parseNumAny(r.rawPercent);
            const rawPts = parseNumAny(r.rawPoints ?? r.points);
            const scoreField = parseNumAny(r.score);
            let pct: number | null = null;
            if (rawPct != null) pct = rawPct; // porcentaje directo importado
            else if (rawPts != null && totalPts != null && totalPts > 0) pct = (rawPts / totalPts) * 100; // puntos exactos
            else if (scoreField != null && totalQ != null && totalQ > 0) pct = (scoreField / totalQ) * 100; // correctas/total
            else if (scoreField != null) {
              // fallback: heurística si score aparenta ya estar en 0..100
              if (scoreField <= 1) pct = scoreField * 100;
              else if (scoreField <= 10) pct = scoreField * 10;
              else pct = scoreField;
            }
            if (pct == null || !isFinite(pct)) return;
            const base: TestGrade = {
              id: `${testId}-${student.id}`,
              testId,
              studentId: String(student.id),
              studentName: student.displayName || student.name || student.username,
              score: Math.round(clampPct(pct) * 100) / 100,
              courseId: r.courseId ? String(r.courseId) : null,
              sectionId: r.sectionId ? String(r.sectionId) : sectionForStudent(String(student.id)),
              subjectId: r.subjectId ?? null,
              title: r.topic || r.title,
              gradedAt: Number(r.uploadedAt) || Date.now(),
            };
            const existing = currentGrades.find((g: any) => String(g.testId) === testId && String(g.studentId) === String(student.id));
            if (!existing) {
              if (!queued.has(base.id)) { newGrades.push(base); queued.add(base.id); }
            } else {
              // Las revisiones del profesor tienen máxima prioridad; si difiere o es más reciente, reemplazar
              if (Number(existing.score) !== base.score || Number(existing.gradedAt) < base.gradedAt) {
                const idx = currentGrades.findIndex((g: any) => g.testId === existing.testId && g.studentId === existing.studentId);
                if (idx >= 0) { currentGrades[idx] = { ...existing, ...base }; replacements++; }
              }
            }
          } catch {/* ignore one */}
        });
      } catch (err) {
        console.warn('Error integrando revisiones de pruebas:', err);
      }

      // Integración de resultados de PRUEBAS (smart-student-tests*)
      try {
        const collectTests = (): any[] => {
          const acc: any[] = [];
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith('smart-student-tests')) continue;
              const arr = JSON.parse(localStorage.getItem(key) || '[]');
              if (Array.isArray(arr)) acc.push(...arr);
            }
          } catch {}
          try {
            const base = JSON.parse(localStorage.getItem('smart-student-tests') || '[]');
            if (Array.isArray(base)) acc.push(...base);
          } catch {}
          return acc;
        };
        const tests = collectTests();
        const percentageFrom = (r: any): number | null => {
          if (!r || typeof r !== 'object') return null;
          // Utilidad: extraer número desde strings como "80 pts", "70%", "70,0"
          const parseNumAny = (v: any): number | null => {
            if (v === 0) return 0;
            if (v == null) return null;
            if (typeof v === 'number' && isFinite(v)) return v;
            const s = String(v).trim();
            if (!s) return null;
            // Cambiar coma por punto y extraer primer número
            const m = s.replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
            if (!m) return null;
            const n = Number(m[0]);
            return isFinite(n) ? n : null;
          };
          const clampPct = (x: number) => Math.max(0, Math.min(100, x));
          // 1) Porcentaje explícito
          const pctRaw = parseNumAny((r as any).percentage ?? (r as any).percent ?? (r as any).pct);
          if (pctRaw != null) return clampPct(pctRaw);
          // 2) Puntos exactos del profesor (preferencia), con total
          const points = parseNumAny((r as any).points ?? (r as any).pts ?? (r as any).score ?? (r as any).grade ?? (r as any).nota);
          const totalPts = parseNumAny((r as any).totalPoints ?? (r as any).maxPoints ?? (r as any).max);
          if (points != null && totalPts != null && totalPts > 0) return clampPct((points / totalPts) * 100);
          // 3) Correctas sobre total de preguntas
          const correct = parseNumAny((r as any).correctAnswers ?? (r as any).right ?? (r as any).aciertos);
          const totalQ = parseNumAny((r as any).totalQuestions ?? (r as any).questions ?? (r as any).total);
          if (correct != null && totalQ != null && totalQ > 0) return clampPct((correct / totalQ) * 100);
          // 4) Solo puntos (escalas conocidas)
          if (points != null) {
            if (points <= 1) return clampPct(points * 100);
            if (points <= 10) return clampPct(points * 10);
            return clampPct(points);
          }
          return null;
        };
        // Explorar cada prueba buscando resultados por estudiante
        tests.forEach((t: any) => {
          const resultsSources: any[] = [];
          if (t && typeof t === 'object') {
            const keys = ['responses', 'results', 'studentResponses', 'submissions', 'answers', 'evaluationResults'];
            keys.forEach(k => { const v = (t as any)[k]; if (v) resultsSources.push(v); });
          }
          resultsSources.forEach((src: any) => {
            if (!src || typeof src !== 'object') return;
            const entries = Array.isArray(src) ? src : Object.entries(src);
            if (!entries) return;
            (entries as any[]).forEach((entry: any) => {
              try {
                let key: any, val: any;
                if (Array.isArray(src)) {
                  // Formatos de arreglo: [{studentId, ...}, ...]
                  val = entry;
                  key = (val && (val.studentId ?? val.studentUsername ?? val.username ?? val.user)) ?? undefined;
                } else {
                  [key, val] = entry;
                }
                const student = key && (userById.get(String(key)) || users.find((u: any) => String(u.username) === String(key) || String(u.id) === String(key)));
                if (!student) return;
                const pct = percentageFrom(val);
                if (pct == null || !isFinite(pct)) return;
                
                // Para evaluaciones importadas masivamente, preservar valor exacto
                // Detectar si es evaluación masiva por el completionPercentage exacto
                const isExactEvaluation = val && typeof val === 'object' && 
                  'completionPercentage' in val && val.completionPercentage === pct;
                const score = isExactEvaluation ? pct : Math.round(pct * 100) / 100;
                const courseId = t.courseId || t.course || null;
                const secId = t.sectionId || sectionForStudent(String(student.id));
                const subjId = t.subjectId || subjectByNameOrId({ subjectId: t.subjectId, subject: t.subjectName });
                const testId = String(t.id || t.testId || '');
                if (!testId) return;
                const id = `${testId}-${student.id}`;
                const base: TestGrade = {
                  id,
                  testId: testId,
                  studentId: String(student.id),
                  studentName: student.displayName || student.name || student.username,
                  score,
                  courseId: courseId ? String(courseId) : null,
                  sectionId: secId ? String(secId) : null,
                  subjectId: subjId,
                  title: t.title,
                  gradedAt: Date.now(),
                };
                const existing = currentGrades.find((g: any) => String(g.testId) === testId && String(g.studentId) === String(student.id));
                if (!existing) {
                  if (!queued.has(id)) { newGrades.push(base); queued.add(id); }
                } else {
                  if (Number(existing.score) !== base.score) {
                    const idx = currentGrades.findIndex((g: any) => g.testId === existing.testId && g.studentId === existing.studentId);
                    if (idx >= 0) { currentGrades[idx] = { ...existing, ...base }; replacements++; }
                  }
                }
              } catch {/* ignore one */}
            });
          });
        });
      } catch (err) {
        console.warn('Error integrando resultados de pruebas:', err);
      }
      
      // Conjunto de IDs válidos (para limpieza de notas huérfanas)
      const validIds = new Set<string>();
      try {
        // Tareas actuales
        Array.isArray(tasks) && tasks.forEach((t: any) => { if (t?.id) validIds.add(String(t.id)); });
      } catch {}
      try {
        // Pruebas actuales (todas las claves)
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith('smart-student-tests')) continue;
          const arr = JSON.parse(localStorage.getItem(key) || '[]');
          if (Array.isArray(arr)) arr.forEach((t: any) => { if (t?.id) validIds.add(String(t.id)); });
        }
        const base = JSON.parse(localStorage.getItem('smart-student-tests') || '[]');
        if (Array.isArray(base)) base.forEach((t: any) => { if (t?.id) validIds.add(String(t.id)); });
      } catch {}

      // Guardar las nuevas calificaciones (incluye reemplazos ya aplicados sobre currentGrades)
      let updatedGrades = (newGrades.length > 0 || replacements > 0) ? [...currentGrades, ...newGrades] : [...currentGrades];

      // Limpieza: eliminar notas cuyo testId ya no existe en tareas/pruebas
      const beforeCleanup = updatedGrades.length;
      if (validIds.size > 0) {
        updatedGrades = updatedGrades.filter(g => validIds.has(String(g.testId)));
      }
      const removed = beforeCleanup - updatedGrades.length;

      if (newGrades.length > 0 || replacements > 0 || removed > 0) {
        if (isSQLConnected) {
          // Evitar sobreescribir la fuente SQL; fusionar en memoria
          const mergeById = (a: TestGrade[], b: TestGrade[]) => {
            const idx = new Map<string, TestGrade>();
            (a || []).forEach(g => idx.set(`${g.testId}-${g.studentId}`, g));
            (b || []).forEach(g => idx.set(`${g.testId}-${g.studentId}`, g));
            return Array.from(idx.values());
          };
          setGrades(prev => mergeById(prev, updatedGrades));
        } else {
          LocalStorageManager.setTestGradesForYear(selectedYear, updatedGrades, { preferSession: true });
          setGrades(updatedGrades);
          // Emitir evento para sincronizar otras partes de la app (clave por año)
          const key = LocalStorageManager.keyForTestGrades(selectedYear);
          window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(updatedGrades) }));
        }
        // Notificar a sistema de notificaciones para reflejar cambios inmediatos
        try { window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', { detail: { reason: 'gradesSynced', count: newGrades.length, removed } })); } catch {}
        console.log(`🎯 Sincronizadas ${newGrades.length} nuevas calificaciones, ${replacements} actualizaciones, ${removed} eliminadas`);
        // Recargar pendientes después de sincronizar las calificaciones
        setTimeout(() => {
          try {
            loadPendingTasks();
            console.log('🔄 Pendientes recargados después de sincronización');
          } catch (err) {
            console.warn('Error recargando pendientes:', err);
          }
        }, 100);
      } else {
        console.log('ℹ️ No se encontraron cambios de calificaciones para sincronizar');
      }
      
    } catch (error) {
      console.error('Error sincronizando calificaciones de tareas:', error);
    }
  };

  // Reaccionar al cambio manual de selectedYear (p.e. desde selector) para refrescar catálogos
  useEffect(() => {
    try {
      const { LocalStorageManager } = require('@/lib/education-utils');
      setCourses(LocalStorageManager.getCoursesForYear(selectedYear));
      setSections(LocalStorageManager.getSectionsForYear(selectedYear));
      setSubjects(LocalStorageManager.getSubjectsForYear(selectedYear));
      try { const assigns = LocalStorageManager.getStudentAssignmentsForYear(selectedYear); if (Array.isArray(assigns)) setStudentAssignments(assigns); } catch {}
      try { const st = LocalStorageManager.getStudentsForYear(selectedYear); if (Array.isArray(st) && st.length) setUsers(prev => { const others = prev.filter(p => p.role && p.role !== 'student'); return [...st, ...others]; }); } catch {}
    } catch {}
  }, [selectedYear]);

  // Función para cargar tareas pendientes de calificación
  const loadPendingTasks = () => {
    try {
      const rawTasks: any[] = isSQLConnected
        ? (activitiesSQL || []).filter((a: any) => String(a.taskType) === 'tarea').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Tarea'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            subjectId: a.subjectId ?? null,
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: String(a.dueDate || a.createdAt || new Date().toISOString()),
            createdAt: String(a.createdAt || new Date().toISOString()),
            status: String(a.status || 'pending'),
            priority: 'medium',
            taskType: 'tarea' as const,
          }))
        : loadJson<any[]>('smart-student-tasks', []);
      const tasks: Task[] = Array.isArray(rawTasks) ? rawTasks.map((t: any) => {
        const id = String(t.id ?? t.taskId ?? t.uid ?? Math.random().toString(36).slice(2));
        const statusRaw = String(t.status || '').toLowerCase();
        const status = statusRaw || 'pending';
        const assignedTo = (t.assignedTo === 'student') ? 'student' : 'course';

        // Normalizador: si viene courseSectionId compuesto (curso-uuid + sección-uuid), separarlo
        const parseComposite = (val?: string | null) => {
          if (!val || typeof val !== 'string') return null as null | { c: string; s: string };
          const parts = val.split('-');
          // UUID v4: 5 bloques; compuesto curso+sección => 10 bloques
          if (parts.length >= 10) {
            const c = parts.slice(0, 5).join('-');
            const s = parts.slice(5, 10).join('-');
            if (c && s) return { c, s };
          }
          // También soportar formato con separador '::'
          if (val.includes('::')) {
            const [c, s] = val.split('::');
            if (c && s) return { c, s };
          }
          return null;
        };

        let sectionId: string | null = t.sectionId ?? t.courseSectionId ?? null;
        let courseId: string | null = t.courseId ?? null;
        const comp = parseComposite(String(t.courseSectionId ?? ''));
        if (comp) {
          // Si llega compuesto, priorizar IDs reales
          courseId = courseId ?? comp.c;
          sectionId = sectionId && sectionId !== String(t.courseSectionId) ? String(sectionId) : comp.s;
        }

        return {
          id,
          title: fixMojibake(String(t.title || t.name || 'Tarea')),
          description: String(t.description || ''),
          subject: String(t.subject || t.subjectName || t.subjectId || 'General'),
          course: String(t.course || t.courseName || t.courseId || ''),
          courseId: courseId ?? null,
          assignedById: String(t.assignedById || t.teacherId || t.ownerId || ''),
          assignedByName: String(t.assignedByName || t.teacherName || t.ownerUsername || ''),
          assignedTo,
          assignedStudentIds: Array.isArray(t.assignedStudentIds) ? t.assignedStudentIds.map(String) : undefined,
          sectionId: sectionId ?? null,
          dueDate: String(t.dueDate || t.closeAt || new Date().toISOString()),
          createdAt: String(t.createdAt || t.openAt || new Date().toISOString()),
          status,
          priority: String(t.priority || 'medium'),
          taskType: String(t.taskType || 'tarea'),
          topic: fixMojibake(String((t as any).topic || t.title || '')),
        } as Task;
      }) : [];
      // Incluir evaluaciones como tareas pendientes también
      const evalsRaw: any[] = isSQLConnected
        ? (activitiesSQL || []).filter((a: any) => String(a.taskType) === 'evaluacion').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Evaluación'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: String(a.dueDate || a.createdAt || new Date().toISOString()),
            createdAt: String(a.createdAt || new Date().toISOString()),
            status: String(a.status || 'finished'),
            priority: 'medium',
            taskType: 'evaluacion' as const,
          }))
        : loadJson<any[]>('smart-student-evaluations', []);
      const evaluations: Task[] = Array.isArray(evalsRaw) ? evalsRaw.map((e: any) => ({
        id: String(e.id ?? e.evaluationId ?? e.uid ?? Math.random().toString(36).slice(2)),
        title: fixMojibake(String(e.title ?? e.name ?? 'Evaluación')),
        description: String(e.description ?? ''),
        subject: String(e.subject ?? e.subjectName ?? e.subjectId ?? 'General'),
        course: String(e.course ?? e.courseName ?? e.courseId ?? ''),
        courseId: e.courseId ?? null,
        assignedById: String(e.assignedById ?? e.teacherId ?? ''),
        assignedByName: String(e.assignedByName ?? e.teacherName ?? ''),
        assignedTo: (e.assignedTo === 'student' ? 'student' : 'course'),
        assignedStudentIds: Array.isArray(e.assignedStudentIds) ? e.assignedStudentIds.map(String) : undefined,
        sectionId: e.sectionId ?? null,
        dueDate: String(e.dueDate ?? e.closeAt ?? new Date().toISOString()),
        createdAt: String(e.createdAt ?? e.openAt ?? new Date().toISOString()),
        status: (e.status === 'finished' || e.closed) ? 'finished' : (e.status || 'pending'),
        priority: 'medium',
        taskType: 'evaluacion',
        topic: fixMojibake(String((e as any).topic || e.title || '')),
      })) : [];
      // Agregar Pruebas (smart-student-tests_*) como elementos tipo 'prueba'
      const testsRaw: any[] = isSQLConnected
        ? (activitiesSQL || []).filter((a: any) => String(a.taskType) === 'prueba').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Prueba'),
            subjectName: String(a.subjectName || a.subjectId || 'General'),
            subjectId: a.subjectId ?? null,
            courseId: a.courseId ?? null,
            sectionId: a.sectionId ?? null,
            createdAt: new Date(a.createdAt || Date.now()).getTime(),
          }))
        : (() => {
          const acc: any[] = [];
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith('smart-student-tests')) continue;
              const arr = JSON.parse(localStorage.getItem(key) || '[]');
              if (Array.isArray(arr)) acc.push(...arr);
            }
          } catch {}
          try {
            const base = JSON.parse(localStorage.getItem('smart-student-tests') || '[]');
            if (Array.isArray(base)) acc.push(...base);
          } catch {}
          return acc;
        })();
  const testsAsTasks: Task[] = Array.isArray(testsRaw) ? testsRaw.map((t: any) => ({
        id: String(t.id || ''),
    title: fixMojibake(String(t.title || 'Prueba')),
        description: String(t.description || ''),
        subject: String(t.subjectName || t.subjectId || 'General'),
        subjectId: t.subjectId ?? null,
        course: '',
        courseId: t.courseId ?? null,
        assignedById: String(t.ownerId || ''),
        assignedByName: String(t.ownerUsername || ''),
        assignedTo: 'course',
        assignedStudentIds: undefined,
        sectionId: t.sectionId ?? null,
        dueDate: toIso(t.createdAt ?? Date.now()),
        createdAt: toIso(t.createdAt ?? Date.now()),
        status: 'pending',
        priority: 'medium',
        taskType: 'prueba',
        topic: fixMojibake(String(t.topic || t.title || '')),
      })) : [];
  // Cargar notas ya registradas por año (per-year) - siempre obtener las más actuales
  const { LocalStorageManager } = require('@/lib/education-utils');
  const existingGrades = isSQLConnected ? (grades as TestGrade[]) : ((LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[]) || []);
  console.log(`📊 Cargando pendientes: ${existingGrades.length} calificaciones existentes para ${selectedYear}`);
      const sectionsLS: any[] = loadJson<any[]>('smart-student-sections', []);
      const assignsLS: any[] = loadJson<any[]>(`smart-student-student-assignments-${selectedYear}`, []);
      const coursesLS: any[] = loadJson<any[]>('smart-student-courses', []);
      const deriveSectionId = (task: any): string | null => {
        if (task.sectionId) return String(task.sectionId);
        // estudiante específico
        if (task.assignedTo === 'student' && Array.isArray(task.assignedStudentIds)) {
          for (const sidRaw of task.assignedStudentIds) {
            const sid = String(sidRaw);
            const asg = assignsLS.find((a: any) => String(a.studentId) === sid || String(a.studentUsername) === sid);
            if (asg?.sectionId) return String(asg.sectionId);
          }
        }
        // título con letra y courseId
        if (task.title && task.courseId) {
          const m = String(task.title).match(/\s-\s([A-ZÑ])$/) || String(task.title).match(/\(([A-ZÑ])\)$/);
          const letter = m?.[1];
          if (letter) {
            const sec = sectionsLS.find((s: any) => String(s.courseId) === String(task.courseId) && String(s.name).toUpperCase() === letter);
            if (sec) return String(sec.id);
          }
        }
        // task.course heurístico
        if (task.course) {
          const norm = (v: string) => v
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\bseccion\b/gi, '')
            .replace(/\bsección\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          const courseValRaw = String(task.course).trim();
          const courseVal = courseValRaw;
          const courseValNorm = norm(courseValRaw);
            const directSec = sectionsLS.find((s: any) => String(s.id) === courseVal);
            if (directSec) return String(directSec.id);
            for (const s of sectionsLS) {
              const c = coursesLS.find((cc: any) => String(cc.id) === String(s.courseId));
              const label = `${c?.name || ''} ${s.name}`.trim();
              const labelNorm = norm(label);
              if (label && labelNorm === courseValNorm) return String(s.id);
            }
          const courseObj = coursesLS.find((c: any) => String(c.id) === courseVal);
          if (courseObj && task.title) {
            const m = String(task.title).match(/\s-\s([A-ZÑ])$/) || String(task.title).match(/\(([A-ZÑ])\)$/);
            const letter = m?.[1];
            if (letter) {
              const sec = sectionsLS.find((s: any) => String(s.courseId) === String(courseObj.id) && String(s.name).toUpperCase() === letter);
              if (sec) return String(sec.id);
            }
          }
        }
        // Sin suposición por "única sección del curso": si no se logra derivar, mantener null para evitar asignaciones cruzadas.
        return null;
      };
      
      // Filtrar tareas que están esperando calificación
  const pending: PendingTask[] = [];
  const timelineAll: PendingTask[] = [];
      
  const allItems: Task[] = [...tasks, ...evaluations, ...testsAsTasks];
  allItems.forEach((task) => {
  // Ignorar tareas cuyo año de creación no coincide con el año seleccionado (evita arrastre de otros años)
  try {
    const yearCreated = new Date(task.createdAt || task.dueDate || Date.now()).getFullYear();
    if (Number.isFinite(yearCreated) && yearCreated !== selectedYear) return; // skip
  } catch {}
  // Considerar tareas por existencia: incluir todos los estados, excepto eliminadas/archivadas/canceladas.
  const st = String(task.status || '').toLowerCase();
  const excluded = new Set(['deleted', 'archived', 'cancelled', 'canceled']);
  if (!excluded.has(st)) {
          // Verificar si la tarea ya tiene calificaciones completas
          // Obtener calificaciones asociadas a la instancia.
          // 1) Coincidencia directa por id
          let taskGrades = existingGrades.filter(grade => String(grade.testId) === String(task.id));
          if (taskGrades.length === 0 && (task.taskType === 'evaluacion' || task.taskType === 'tarea')) {
            // 2) Fallback: a veces la nota se guarda con otro id (p.e. id interno de evaluación / test importado)
            // Usar coincidencia por título + asignatura normalizados dentro de una ventana de fechas
            const norm = (s: any) => String(s||'')
              .toLowerCase()
              .normalize('NFD')
              .replace(/[^a-z0-9\s]/g,'')
              .replace(/\s+/g,' ') 
              .trim();
            const taskTitleNorm = norm(task.title);
            const taskSubjectNorm = norm(task.subject);
            const createdTime = new Date(task.createdAt || task.dueDate || Date.now()).getTime();
            const WINDOW_MS = 1000 * 60 * 60 * 24 * 30; // 30 días de tolerancia
            taskGrades = existingGrades.filter(g => {
              if (!Number.isFinite(g.score)) return false;
              const gTitleNorm = norm(g.title);
              const dt = Math.abs((Number(g.gradedAt)||0) - createdTime);
              // Relajar: sólo título + ventana temporal (subject puede variar por normalización distinta)
              return gTitleNorm === taskTitleNorm && dt <= WINDOW_MS;
            });
            if (taskGrades.length > 0) {
              // Log de depuración para confirmar fallback
              try { console.debug(`[PENDIENTES] Fallback coincidencia por titulo+asignatura para ${task.taskType} '${task.title}' -> ${taskGrades.length} nota(s)`); } catch {}
            }
          }
          // Derivar sección (solo se usa para conteo esperado)
          let secId = (task as any).sectionId || deriveSectionId(task);
          if (secId) secId = String(secId);
          
          let needsGrading = false;
          
          if (task.assignedTo === 'course') {
            // Nuevo criterio por sección: pendiente si falta al menos un estudiante esperado por calificar para este testId
            // Soporta tareas de curso con subconjunto explícito de estudiantes (assignedStudentIds)
            if (task.taskType === 'prueba' || task.taskType === 'evaluacion' || task.taskType === 'tarea') {
              // Notas que corresponden a ESTE test en ESTA sección
              const inSectionGrades = taskGrades.filter(g => {
                let gSec: string | null = g.sectionId ? String(g.sectionId) : null;
                if (!gSec) {
                  const asg = studentAssignments.find(as => String(as.studentId) === String(g.studentId) || String(as.studentUsername) === String(g.studentId));
                  gSec = asg?.sectionId ? String(asg.sectionId) : null;
                }
                return gSec && secId && String(gSec) === String(secId);
              });
              const validInSection = inSectionGrades.filter(g => Number.isFinite(g.score) && g.score >= 0);

              // Estudiantes esperados:
              // - Si la tarea provee assignedStudentIds (aunque sea "course"), usar ese subconjunto.
              // - En caso contrario, usar todos los estudiantes de la sección.
              let expected: string[] = [];
              if (Array.isArray(task.assignedStudentIds) && task.assignedStudentIds.length > 0) {
                expected = task.assignedStudentIds.map(String);
                // Si conocemos la sección, intersectar con estudiantes de la sección para evitar arrastre entre secciones
                if (secId) {
                  const sectionStudents = new Set(
                    studentAssignments
                      .filter(a => String(a.sectionId) === String(secId))
                      .map(a => String(a.studentId || a.studentUsername))
                      .filter(Boolean)
                  );
                  expected = expected.filter(sid => sectionStudents.has(String(sid)));
                }
              } else {
                expected = studentAssignments
                  .filter(a => secId && String(a.sectionId) === String(secId))
                  .map(a => String(a.studentId || a.studentUsername))
                  .filter(Boolean);
              }

              const expectedSet = new Set(expected);
              const gradedSet = new Set(validInSection.map(g => String(g.studentId)));

              // ✅ CRITERIO SIMPLIFICADO: Mostrar como "Pendiente" SOLO si NO HAY NINGUNA calificación aún
              // Una vez que existe al menos una calificación, la evaluación ya NO es "pendiente"
              // (El admin/profesor puede completar las demás después)
              needsGrading = validInSection.length === 0;

              // Heurística extra solo para evaluaciones: si aún parece pendiente, buscar coincidencias por subject en la ventana temporal
              if (needsGrading && task.taskType === 'evaluacion') {
                try {
                  const createdTime = new Date(task.createdAt || task.dueDate || Date.now()).getTime();
                  const WINDOW_MS = 1000 * 60 * 60 * 24 * 45; // 45 días
                  const norm = (s: any) => String(s||'')
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/[^a-z0-9\s]/g,'')
                    .replace(/\s+/g,' ')
                    .trim();
                  const subjNorm = norm(task.subject);
                  const possible = existingGrades.filter(g => {
                    if (!Number.isFinite(g.score)) return false;
                    // Restringir a la misma sección
                    let gSec: string | null = g.sectionId ? String(g.sectionId) : null;
                    if (!gSec) { const asg = studentAssignments.find(as => String(as.studentId) === String(g.studentId) || String(as.studentUsername) === String(g.studentId)); gSec = asg?.sectionId ? String(asg.sectionId) : null; }
                    if (!gSec || !secId || String(gSec) !== String(secId)) return false;
                    const when = Number(g.gradedAt)||0;
                    if (Math.abs(when - createdTime) > WINDOW_MS) return false;
                    const gSubjNorm = norm(g.subjectId || '');
                    const titleNorm = norm(g.title || '');
                    return (g.subjectId && String(g.subjectId) === String(task.subject)) ||
                           (subjNorm && (gSubjNorm === subjNorm || titleNorm.includes(subjNorm)));
                  });
                  if (possible.length > 0) {
                    // Si encontramos calificaciones en la misma sección por heurística, no marcar pendiente
                    needsGrading = false;
                  }
                } catch {/* ignore heuristic errors */}
              }
            }
          } else if (task.assignedTo === 'student' && task.assignedStudentIds) {
            // Estudiantes específicos: falta aunque exista registro sin score o faltan estudiantes
            const gradedStudentIds = new Set(taskGrades.filter(g => Number.isFinite(g.score)).map(g => g.studentId));
            needsGrading = task.assignedStudentIds.some(studentId => !gradedStudentIds.has(studentId));
          }
          
          // Siempre agregar a la línea de tiempo (aunque esté completa) para que la burbuja exista
          const refIso = toIso(task.createdAt || task.startAt || task.openAt || task.dueDate || Date.now());
          timelineAll.push({
            taskId: task.id,
            title: task.title,
            taskType: task.taskType,
            createdAt: refIso,
            subject: task.subject,
            course: task.course,
            courseId: task.courseId ?? null,
            sectionId: secId ?? null,
            assignedTo: task.assignedTo,
            assignedStudentIds: task.assignedStudentIds,
            columnIndex: 0,
            topic: task.topic
          });
          if (needsGrading) {
            pending.push({...timelineAll[timelineAll.length-1]});
          }
        }
      });

  // Ordenar timeline completa y pendientes por fecha (asc)
  const sortByDate = (arr: PendingTask[]) => arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  sortByDate(timelineAll);
  sortByDate(pending);
  timelineAll.forEach((task, index) => { task.columnIndex = Math.min(index, 9); });
  pending.forEach((task, index) => { task.columnIndex = Math.min(index, 9); });

  // Anteriormente se limitaba a 10 globales; esto ocultaba elementos de secciones específicas.
  // Guardamos todos y el filtrado por sección/curso se hace después. Si se requiere límite por sección se aplicará en la capa de presentación.
  setPendingTasks(pending);
  setTimelineTasks(timelineAll);
      
      if (pending.length > 0) {
        console.log(`📋 [CALIFICACIONES] ${pending.length} tarea(s) pendiente(s) de calificación:`, pending.map(t => `${t.title} (${t.taskType})`));
      }
    } catch (error) {
      console.error('Error cargando tareas pendientes:', error);
      setPendingTasks([]);
    }
  };

  // Recalcular pendientes cuando cambien las actividades SQL o la conexión/año o las calificaciones
  useEffect(() => {
    try { loadPendingTasks(); } catch {}
  }, [activitiesSQL, isSQLConnected, selectedYear, grades, studentAssignments, sections, courses]);

  // Helpers de nivel
  const getCourseLevel = (name?: string): 'basica' | 'media' | null => {
    if (!name) return null;
    const raw = name.trim();
    const n = raw.toLowerCase();
    // Palabras clave explícitas
    if (n.includes('básica') || n.includes('basico') || n.includes('básico') || n.includes('basica')) return 'basica';
    if (n.includes('medio') || n.includes('media')) return 'media';
    // Heurística: número inicial (1-8) => básica; (9-12) => media
    // Soporta formatos: "1A", "1ºA", "1ro", "2do", "3er", "4to", etc.
    const match = n.match(/^(\d{1,2})/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= 8) return 'basica';
      if (num >= 9 && num <= 12) return 'media';
    }
    // Otra heurística: si contiene "bas" y un número 1-8
    if (/\b[1-8]/.test(n) && /bas/.test(n)) return 'basica';
    if (/\b(9|10|11|12)/.test(n) && /med/.test(n)) return 'media';
    return null;
  };

  const courseById = useMemo(() => new Map(courses.map(c => [c.id, c] as const)), [courses]);

  // Orden lógico de cursos: 1º Básico → 8º Básico → 1º Medio → 4º Medio
  const courseRank = (name?: string): number => {
    if (!name) return 9999;
    const n = name.toLowerCase();
    const numMap: Record<string, number> = { '1':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8 };
    const num = Object.keys(numMap).find(k => n.includes(`${k}ro`) || n.includes(`${k}º`) || n.includes(`${k}to`) || n.includes(`${k}mo`) || n.startsWith(`${k}`));
    const nn = num ? numMap[num] : 99;
    const isBasico = n.includes('básic') || n.includes('basic');
    const isMedio = n.includes('medio') || n.includes('media');
    if (isBasico) return nn;                // 1..8
    if (isMedio) return 8 + (nn || 0);      // 9..12
    return 9000 + nn;                       // Otros al final
  };
  const sectionRank = (sec?: string): number => {
    if (!sec) return 9999;
    const s = sec.trim();
    const ch = s[0]?.toUpperCase();
    return ch ? ch.charCodeAt(0) : 9999;
  };

  // Prioridad de Asignaturas (fallback a alfabético)
  const SUBJECT_ORDER = [
    'Lenguaje y Comunicación',
    'Matemática',
    'Historia, Geografía y Ciencias Sociales',
    'Ciencias Naturales',
    'Inglés',
    'Educación Física',
    'Música',
    'Artes Visuales',
    'Tecnología',
    'Orientación',
  ];
  const subjectRank = (name?: string): number => {
    if (!name) return 9999;
    const idx = SUBJECT_ORDER.findIndex(s => s.toLowerCase() === name.toLowerCase());
    if (idx >= 0) return idx;
    return 1000; // desconocidas después; se desempatan alfabéticamente
  };

  // Opciones por rol
  const [teacherAssignments, setTeacherAssignments] = useState<any[]>(() => loadJson<any[]>('smart-student-teacher-assignments', []));
  useEffect(() => {
    try {
      const { LocalStorageManager } = require('@/lib/education-utils');
      const perYear = LocalStorageManager.getTeacherAssignmentsForYear(selectedYear);
      if (Array.isArray(perYear) && perYear.length) setTeacherAssignments(perYear);
      else setTeacherAssignments(loadJson<any[]>('smart-student-teacher-assignments', []));
    } catch {
      setTeacherAssignments(loadJson<any[]>('smart-student-teacher-assignments', []));
    }
  }, [selectedYear]);

  const allowed = useMemo(() => {
    if (!user) return { courses: new Set<string>(), sections: new Set<string>(), subjects: new Set<string>() };
    if (user.role === 'admin') {
      return {
        courses: new Set<string>(courses.map(c => c.id)),
        sections: new Set<string>(sections.map(s => s.id)),
        subjects: new Set<string>(subjects.map(su => su.id || su.name)),
      };
    }
    if (user.role === 'teacher') {
      const mine = teacherAssignments.filter(a => a.teacherId === (user as any).id || a.teacherUsername === user.username);
      const c = new Set<string>();
      const s = new Set<string>();
      const subj = new Set<string>();
      mine.forEach(a => {
        if (a.courseId) c.add(String(a.courseId));
        if (a.sectionId) s.add(String(a.sectionId));
        const names: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
        names.forEach(n => { if (n) subj.add(String(n)); });
      });
      // Extender automáticamente con contenido creado por el profesor (tareas/evaluaciones/pruebas)
      try {
        const normalize = (x: any) => String(x || '').trim().toLowerCase();
        const uid = String((user as any).id || '');
        const uname = String(user.username || '');
        const tks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
        Array.isArray(tks) && tks.forEach((t: any) => {
          const ownerMatch = normalize(t.assignedById) === normalize(uid) || normalize(t.assignedByName) === normalize(uname) || normalize(t.teacherId) === normalize(uid) || normalize(t.teacherName) === normalize(uname) || normalize(t.ownerId) === normalize(uid) || normalize(t.ownerUsername) === normalize(uname);
          if (!ownerMatch) return;
          if (t.courseId) c.add(String(t.courseId));
          if (t.sectionId) s.add(String(t.sectionId));
          const name = t.subject || t.subjectName;
          if (name) subj.add(String(name));
        });
        const evals = JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]');
        Array.isArray(evals) && evals.forEach((e: any) => {
          const ownerMatch = normalize(e.assignedById) === normalize(uid) || normalize(e.assignedByName) === normalize(uname) || normalize(e.teacherId) === normalize(uid) || normalize(e.teacherName) === normalize(uname);
          if (!ownerMatch) return;
          if (e.courseId) c.add(String(e.courseId));
          if (e.sectionId) s.add(String(e.sectionId));
          const name = e.subject || e.subjectName;
          if (name) subj.add(String(name));
        });
        // Pruebas (smart-student-tests*)
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('smart-student-tests')) continue;
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            if (!Array.isArray(arr)) continue;
            arr.forEach((t: any) => {
              const ownerMatch = normalize(t.ownerId) === normalize(uid) || normalize(t.ownerUsername) === normalize(uname);
              if (!ownerMatch) return;
              if (t.courseId) c.add(String(t.courseId));
              if (t.sectionId) s.add(String(t.sectionId));
              const name = t.subjectName || t.subject;
              if (name) subj.add(String(name));
            });
          }
        } catch {}
      } catch {}
      return { courses: c, sections: s, subjects: subj };
    }
    
    // 🎓 APODERADO: Permisos basados en estudiantes asignados
    if (user.role === 'guardian') {
      const c = new Set<string>();
      const s = new Set<string>();
      
      // Obtener secciones de los estudiantes asignados
      guardianStudents.forEach(student => {
        const assign = studentAssignments.find(a => 
          String(a.studentId) === String(student.id) || 
          String(a.studentUsername) === String(student.username)
        );
        if (assign) {
          if (assign.courseId) c.add(String(assign.courseId));
          if (assign.sectionId) s.add(String(assign.sectionId));
        }
      });
      
      console.log(`👨‍👩‍👧 [allowed] Permisos guardian - Cursos: ${c.size}, Secciones: ${s.size}`);
      
      return { courses: c, sections: s, subjects: new Set<string>() };
    }
    
    // Estudiante
    console.log(`🔍 [allowed] Filtrando assignments para estudiante:`, {
      userId: (user as any).id,
      username: user.username,
      totalAssignments: studentAssignments.length,
      sampleAssignments: studentAssignments.slice(0, 5).map(a => ({ 
        studentId: a.studentId, 
        studentUsername: a.studentUsername, 
        studentName: a.studentName,
        sectionId: a.sectionId,
        courseId: a.courseId
      }))
    });
    
    // Buscar assignments que coincidan con Sofia
    console.log(`🔍 [allowed] Buscando assignments para username="${user.username}"`);
    const byUsername = studentAssignments.filter(a => String(a.studentUsername) === String(user.username));
    console.log(`   • Por username: ${byUsername.length}`, byUsername.slice(0, 2));
    
    const byUserId = studentAssignments.filter(a => String(a.studentId) === String((user as any).id));
    console.log(`   • Por userId: ${byUserId.length}`, byUserId.slice(0, 2));
    
    // Buscar por nombre (fallback)
    const userName = String((user as any).name || (user as any).displayName || '').toLowerCase();
    const byName = studentAssignments.filter(a => 
      String(a.studentName || '').toLowerCase().includes('sofía') || 
      String(a.studentName || '').toLowerCase().includes('sofia')
    );
    console.log(`   • Por nombre (Sofia/Sofía): ${byName.length}`, byName.slice(0, 2));
    
    // Filtrar por studentId O por username O por nombre
    const mine = studentAssignments.filter(a => 
      String(a.studentId) === String((user as any).id) || 
      String(a.studentUsername) === String(user.username) ||
      (userName && String(a.studentName || '').toLowerCase().includes(userName.split(' ')[0]))
    );
    
    console.log(`🔍 [allowed] Assignments encontrados para estudiante: ${mine.length}`, 
      mine.map(a => ({ sectionId: a.sectionId, courseId: a.courseId }))
    );
    
    const c = new Set<string>();
    const s = new Set<string>();
    mine.forEach(a => { if (a.courseId) c.add(a.courseId); if (a.sectionId) s.add(a.sectionId); });
    
    console.log(`🔍 [allowed] Secciones permitidas para estudiante: ${s.size}`, Array.from(s));
    
    return { courses: c, sections: s, subjects: new Set<string>() };
  }, [user, courses, sections, subjects, teacherAssignments, studentAssignments, guardianStudents]);

  // Derivar chips de filtros según rol y nivel
  const courseSectionOptions: Option[] = useMemo(() => {
    const opts: Option[] = [];
    // Crear opciones por cada sección permitida, mostrando Curso + Sección (ej. "1 Medio Z")
    sections.forEach(s => {
      if (!allowed.sections.has(String(s.id))) return; // solo secciones activas del profesor
      const course = courseById.get(s.courseId);
      // Filtrado por nivel si aplica
      if (levelFilter !== 'all') {
        const level = getCourseLevel(course?.name);
        if (level !== levelFilter) return;
      }
      const label = `${course?.name ?? ''} ${s.name}`.trim();
      opts.push({ value: s.id, label });
    });
    // Orden alfab e9tico por etiqueta para consistencia
    return opts.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }, [sections, courseById, allowed, levelFilter]);

  // Si el profesor solo tiene una sección visible, aplicarla automáticamente al combo
  useEffect(() => {
    try {
      if (!user || user.role !== 'teacher') return;
      const options = courseSectionOptions;
      if (options.length === 1 && comboSectionId === 'all') {
        setComboSectionId(String(options[0].value));
      }
    } catch {}
  }, [user, courseSectionOptions]);

  // Secciones visibles según filtro y permisos (incluye nivel)
  const visibleSectionIds = useMemo(() => {
    console.log(`🔍 [visibleSectionIds] Computing...`, { 
      cascadeSectionId, 
      cascadeCourseId, 
      comboSectionId, 
      levelFilter,
      userRole: user?.role,
      allowedSectionsCount: allowed.sections.size,
      sectionsTotal: sections.length
    });
    
    // Prioridad: selección directa en cascada (sección), luego curso, luego combo y nivel
    if (cascadeSectionId) {
      console.log(`🔍 [visibleSectionIds] Using cascadeSectionId:`, cascadeSectionId);
      return new Set<string>([String(cascadeSectionId)]);
    }
    if (cascadeCourseId) {
      const set = new Set<string>();
    sections.forEach(s => { if (String(s.courseId) === String(cascadeCourseId) && (user?.role === 'admin' || allowed.sections.has(s.id))) set.add(String(s.id)); });
      console.log(`🔍 [visibleSectionIds] Using cascadeCourseId, result:`, Array.from(set));
      return set;
    }
    if (comboSectionId !== 'all') {
      console.log(`🔍 [visibleSectionIds] Using comboSectionId:`, comboSectionId);
      return new Set<string>([comboSectionId]);
    }
  const all = user?.role === 'admin' ? sections.map(s => s.id) : [...allowed.sections];
    console.log(`🔍 [visibleSectionIds] all sections:`, all.length);
    if (levelFilter === 'all') {
      console.log(`🔍 [visibleSectionIds] Level filter is 'all', returning all:`, all.length);
      return new Set<string>(all);
    }
    const keep = new Set<string>();
    sections.forEach(s => {
  if (!all.includes(s.id)) return;
      const c = courseById.get(s.courseId);
      const lvl = getCourseLevel(c?.name);
      if (lvl === levelFilter) keep.add(s.id);
    });
    console.log(`🔍 [visibleSectionIds] Filtered by level '${levelFilter}':`, Array.from(keep));
    return keep;
  }, [comboSectionId, allowed.sections, levelFilter, sections, courseById, cascadeCourseId, cascadeSectionId, user]);

  const subjectOptions: Option[] = useMemo(() => {
    console.log(`🔍 [subjectOptions] Computing...`, {
      visibleSectionIdsCount: visibleSectionIds.size,
      teacherAssignmentsCount: teacherAssignments.length,
      activitiesSQLCount: activitiesSQL.length,
      gradesCount: grades.length,
      userRole: user?.role
    });
    
    const opts: Option[] = [{ value: 'all', label: translate('allSubjects') || 'Todas las asignaturas' }];
    const targetSectionIds = new Set<string>([...visibleSectionIds]);
    const nameSet = new Set<string>();
    
    // 1) Intentar desde teacherAssignments (fuente principal)
    teacherAssignments.forEach(a => {
      if (!a || !a.sectionId) return;
      if (!targetSectionIds.has(String(a.sectionId))) return;
      // En modo profesor, solo considerar sus propias asignaciones
      if (user?.role === 'teacher') {
        const isMine = String(a.teacherId) === String((user as any)?.id) || String(a.teacherUsername) === String(user?.username);
        if (!isMine) return;
      }
      const names: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
      names.forEach(n => { if (n) nameSet.add(String(n)); });
    });
    
    console.log(`📝 [subjectOptions] Subjects from teacherAssignments:`, Array.from(nameSet));
    
    // 2) Incluir asignaturas detectadas desde actividades SQL para secciones visibles
    if (isSQLConnected && Array.isArray(activitiesSQL) && activitiesSQL.length) {
      const subjectNameFromId = (sid?: string | number) => {
        if (!sid) return 'General';
        const found = subjects.find(su => String(su.id) === String(sid));
        return found?.name || String(sid);
      };
      activitiesSQL.forEach((a: any) => {
        const secId = a?.sectionId ? String(a.sectionId) : null;
        if (!secId || !targetSectionIds.has(secId)) return;
        // En modo profesor, solo considerar actividades creadas por él/ella
        if (user?.role === 'teacher') {
          const owner = String(a.assignedById || '');
          const myId = String((user as any)?.id || '');
          const myUsername = String(user?.username || '');
          if (!(owner === myId || owner === myUsername)) return;
        }
        const name = String(a.subjectName || subjectNameFromId(a.subjectId) || 'General');
        if (name) nameSet.add(name);
      });
      
      console.log(`📝 [subjectOptions] Subjects after activitiesSQL:`, Array.from(nameSet));
    }
    
    // 🆕 3) FALLBACK CRUCIAL: Si no hay subjects aún, extraerlos desde las calificaciones existentes
    // Esto es vital cuando se hace carga masiva sin crear teacher-assignments
    if (nameSet.size === 0 && grades.length > 0) {
      console.log(`🔄 [subjectOptions] No subjects found, extracting from grades...`);
      console.log(`📊 [subjectOptions] Sample grades to analyze:`, grades.slice(0, 3).map(g => ({
        title: g.title,
        subjectId: g.subjectId,
        sectionId: g.sectionId
      })));
      
      grades.forEach(g => {
        // Filtrar por secciones visibles
        const gSecId = g?.sectionId ? String(g.sectionId) : null;
        if (!gSecId || !targetSectionIds.has(gSecId)) return;
        
        // En modo profesor, solo sus calificaciones
        if (user?.role === 'teacher') {
          // Las calificaciones no tienen teacherId, así que no podemos filtrar aquí
          // Mejor confiar en que si hay calificaciones, el profesor debe verlas
        }
        
        // ESTRATEGIA 1: Extraer desde subjectId (puede ser un ID normalizado o el nombre directo)
        if (g.subjectId) {
          const subjIdStr = String(g.subjectId).trim();
          
          // Si subjectId parece ser un ID numérico, buscar en el catálogo
          if (subjIdStr.match(/^\d+$/)) {
            const found = subjects.find(su => String(su.id) === subjIdStr);
            if (found?.name) {
              console.log(`✅ Found subject from catalog: ${found.name} (id: ${subjIdStr})`);
              nameSet.add(found.name);
              return;
            }
          }
          
          // Si subjectId es un ID normalizado tipo "lenguaje-y-comunicacion", buscar coincidencia normalizada
          const normalizeForMatch = (s: string) => s.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '');
          
          const normalizedSubjId = normalizeForMatch(subjIdStr);
          const foundByNormalized = subjects.find(su => 
            normalizeForMatch(su.name) === normalizedSubjId || 
            normalizeForMatch(String(su.id)) === normalizedSubjId
          );
          
          if (foundByNormalized?.name) {
            console.log(`✅ Found subject by normalized match: ${foundByNormalized.name} (normalized: ${normalizedSubjId})`);
            nameSet.add(foundByNormalized.name);
            return;
          }
          
          // Si no encontramos coincidencia pero parece ser un nombre (más de 3 chars, no solo números/guiones)
          if (subjIdStr.length >= 4 && subjIdStr.match(/[a-záéíóúñ]/i)) {
            console.log(`📝 Using subjectId as subject name: ${subjIdStr}`);
            nameSet.add(subjIdStr);
            return;
          }
        }
        
        // ESTRATEGIA 2: Extraer desde el título de la calificación
        // Formato típico: "Matemática 2025-03-15" o "Lenguaje y Comunicación 2025-03-15"
        if (g.title) {
          // Quitar la fecha del final si existe (formato YYYY-MM-DD)
          let titleClean = g.title.replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();
          
          // Quitar palabras como TAREA, PRUEBA, EVALUACION del final
          titleClean = titleClean.replace(/\s*(tarea|prueba|evaluacion|evaluación)\s*$/i, '').trim();
          
          // Si quedó algo con longitud razonable, usarlo
          if (titleClean.length >= 4 && titleClean.length <= 50) {
            // Verificar si coincide con alguna asignatura del catálogo (case insensitive)
            const matchInCatalog = subjects.find(su => 
              su.name.toLowerCase() === titleClean.toLowerCase()
            );
            
            if (matchInCatalog) {
              console.log(`✅ Found subject from title in catalog: ${matchInCatalog.name}`);
              nameSet.add(matchInCatalog.name);
            } else {
              console.log(`📝 Using title as subject name: ${titleClean}`);
              nameSet.add(titleClean);
            }
          }
        }
      });
      
      console.log(`📝 [subjectOptions] Subjects extracted from grades:`, Array.from(nameSet));
    }
    
    let names = Array.from(nameSet);
    
    // Profesor: no hacer fallback a catálogo global; solo mostrar sus asignaturas asignadas
    if (user?.role === 'teacher') {
      // mantener únicamente las asignadas; si no hay, se mostrará solo la opción "Todas"
    } else if (user?.role === 'student') {
      // Estudiante: si no hay subjects desde assignments (poco probable), fallback al catálogo global
      if (names.length === 0) {
        names = Array.from(new Set(subjects.map(su => su.name)));
      }
      // En estudiante mantenemos 'all' pero si hay solo su sección y nombres presentes, no agregamos nada más
    } else {
      // Admin: si aún no hay subjects, usar catálogo global
      if (names.length === 0) {
        console.log(`🔄 [subjectOptions] Using global subjects catalog`);
        names = Array.from(new Set(subjects.map(su => su.name)));
      }
    }
    
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    names.forEach(n => opts.push({ value: n, label: n }));
    
    console.log(`✅ [subjectOptions] Final subjects:`, names);
    return opts;
  }, [translate, visibleSectionIds, teacherAssignments, user, allowed.subjects, subjects, isSQLConnected, activitiesSQL, grades]);

  // Niveles permitidos para el profesor según sus secciones activas
  const teacherLevelsAllowed = useMemo(() => {
    const set = new Set<'basica' | 'media'>();
    try {
      if (user?.role === 'admin') { set.add('basica'); set.add('media'); return set; }
      
      // 🎓 APODERADO: Niveles según secciones de sus estudiantes
      if (user?.role === 'guardian') {
        guardianStudents.forEach(student => {
          const assign = studentAssignments.find(a => 
            String(a.studentId) === String(student.id) || 
            String(a.studentUsername) === String(student.username)
          );
          if (assign?.sectionId) {
            const sec = sections.find(s => String(s.id) === String(assign.sectionId));
            const crs = sec ? courseById.get(String(sec.courseId)) : undefined;
            const lvl = getCourseLevel(crs?.name || undefined);
            if (lvl) set.add(lvl);
          }
        });
        if (set.size === 0) { set.add('basica'); set.add('media'); }
        return set;
      }
      
      // 1) Derivar por secciones explícitamente permitidas (aplica a profesor y estudiante)
      sections.forEach(sec => {
        if (!allowed.sections.has(String(sec.id))) return;
        const course = courseById.get(String(sec.courseId));
        const lvl = getCourseLevel(course?.name || undefined);
        if (lvl) set.add(lvl);
      });
      // 2) Complementar solo para profesor con teacherAssignments cuando falte info
      if (user?.role === 'teacher' && set.size === 0) {
        try {
          teacherAssignments.forEach(a => {
            if (!a) return;
            if (a.sectionId) {
              const sec = sections.find(s => String(s.id) === String(a.sectionId));
              const crs = sec ? courseById.get(String(sec.courseId)) : undefined;
              const lvl = getCourseLevel(crs?.name || undefined);
              if (lvl) set.add(lvl);
            }
            if (a.courseId) {
              const crs = courseById.get(String(a.courseId));
              const lvl = getCourseLevel(crs?.name || undefined);
              if (lvl) set.add(lvl);
            }
          });
        } catch {}
      }
      // Si aún no se pudo derivar, no asumir ambos a menos que sea estrictamente necesario.
      if (set.size === 0) { set.add('basica'); set.add('media'); }
    } catch { set.add('basica'); set.add('media'); }
    return set;
  }, [user, allowed.sections, sections, courseById, teacherAssignments, guardianStudents, studentAssignments]);

  // Pre-filtro de nivel para profesor: si solo tiene un nivel (básica o media), fijarlo automáticamente
  useEffect(() => {
    try {
      if (!user || user.role !== 'teacher') return;
      // Derivar niveles desde secciones permitidas
      const levels = new Set<'basica' | 'media'>();
      sections.forEach(sec => {
        if (!allowed.sections.has(String(sec.id))) return;
        const course = courseById.get(String(sec.courseId));
        const lvl = getCourseLevel(course?.name || undefined);
        if (lvl) levels.add(lvl);
      });
      if (levels.size === 1) {
        const only = Array.from(levels)[0];
        if (levelFilter !== only) setLevelFilter(only);
      }
    } catch {}
  }, [user, allowed.sections, sections, courseById]);

  // Auto-selección para estudiante: nivel/curso/sección/estudiante propios
  useEffect(() => {
    try {
      if (!user || user.role !== 'student') return;
      const assign = studentAssignments.find(a => String(a.studentId) === String((user as any).id) || String(a.studentUsername) === String(user.username));
      if (!assign || !assign.sectionId) return;
      const sec = sections.find(s => String(s.id) === String(assign.sectionId));
      if (!sec) return;
      const course = courseById.get(String(sec.courseId));
      const lvl = getCourseLevel(course?.name || undefined);
      if (lvl && levelFilter !== lvl) setLevelFilter(lvl);
      const secId = String(sec.id);
      const courseId = String(sec.courseId);
      if (comboSectionId !== secId) setComboSectionId(secId);
      if (cascadeSectionId !== secId) setCascadeSectionId(secId);
      if (cascadeCourseId !== courseId) setCascadeCourseId(courseId);
      if (String(studentFilter) !== String((user as any).id)) setStudentFilter(String((user as any).id));
      // No forzar subjectFilter; mantener 'all' para ver todas las asignaturas disponibles
    } catch {}
  }, [user, studentAssignments, sections, courseById]);

  // Estudiantes reales de Gestión de Usuarios para las secciones visibles
  const studentsInView = useMemo(() => {
    // Recolectar IDs/usuarios asignados a las secciones visibles
    const ids = new Set<string>();
    studentAssignments.forEach(a => {
      if (a && a.sectionId && visibleSectionIds.has(String(a.sectionId))) {
        if (a.studentId) ids.add(String(a.studentId));
        if (a.studentUsername) ids.add(String(a.studentUsername));
      }
    });
    
    console.log(`🔍 [studentsInView] visibleSectionIds:`, Array.from(visibleSectionIds));
    console.log(`🔍 [studentsInView] studentAssignments total:`, studentAssignments.length);
    console.log(`🔍 [studentsInView] studentAssignments sample:`, studentAssignments.slice(0, 3));
    console.log(`🔍 [studentsInView] ids recolectados:`, ids.size, Array.from(ids).slice(0, 5));
    
    // Filtrar usuarios que pertenecen a esas secciones
    let list = users.filter(u => {
      const sid = u && (u.id != null ? String(u.id) : undefined);
      const uname = u && u.username ? String(u.username) : undefined;
      return (sid && ids.has(sid)) || (uname && ids.has(uname));
    });
    
    console.log(`🔍 [studentsInView] usuarios filtrados:`, list.length);
    console.log(`🔍 [studentsInView] usuarios sample:`, list.slice(0, 3).map(u => ({ id: u.id, username: u.username, name: u.displayName })));
    // Rol estudiante: sólo su propio registro
    if (user?.role === 'student') {
      list = list.filter(u => String(u.id) === String((user as any).id) || String(u.username) === String(user.username));
    }
    // Filtro por estudiante seleccionado en cascada
    if (studentFilter !== 'all') {
      list = list.filter(u => String(u.id) === String(studentFilter) || String(u.username) === String(studentFilter));
    }
    // Ordenar por Curso-Sección y nombre
    list.sort((a: any, b: any) => {
      const assignA = studentAssignments.find(as => as && as.sectionId && visibleSectionIds.has(String(as.sectionId)) && (String(as.studentId) === String(a.id) || String(as.studentUsername) === String(a.username)));
      const assignB = studentAssignments.find(as => as && as.sectionId && visibleSectionIds.has(String(as.sectionId)) && (String(as.studentId) === String(b.id) || String(as.studentUsername) === String(b.username)));
      const secA = sections.find(s => String(s.id) === String(assignA?.sectionId));
      const secB = sections.find(s => String(s.id) === String(assignB?.sectionId));
      const courseA = courseById.get(String(secA?.courseId));
      const courseB = courseById.get(String(secB?.courseId));
      const rA = courseRank(courseA?.name);
      const rB = courseRank(courseB?.name);
      if (rA !== rB) return rA - rB;
      const sA = sectionRank(secA?.name);
      const sB = sectionRank(secB?.name);
      if (sA !== sB) return sA - sB;
      return String(a.displayName || a.name || a.username || '').localeCompare(String(b.displayName || b.name || b.username || ''), undefined, { sensitivity: 'base' });
    });
    return list;
  }, [users, studentAssignments, visibleSectionIds, user, studentFilter, sections, courseById]);

  // 🆕 DESHABILITADO: Este useEffect duplicaba la lógica de cálculo de asistencia 
  // que ya está implementada de forma más completa en el useEffect principal (~línea 467-865).
  // Mantenerlo activo causaba una condición de carrera donde sobrescribía los resultados correctos.
  // useEffect(() => {
  /*
  useEffect(() => {
    const loadAttendance = async () => {
      if (!selectedYear || !getAttendanceByYear) return;

      // Si es estudiante, ya se maneja en el otro useEffect
      if (user?.role === 'student') return;

      // Para Admin/Profesor:
      // Si no hay secciones visibles, no mostrar nada
      if (!visibleSectionIds || visibleSectionIds.size === 0) {
        setStudentAttendanceStats(null);
        return;
      }

      try {
        console.log('🔄 [Asistencia] Cargando registros para año:', selectedYear);
        const records = await getAttendanceByYear(selectedYear);
        if (!records || records.length === 0) {
          console.log('⚠️ [Asistencia] No se encontraron registros para el año');
          // Si no hay registros pero hay filtros activos, mostrar 0% en lugar de ocultar
          setStudentAttendanceStats({ avg: 0, present: 0, late: 0, absent: 0, excused: 0 });
          return;
        }

        console.log(`📊 [Asistencia] ${records.length} registros cargados.`);

        let filtered = records;

        // 1. Filtrar por Estudiante (Prioridad Alta)
        if (studentFilter && studentFilter !== 'all') {
             console.log(`👤 [Asistencia] Filtrando por estudiante ID/User: ${studentFilter}`);
             
             // Buscar al estudiante en la lista de usuarios para obtener todos sus identificadores
             // (UUID, Username/RUT, etc.)
             const studentObj = users.find(u => String(u.id) === String(studentFilter) || String(u.username) === String(studentFilter));
             
             const possibleIds = new Set<string>();
             possibleIds.add(String(studentFilter));
             if (studentObj) {
                if (studentObj.id) possibleIds.add(String(studentObj.id));
                if (studentObj.username) possibleIds.add(String(studentObj.username));
                if (studentObj.rut) possibleIds.add(String(studentObj.rut));
             }
             
             console.log(`👤 [Asistencia] Identificadores posibles del estudiante:`, Array.from(possibleIds));

             filtered = records.filter((r: any) => 
                possibleIds.has(String(r.studentId)) || 
                possibleIds.has(String(r.studentUsername)) ||
                (r.studentId && possibleIds.has(String(r.studentId).trim()))
             );
             console.log(`✅ [Asistencia] ${filtered.length} registros encontrados para el estudiante.`);
        } else {
            // 2. Si no hay estudiante seleccionado, filtrar por Secciones Visibles (Lógica "Brute Force")
            // Construir mapa de claves compuestas permitidas: "curso_normalizado|letra_seccion"
            const allowedKeys = new Set<string>();
            
            visibleSectionIds.forEach(secId => {
              const sec = sections.find(s => String(s.id) === String(secId));
              if (!sec) return;
              const course = courses.find(c => String(c.id) === String(sec.courseId));
              if (!course) return;

              // Normalizar nombre de curso (ej: "1ro Básico" -> "1ro_basico")
              const normalize = (name: string) => {
                return name.toLowerCase()
                  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                  .replace(/\s+/g, '_')
                  .trim();
              };
              
              // Normalizar letra de sección (ej: "A " -> "A")
              const normalizeSection = (name: string) => {
                const trimmed = name.trim();
                if (trimmed.length === 1) return trimmed;
                const m = trimmed.match(/([A-Z])$/i);
                return m ? m[1] : trimmed;
              };

              const cName = normalize(course.name);
              const sName = normalizeSection(sec.name);
              const sNameRaw = sec.name.trim();
              
              // Generar todas las combinaciones posibles de llaves
              const keysToAdd = [
                `${cName}|${sName}`, // 1ro_basico|A
                `${String(course.id)}|${String(sec.id)}`, // UUID|UUID
                `${String(course.id)}|${sName}`, // UUID|A
                `${String(course.id)}|${sNameRaw}`, // UUID|A 
                `${cName}|${String(sec.id)}`, // 1ro_basico|UUID
                `${cName.replace(/_basico/, '_básico')}|${sName}`, // 1ro_básico|A
                `${course.name}|${sec.name}`, // Nombre Real|Nombre Real
                `${course.name}|${sName}` // Nombre Real|A
              ];

              keysToAdd.forEach(k => allowedKeys.add(k));
            });

            // Filtrar registros por sección
            filtered = records.filter((r: any) => {
              const k1 = `${r.courseId}|${r.sectionId}`;
              const k2 = `${r.courseId}|${String(r.sectionId).trim()}`;
              // Soporte para registros que usan 'curso' y 'seccion' en lugar de IDs
              const k3 = `${r.curso}|${r.seccion}`;
              return allowedKeys.has(k1) || allowedKeys.has(k2) || allowedKeys.has(k3);
            });
            
            console.log(`✅ [Asistencia] ${filtered.length} registros coinciden con la sección (Vista General).`);
        }

        // Filtrar por semestre si aplica
        if (semester !== 'all') {
           let startTs = 0, endTs = 0;
           if (semestersCfg) {
             const getRange = (sem: '1' | '2') => {
               if (sem === '1') return { start: semestersCfg.first?.start, end: semestersCfg.first?.end };
               return { start: semestersCfg.second?.start, end: semestersCfg.second?.end };
             };
             const range = getRange(semester as '1' | '2');
             if (range.start && range.end) {
               startTs = new Date(range.start).getTime();
               endTs = new Date(range.end).getTime();
             }
           }
           
           if (startTs && endTs) {
             filtered = filtered.filter((r: any) => {
               const d = new Date(r.date).getTime();
               return d >= startTs && d <= endTs;
             });
           } else {
             // Fallback meses
             filtered = filtered.filter((r: any) => {
               const m = new Date(r.date).getMonth(); // 0-11
               // Sem 1: Ene(0) - Jun(5)
               // Sem 2: Jul(6) - Dic(11)
               return semester === '1' ? m <= 5 : m >= 6;
             });
           }
           console.log(`✅ [Asistencia] ${filtered.length} registros después de filtro semestre (${semester}).`);
        }

        // Calcular estadísticas
        let present = 0, late = 0, absent = 0, excused = 0;
        filtered.forEach((r: any) => {
          const s = String(r.status).toLowerCase();
          if (s === 'present' || s === 'presente') present++;
          else if (s === 'late' || s === 'atrasado') late++;
          else if (s === 'absent' || s === 'ausente') absent++;
          else if (s === 'excused' || s === 'justificado') excused++;
        });

        const total = present + late + absent + excused;
        const positive = present + late;

        console.log(`📈 [Asistencia] Stats finales: Total=${total}, Pos=${positive}, Avg=${total > 0 ? Math.round((positive / total) * 100) : 0}`);

        // Mostrar resultado (incluso si es 0, para confirmar que funciona)
        setStudentAttendanceStats({
          avg: total > 0 ? Math.round((positive / total) * 100) : 0,
          present,
          late,
          absent,
          excused
        });

      } catch (e) {
        console.error('Error calculating attendance stats:', e);
        // En caso de error, mostrar 0 en lugar de ocultar si hay filtros
        setStudentAttendanceStats({ avg: 0, present: 0, late: 0, absent: 0, excused: 0 });
      }
    };

    loadAttendance();
  }, [user, selectedYear, getAttendanceByYear, visibleSectionIds, sections, courses, semester, semestersCfg, studentFilter, users]);
  */ // FIN del useEffect duplicado comentado

  // 🔧 Cargar todas las actividades (tareas, evaluaciones, pruebas) como useMemo
  const allTasks = useMemo(() => {
    try {
      const ensureUnique = (items: any[]) => {
        const seen = new Map<string, number>();
        return items.map((item: any) => {
          const base = String(item?.id || Math.random());
          const count = (seen.get(base) || 0) + 1;
          seen.set(base, count);
          if (count === 1) return item; // Primera instancia, usar tal cual
          return { ...item, originalId: base, id: `${base}__dup${seen}` };
        });
      };
      
      const tasks = isSQLConnected
        ? ensureUnique((activitiesSQL || []).filter((a: any) => String(a.taskType) === 'tarea').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Tarea'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            subjectId: a.subjectId ?? null,
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: String(a.dueDate || a.createdAt || new Date().toISOString()),
            createdAt: String(a.createdAt || new Date().toISOString()),
            status: String(a.status || 'pending'),
            priority: 'medium',
            taskType: 'tarea' as const,
          })))
        : ensureUnique(Array.isArray(JSON.parse(localStorage.getItem('smart-student-tasks') || '[]')) ? JSON.parse(localStorage.getItem('smart-student-tasks') || '[]') : []);
      
      const evaluations = isSQLConnected
        ? ensureUnique((activitiesSQL || []).filter((a: any) => String(a.taskType) === 'evaluacion').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Evaluación'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: String(a.dueDate || a.createdAt || new Date().toISOString()),
            createdAt: String(a.createdAt || new Date().toISOString()),
            status: String(a.status || 'finished'),
            priority: 'medium',
            taskType: 'evaluacion' as const,
          })))
        : ensureUnique(Array.isArray(JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]')) ? JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]') : []);
      
      const tests: any[] = isSQLConnected
        ? ensureUnique((activitiesSQL || []).filter((a: any) => String(a.taskType) === 'prueba').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Prueba'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            subjectId: a.subjectId ?? null,
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: toIso(a.createdAt || Date.now()),
            createdAt: toIso(a.createdAt || Date.now()),
            status: 'pending',
            priority: 'medium',
            taskType: 'prueba' as const,
            topic: String(a.title || ''),
          })))
        : (() => {
            const acc: any[] = [];
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || !key.startsWith('smart-student-tests')) continue;
                const arr = JSON.parse(localStorage.getItem(key) || '[]');
                if (Array.isArray(arr)) acc.push(...arr);
              }
            } catch {}
            return ensureUnique(acc);
          })();
      
      console.log(`📊 Cargando actividades: ${tasks.length} tareas, ${evaluations.length} evaluaciones, ${tests.length} pruebas`);
      
      return [
        ...tasks.map((t: any) => ({ ...t, taskType: t.taskType || 'tarea' })),
        ...evaluations.map((e: any) => ({ ...e, taskType: 'evaluacion' })),
        ...tests.map((t: any) => ({
          ...t,
          taskType: 'prueba',
          subject: t.subjectName || t.subjectId || 'General',
          subjectId: t.subjectId ?? null,
          courseId: t.courseId ?? null,
          sectionId: t.sectionId ?? null,
          createdAt: toIso(t.createdAt ?? Date.now()),
          status: 'pending',
        }))
      ];
    } catch (error) {
      console.error('Error cargando allTasks:', error);
      return [];
    }
  }, [isSQLConnected, activitiesSQL]);

  // 🔥 Carga directa desde Firebase/Firestore según filtros activos (año + secciones visibles)
  // Obtiene notas por cada par (courseId, letra de sección) y NORMALIZA sectionId a UUID para alinear con la UI
  // ⚠️ TEMPORALMENTE DESHABILITADO - usando getGradesByYear del hook en su lugar
  const firebaseFetchRef = useRef<{ abort?: boolean; timer?: any }>({});
  useEffect(() => {
    // 🚫 DESHABILITADO TEMPORALMENTE PARA DEBUGGING
    return;
    
    // Requiere al menos una sección visible y un año válido
    if (typeof window === 'undefined') return;
    if (!visibleSectionIds || visibleSectionIds.size === 0) return;
    if (!selectedYear) return;
    // Cargar sólo cuando hay contexto de sección seleccionado explícitamente
    const hasSelectedSection = Boolean(cascadeSectionId) || (comboSectionId && comboSectionId !== 'all');
    if (!hasSelectedSection) return;

    // Evitar consultas cuando no se ha seleccionado contexto mínimo (manejamos semestre más abajo en UI)
    // Aquí consultamos por año + sección; el semestre se filtra en cliente por fechas.

    // Debounce para evitar ráfagas al mover filtros rápido
    if (firebaseFetchRef.current.timer) clearTimeout(firebaseFetchRef.current.timer);
    const localToken = { abort: false } as { abort: boolean };
    firebaseFetchRef.current.abort = false;
    firebaseFetchRef.current.timer = setTimeout(async () => {
      try {
        // Cerrar si cancelado
        if (localToken.abort) return;
        const { getFirestoreInstance } = await import('@/lib/firebase-config');
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const db = getFirestoreInstance();
        if (!db) {
          console.warn('⚠️ Firebase no inicializado: no se puede consultar notas');
          return;
        }

        // 🔧 Helper para normalizar courseId al formato de Firebase (1ro_basico, etc)
        const toFirebaseCourseId = (courseName: string): string => {
          return String(courseName || '')
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[áàäâ]/g, 'a')
            .replace(/[éèëê]/g, 'e')
            .replace(/[íìïî]/g, 'i')
            .replace(/[óòöô]/g, 'o')
            .replace(/[úùüû]/g, 'u')
            .replace(/ñ/g, 'n')
            .replace(/[^a-z0-9_\-]/g, '');
        };

        // Derivar pares (courseId, letter) desde las secciones visibles
        type Pair = { courseId: string; firebaseCourseId: string; letter: string; sectionUuid: string };
        const pairs: Pair[] = [];
        Array.from(visibleSectionIds).forEach(secId => {
          const sec = sections.find(s => String(s.id) === String(secId));
          if (!sec) return;
          const courseUuid = String(sec.courseId || '');
          // 🔥 Buscar el nombre del curso para normalizar al formato de Firebase
          const courseObj = courses.find(c => String(c.id) === courseUuid);
          const courseName = courseObj?.name || '';
          const firebaseCourseId = toFirebaseCourseId(courseName);
          
          // Extraer la letra real de la sección (no el nombre completo)
          const extractLetter = (name?: string): string | null => {
            if (!name) return null;
            const trimmed = String(name).trim();
            if (/^[A-Za-zÑñ]$/.test(trimmed)) return trimmed.toLowerCase();
            const m = trimmed.match(/([A-Za-zÑñ])\s*$/);
            if (m) return m[1].toLowerCase();
            const last = trimmed.split(/\s+/).pop() || '';
            if (/^[A-Za-zÑñ]$/.test(last)) return last.toLowerCase();
            if (/^[A-Za-zÑñ]$/.test(last.slice(-1))) return last.slice(-1).toLowerCase();
            return null;
          };
          const letter = (sec as any).letter ? String((sec as any).letter).trim().toLowerCase() : (extractLetter(sec.name) || '');
          if (!firebaseCourseId || !letter) return;
          pairs.push({ courseId: courseUuid, firebaseCourseId, letter, sectionUuid: String(sec.id) });
        });

        if (pairs.length === 0) return;

        console.log('🔎 [Firebase] Consultando calificaciones por pares curso/letra:', pairs.slice(0, 5));

        const all: TestGrade[] = [];

        // Ejecutar en serie para evitar demasiadas lecturas en paralelo (pares suelen ser pocos)
        for (const p of pairs) {
          if (localToken.abort) return;
          // 🔥 USAR firebaseCourseId en lugar de courseId (UUID)
          const colRef = collection(db as any, 'courses', p.firebaseCourseId, 'grades');
          
          // 🎯 Helper para procesar documentos y evitar duplicados
          const processedIds = new Set<string>();
          const processDoc = (doc: any) => {
            if (processedIds.has(doc.id)) return; // Skip duplicados
            processedIds.add(doc.id);
            
            const d: any = doc.data() || {};
            // gradedAt → ms
            const gradedAtMs = (() => {
              const v = d.gradedAt;
              if (!v) {
                // 🔥 FALLBACK: Extraer timestamp del ID del documento
                const docId = String(doc.id);
                const parts = docId.split('-');
                if (parts.length > 0) {
                  const lastPart = parts[parts.length - 1];
                  const ts = parseInt(lastPart, 10);
                  if (!isNaN(ts) && ts > 1000000000000) {
                    return ts;
                  }
                }
                return 0;
              }
              if (typeof v === 'number' && isFinite(v)) return v;
              if (typeof v === 'string') {
                const ts = normalizeGradedAt(v);
                return isFinite(ts) ? ts : 0;
              }
              if (v && typeof (v as any).toMillis === 'function') return (v as any).toMillis();
              try {
                const d2 = new Date(v as any);
                if (isFinite(d2.getTime())) return d2.getTime();
              } catch {}
              return 0;
            })();
            // Mapear a TestGrade esperado por UI; sectionId normalizado a UUID
            const tg: TestGrade = {
              id: String(doc.id),
              testId: String(d.testId || d.id || doc.id),
              studentId: String(d.studentId || ''),
              studentName: String(d.studentName || ''),
              score: Number(d.score || 0),
              courseId: String(p.courseId),
              sectionId: String(p.sectionUuid),
              subjectId: d.subject || d.subjectId || null,
              title: d.title,
              gradedAt: gradedAtMs,
            };
            all.push(tg);
          };
          
          // 🔥 OPTIMIZADO: Hacer UNA sola consulta preferiendo UUID (formato actual de carga masiva)
          // Si no encuentra por UUID, intentar por letra como fallback
          let foundGrades = false;
          
          // Primero intentar con UUID de sección (formato de carga masiva)
          if (p.sectionUuid && p.sectionUuid.length > 10) {
            const qUuid = query(colRef, where('year', '==', selectedYear), where('sectionId', '==', p.sectionUuid));
            const snapUuid = await getDocs(qUuid);
            if (snapUuid.size > 0) {
              snapUuid.forEach(processDoc);
              foundGrades = true;
              console.log(`✅ [Firebase] ${snapUuid.size} calificaciones por UUID para ${p.firebaseCourseId}/${p.sectionUuid}`);
            }
          }
          
          // Fallback: buscar por letra solo si no se encontró nada por UUID
          if (!foundGrades && p.letter) {
            const qLetter = query(colRef, where('year', '==', selectedYear), where('sectionId', '==', p.letter));
            const snapLetter = await getDocs(qLetter);
            snapLetter.forEach(processDoc);
            if (snapLetter.size === 0 && p.letter !== p.letter.toUpperCase()) {
              // Intentar mayúscula solo si minúscula no encontró nada
              const qUpper = query(colRef, where('year', '==', selectedYear), where('sectionId', '==', p.letter.toUpperCase()));
              const snapUpper = await getDocs(qUpper);
              snapUpper.forEach(processDoc);
            }
          }
        }

        if (localToken.abort) return;
        console.log(`✅ [Firebase] Cargadas ${all.length} calificaciones desde Firestore para ${selectedYear}`);
        setGrades(all);
      } catch (err) {
        console.error('❌ Error consultando calificaciones desde Firebase:', err);
      }
    }, 200);

    return () => {
      localToken.abort = true;
      if (firebaseFetchRef.current.timer) clearTimeout(firebaseFetchRef.current.timer);
    };
  }, [selectedYear, visibleSectionIds, sections, cascadeSectionId, comboSectionId]);

  // 🔧 Construcción de createdMap: mapa de timestamps para ordenar grades
  // Se llena desde localStorage Y desde allTasks
  const buildCreatedMap = (tasks: any[]) => {
    const map = new Map<string, number>();
    
    // Primero, cargar desde localStorage (legacy)
    try {
      const tks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
      tks.forEach((t: any) => {
        const raw = t.createdAt || t.startAt || t.openAt || t.dueDate;
        const ts = Date.parse(String(raw || ''));
        if (!isNaN(ts)) map.set(String(t.id), ts);
      });
      const evals = JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]');
      evals.forEach((e: any) => {
        const id = String(e.id ?? e.evaluationId ?? e.uid ?? '');
        const ts = Date.parse(String(e.createdAt || e.openAt || e.startAt || e.dueDate || ''));
        if (id && !isNaN(ts)) map.set(id, ts);
      });
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith('smart-student-tests')) continue;
          const arr = JSON.parse(localStorage.getItem(key) || '[]');
          if (Array.isArray(arr)) {
            arr.forEach((t: any) => {
              const id = String(t?.id || '');
              const ts = Number(t?.createdAt || 0);
              if (id && Number.isFinite(ts) && ts > 0) map.set(id, ts);
            });
          }
        }
      } catch {}
    } catch (e) {
      console.error(`❌ Error cargando createdMap desde localStorage:`, e);
    }
    
    // 🔧 AHORA: Llenar desde tasks (Firebase/SQL)
    // Esto asegura que las actividades cargadas desde Firebase tengan sus timestamps
    if (Array.isArray(tasks) && tasks.length > 0) {
      tasks.forEach((task: any) => {
        const id = String(task.id || '');
        const raw = task.createdAt || task.startAt || task.openAt || task.dueDate;
        const ts = Date.parse(String(raw || ''));
        if (id && !isNaN(ts)) {
          // No sobrescribir si ya existe en localStorage (dar prioridad a localStorage)
          if (!map.has(id)) {
            map.set(id, ts);
          }
        }
      });
    }
    
    console.log(`🔍 [createdMap] Total entradas: ${map.size}`);
    if (map.size > 0) {
      const samples = Array.from(map.entries()).slice(0, 3);
      console.log(`🔍 [createdMap] Muestra de fechas:`, samples.map(([id, ts]) => ({
        id,
        fecha: new Date(ts).toISOString().split('T')[0]
      })));
    }
    
    return map;
  };

  // Filtrar notas por secciones/rol/asignatura y semestre
  const filteredGrades = useMemo(() => {
    console.log(`🔍 [filteredGrades] Iniciando filtrado...`);
    console.log(`🔍 [filteredGrades] grades.length:`, grades.length);
    console.log(`🔍 [filteredGrades] visibleSectionIds:`, Array.from(visibleSectionIds));
    console.log(`🔍 [filteredGrades] semester:`, semester);
    console.log(`🔍 [filteredGrades] subjectFilter:`, subjectFilter);
    console.log(`🔍 [filteredGrades] studentFilter:`, studentFilter);
    console.log(`🔍 [filteredGrades] user.role:`, user?.role);
    
    // � MOSTRAR MUESTRA DE CALIFICACIONES ANTES DE FILTRAR
    if (grades.length > 0) {
      console.log(`🔍 [filteredGrades] Muestra de grades (primeras 3):`, grades.slice(0, 3).map(g => ({
        studentName: g.studentName,
        score: g.score,
        courseId: g.courseId,
        sectionId: g.sectionId,
        subjectId: g.subjectId
      })));

      // 🧪 HISTORIA: Conteos previos por etapa (solo inicial aquí, otras etapas se loguean más abajo)
      try {
        const hAll = grades.filter(g => String(g.subjectId || '').toLowerCase().includes('historia'));
        if (hAll.length) {
          const hNullSection = hAll.filter(g => !g.sectionId).length;
          const distinctSections = new Set(hAll.map(g => String(g.sectionId || '∅')));
          console.log(`🧪 [HISTORIA PRE] Total=${hAll.length}, sinSection=${hNullSection}, secciones=${Array.from(distinctSections)}`);
        } else {
          console.log('🧪 [HISTORIA PRE] No hay calificaciones de Historia antes de filtrar');
        }
      } catch (e) {
        console.warn('🧪 [HISTORIA PRE] Error conteo inicial Historia:', e);
      }
    } else {
      console.warn(`⚠️ [filteredGrades] NO HAY CALIFICACIONES PARA FILTRAR`);
    }
    
    // �🔧 Construir createdMap con allTasks disponible
    const createdMap = buildCreatedMap(allTasks);
    
    // Helpers de fecha para semestre: parseo local de YYYY-MM-DD y comparación a nivel de día (ignora zona horaria)
    const parseYmdLocal = (ymd?: string) => {
      if (!ymd) return undefined as unknown as Date | undefined;
      const [y, m, d] = String(ymd).split('-').map(Number);
      if (!y || !m || !d) return undefined as unknown as Date | undefined;
      return new Date(y, (m || 1) - 1, d || 1);
    };
    const startEndFor = (cfg: any, which: '1' | '2') => {
      const start = parseYmdLocal(which === '1' ? cfg?.first?.start : cfg?.second?.start);
      const end = parseYmdLocal(which === '1' ? cfg?.first?.end : cfg?.second?.end);
      return { start, end } as { start?: Date; end?: Date };
    };
    const sameDayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

    // Índices de ayuda para profesor: asignaturas por sección
    const norm = (s: string) => normSubj(s);
    const subjNameById = new Map<string, string>();
    subjects.forEach(su => { subjNameById.set(String(su.id), String(su.name)); });
    const teacherSubjectsBySection = new Map<string, Set<string>>();
    if (user?.role === 'teacher') {
      teacherAssignments.forEach(a => {
        const isMine = String(a.teacherId) === String((user as any)?.id) || String(a.teacherUsername) === String(user?.username);
        if (!isMine || !a.sectionId) return;
        const secId = String(a.sectionId);
        if (!teacherSubjectsBySection.has(secId)) teacherSubjectsBySection.set(secId, new Set<string>());
        const set = teacherSubjectsBySection.get(secId)!;
        const list: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
        list.forEach(n => { if (n) set.add(norm(String(n))); });
      });
      // Extender con asignaturas detectadas desde actividades SQL para secciones visibles
      try {
        if (isSQLConnected && Array.isArray(activitiesSQL) && activitiesSQL.length) {
          activitiesSQL.forEach((a: any) => {
            const secId = a?.sectionId ? String(a.sectionId) : null;
            if (!secId || !visibleSectionIds.has(secId)) return;
            // Solo incluir actividades creadas por el profesor logueado
            const owner = String(a.assignedById || '');
            const myId = String((user as any)?.id || '');
            const myUsername = String(user?.username || '');
            if (owner && owner !== myId && owner !== myUsername) return;
            if (!teacherSubjectsBySection.has(secId)) teacherSubjectsBySection.set(secId, new Set<string>());
            const set = teacherSubjectsBySection.get(secId)!;
            const name = a.subjectName || a.subjectId || 'General';
            set.add(norm(String(name)));
          });
        }
      } catch {}
    }

  // 🔥 MAPA RUT → userId: Las calificaciones de Firebase usan RUT, pero studentAssignments usa user-xxx IDs
  const rutToUserId = new Map<string, string>();
  const userIdToRut = new Map<string, string>();
  users.forEach((u: any) => {
    const uid = String(u.id || '');
    const rut = String(u.rut || '').trim();
    if (uid && rut) {
      rutToUserId.set(rut, uid);
      userIdToRut.set(uid, rut);
    }
  });

  console.log(`🔍 [filteredGrades] Mapa RUT creado: ${rutToUserId.size} entradas`);
  if (rutToUserId.size > 0) {
    const samples = Array.from(rutToUserId.entries()).slice(0, 3);
    console.log(`🔍 [filteredGrades] Ejemplos RUT → userId:`, samples);
  }

  // 🔥 MAPA sectionId: Traducir letra ('a', 'b', ...) → UUID usando NOMBRES reales de las secciones por curso
  // Evita supuestos alfabéticos. Usamos la lista de sections del año seleccionado.
  const sectionIdTranslator = new Map<string, string>();
  const slugifyCourse = (name?: string) => {
    if (!name) return '';
    return String(name)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .trim();
  };
  // Mapa auxiliar: slug de nombre de curso → UUID
  const courseSlugToUuid = new Map<string, string>();
  try {
    courses.forEach(c => {
      const slug = slugifyCourse(c.name);
      if (slug) {
        courseSlugToUuid.set(slug, String(c.id));
        // Alias sin vocales comunes de importación masiva
        courseSlugToUuid.set(slug.replace('_basico', '_bsico'), String(c.id));
        courseSlugToUuid.set(slug.replace('_medio', '_mdio'), String(c.id));
      }
    });
  } catch {}
  const extractLetter = (name?: string): string | null => {
    if (!name) return null;
    const trimmed = String(name).trim();
    // Caso 1: nombre es solo la letra
    if (/^[A-Za-zÑñ]$/.test(trimmed)) return trimmed.toLowerCase();
    // Caso 2: última palabra/letra del nombre ("1ro Básico A", "Sección B")
    const m = trimmed.match(/([A-Za-zÑñ])\s*$/);
    if (m) return m[1].toLowerCase();
    // Caso 3: tomar última letra si es alfabética
    const last = trimmed.split(/\s+/).pop() || '';
    if (/^[A-Za-zÑñ]$/.test(last)) return last.toLowerCase();
    if (/^[A-Za-zÑñ]$/.test(last.slice(-1))) return last.slice(-1).toLowerCase();
    return null;
  };
  try {
    sections.forEach(sec => {
      const courseUuid = String(sec.courseId || '');
      const letter = (sec as any).letter ? String((sec as any).letter).trim().toLowerCase() : extractLetter(sec.name);
      const uuid = String(sec.id || '');
      if (courseUuid && letter && uuid) {
        // Clave por UUID (flujo normal)
        sectionIdTranslator.set(`${courseUuid}|${letter}`, uuid);
        // Clave por slug del nombre del curso (para datos importados con courseId='1ro_basico')
        const courseObj = courses.find(c => String(c.id) === courseUuid);
        const slug = courseObj ? slugifyCourse(courseObj.name) : '';
        if (slug) {
          sectionIdTranslator.set(`${slug}|${letter}`, uuid);
          // 🔥 TAMBIÉN agregar variante con el ID del curso directamente (por si el courseId es UUID)
          // Y agregar al mapa courseSlugToUuid el slug → UUID
          courseSlugToUuid.set(slug, courseUuid);
        }
      }
    });
  } catch {
    // fallback silencioso
  }

  // 🔍 DEBUG: Mostrar claves del mapa de traducción
  console.log(`🔍 [filteredGrades] Traductor sección creado: ${sectionIdTranslator.size} mapeos`);
  console.log(`🔍 [filteredGrades] courseSlugToUuid creado: ${courseSlugToUuid.size} mapeos`);
  if (sectionIdTranslator.size > 0) {
    const samples = Array.from(sectionIdTranslator.entries()).slice(0, 10);
    console.log(`🔍 [filteredGrades] Ejemplos traducción sección:`, samples);
  }
  if (courseSlugToUuid.size > 0) {
    const courseSamples = Array.from(courseSlugToUuid.entries()).slice(0, 10);
    console.log(`🔍 [filteredGrades] Ejemplos courseSlugToUuid:`, courseSamples);
  }

  // 🔍 DEBUG: Mostrar todas las asignaturas únicas en las calificaciones
  const uniqueSubjects = new Set<string>();
  grades.forEach(g => {
    if (g.subjectId) {
      const name = String(g.subjectId).replace(/_/g, ' ');
      uniqueSubjects.add(name);
    }
  });
    console.log(`🔍 [filteredGrades] Asignaturas únicas en calificaciones (${uniqueSubjects.size}):`, Array.from(uniqueSubjects));
    // 🧪 EXTRA DEBUG HISTORIA: listar primeras 10 calificaciones relacionadas a Historia para verificar normalización
    try {
      const historiaGrades = grades.filter(g => {
        const sid = String(g.subjectId || '').toLowerCase();
        // subjectId puede venir con guiones o espacios ya normalizados
        return sid.includes('historia') || sid.includes('geografia');
      }).slice(0, 10);
      if (historiaGrades.length) {
        console.log(`🧪 [HISTORIA DEBUG] Muestra (${historiaGrades.length}) subjectId/raw → canon + sectionId + gradedAt (YYYY-MM)`,
          historiaGrades.map(g => {
            const raw = String(g.subjectId || '').replace(/_/g, ' ');
            const canon = canonicalSubject(raw);
            const dt = g.gradedAt ? new Date(g.gradedAt) : null;
            const ym = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}` : 'N/A';
            return { testId: g.testId, raw, canon, sectionId: g.sectionId || null, ym };
          })
        );
      } else {
        console.log('🧪 [HISTORIA DEBUG] No se detectaron calificaciones de Historia en grades actuales');
      }
    } catch (e) {
      console.warn('🧪 [HISTORIA DEBUG] Error generando muestra Historia:', e);
    }
  console.log(`🔍 [filteredGrades] Filtro de asignatura seleccionado: "${subjectFilter}"`);
  console.log(`🔍 [filteredGrades] Filtro normalizado: "${normSubj(subjectFilter)}"`);

  let afterSectionFilter = 0;
  let afterRoleFilter = 0;
  let afterSubjectFilter = 0;
  let afterSemesterFilter = 0;
  let afterStudentFilter = 0;
  
  // 🔥 DEBUG: Contar calificaciones con/sin sectionId y con/sin conversión
  let gradesWithSectionId = 0;
  let gradesWithoutSectionId = 0;
  let gradesConverted = 0;
  let gradesSectionMatch = 0;

  // 🔍 DEBUG: Mostrar primeras 5 calificaciones recibidas antes del filtro
  console.log(`📊 [filteredGrades] Total grades recibidas: ${grades.length}, visibleSectionIds: ${visibleSectionIds.size}`);
  if (grades.length > 0) {
    console.log(`📊 [filteredGrades] Muestra primeras 3 calificaciones:`, grades.slice(0, 3).map(g => ({
      testId: g.testId,
      studentId: g.studentId,
      courseId: g.courseId,
      sectionId: g.sectionId,
      subjectId: g.subjectId,
      score: g.score,
      gradedAt: g.gradedAt
    })));
    console.log(`📊 [filteredGrades] visibleSectionIds:`, Array.from(visibleSectionIds).slice(0, 5));
  }

  const list = grades.filter(g => {
      // 🔥 NORMALIZAR studentId: Si la calificación tiene RUT, convertir a userId
      const originalStudentId = String(g.studentId || '');
      const normalizedStudentId = rutToUserId.get(originalStudentId) || originalStudentId;
      
      if (normalizedStudentId !== originalStudentId) gradesConverted++;

      // Filtrar por sección visible; si no hay sectionId en la nota, inferir por asignación del estudiante.
      // Relajación para Admin: si no se puede inferir (faltan asignaciones), NO excluir la nota por sección.
      if (g.sectionId) {
        gradesWithSectionId++;
        
        // 🔥 TRADUCIR sectionId: Si es letra, convertir a UUID usando courseId
        let effectiveSectionId = String(g.sectionId);
        const courseIdRaw = String(g.courseId || '');
        
        // 🔍 DEBUG: Mostrar primeras 5 traducciones intentadas
        const shouldLogTranslation = gradesWithSectionId <= 5;
        
        // Si sectionId es corta (letra) y tenemos courseId, intentar traducir
        if (effectiveSectionId.length <= 2 && courseIdRaw) {
          const letterKey = String(effectiveSectionId).trim().toLowerCase();
          
          if (shouldLogTranslation) {
            console.log(`🔄 [TRANSLATE] testId=${g.testId}, sectionId="${effectiveSectionId}", courseId="${courseIdRaw}", letterKey="${letterKey}"`);
          }
          
          // 1) Intentar con courseId tal cual (UUID esperado)
          let translatedId = sectionIdTranslator.get(`${courseIdRaw}|${letterKey}`);
          
          if (shouldLogTranslation && translatedId) {
            console.log(`  ✅ [1] Encontrado por courseId directo: ${translatedId}`);
          }
          
          // 2) Si no existe, intentar con slug del courseId (para casos '1ro_basico')
          if (!translatedId) {
            const slug = slugifyCourse(courseIdRaw);
            if (shouldLogTranslation) {
              console.log(`  🔍 [2] Intentando slug="${slug}", key="${slug}|${letterKey}"`);
            }
            if (slug) translatedId = sectionIdTranslator.get(`${slug}|${letterKey}`);
            
            if (shouldLogTranslation && translatedId) {
              console.log(`  ✅ [2] Encontrado por slug: ${translatedId}`);
            }
          }
          // 3) Si aún no existe y courseIdRaw no parece UUID, intentar mapear a UUID vía catálogo de cursos
          if (!translatedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseIdRaw)) {
            const maybeUuid = courseSlugToUuid.get(slugifyCourse(courseIdRaw));
            if (shouldLogTranslation) {
              console.log(`  🔍 [3] Buscando UUID en courseSlugToUuid para slug="${slugifyCourse(courseIdRaw)}", maybeUuid=${maybeUuid}`);
            }
            if (maybeUuid) translatedId = sectionIdTranslator.get(`${maybeUuid}|${letterKey}`);
            
            if (shouldLogTranslation && translatedId) {
              console.log(`  ✅ [3] Encontrado por courseSlugToUuid: ${translatedId}`);
            }
          }
          if (translatedId) {
            effectiveSectionId = translatedId;
          }
          
          if (shouldLogTranslation && !translatedId) {
            console.log(`  ❌ No se pudo traducir. Claves en translator:`, Array.from(sectionIdTranslator.keys()).slice(0, 10));
            console.log(`  ❌ Claves en courseSlugToUuid:`, Array.from(courseSlugToUuid.keys()).slice(0, 10));
          }
        }
        
        const secMatch = visibleSectionIds.has(effectiveSectionId);
        // 🛠️ Fallback: si no hay match directo porque la calificación trae sólo la letra ('a','b', etc.)
        // intentar resolver por letra buscando una sección visible cuyo nombre termine en esa letra.
        let finalSecMatch = secMatch;
        const letterCandidate = String(g.sectionId || '').trim().toLowerCase();
        if (!finalSecMatch && letterCandidate && letterCandidate.length === 1) {
          // Buscar sección cuyo id esté en visibleSectionIds y cuyo nombre/letter coincida
          const candidate = sections.find(s => {
            if (!visibleSectionIds.has(String(s.id))) return false;
            const nm = String(s.name || '').trim().toLowerCase();
            // letra explícita en propiedad custom (si existiera)
            const explicit = (s as any).letter ? String((s as any).letter).toLowerCase() : '';
            return explicit === letterCandidate || nm.endsWith(` ${letterCandidate}`) || nm === letterCandidate;
          });
          if (candidate) {
            finalSecMatch = true;
            // Reescribir sectionId para que el resto del pipeline la reconozca (no mutar original 'g')
            effectiveSectionId = String(candidate.id);
            if (afterRoleFilter <= 5) {
              console.log(`🔁 [Section Fallback] letra='${letterCandidate}' → sección '${candidate.name}' (${candidate.id}) aplicada para testId=${g.testId}`);
            }
          }
        }
        // Si tras fallback sigue sin coincidir, descartar (a menos que rol admin permita ver sin sección asignada)
        if (!finalSecMatch) {
          if (user?.role !== 'admin') return false;
          // Admin sin match, pero dejamos pasar
        }
        if (finalSecMatch) gradesSectionMatch++;
        // 🔥 FIX: Solo descartar si no hay match final (ya verificado arriba para admin)
        if (!finalSecMatch && user?.role === 'admin') {
          // Admin puede ver sin sección, ya se contó
        } else if (!finalSecMatch) {
          return false;
        }
      } else {
        gradesWithoutSectionId++;
        // Inferir sección del estudiante (usar normalizedStudentId)
        const assign = studentAssignments.find(as => 
          String(as.studentId) === normalizedStudentId || 
          String(as.studentUsername) === normalizedStudentId ||
          String(as.studentId) === originalStudentId ||
          String(as.studentUsername) === originalStudentId
        );
        const secId = assign?.sectionId ? String(assign.sectionId) : null;
        if (secId) {
          if (!visibleSectionIds.has(secId)) return false;
        } else {
          // Admin puede ver notas sin sección asignada; para otros roles mantener restricción
          if (user?.role !== 'admin') return false;
        }
      }
      afterSectionFilter++;
      // Para profesor: restringir a sus asignaturas asignadas en esa sección
      // 🔧 FIX: Si hay filtros de contexto completo (semestre + sección), permitir ver todas las calificaciones
      // Solo aplicar restricción de asignatura cuando NO hay contexto de filtro completo
      if (user?.role === 'teacher') {
        const hasCompleteContext = semester !== 'all' && (levelFilter !== 'all' || cascadeSectionId || comboSectionId !== 'all');
        
        if (!hasCompleteContext) {
          const secId = String(g.sectionId || (() => {
            const assign = studentAssignments.find(as => 
              String(as.studentId) === normalizedStudentId || 
              String(as.studentUsername) === normalizedStudentId ||
              String(as.studentId) === originalStudentId ||
              String(as.studentUsername) === originalStudentId
            );
            return assign?.sectionId ?? '';
          })());
          const allowedNames = teacherSubjectsBySection.get(secId);
          if (allowedNames && allowedNames.size > 0) {
            const name = subjNameById.get(String(g.subjectId)) || String(g.subjectId || '');
            if (!allowedNames.has(norm(name))) return false;
          }
        }
      }
      afterRoleFilter++;
      if (subjectFilter !== 'all') {
        // 🔥 FIX: g.subjectId puede ser un UUID o un nombre normalizado
        // Primero intentar buscar por UUID en subjects
        const found = subjects.find(su => String(su.id) === String(g.subjectId));
        
        // Si no se encontró por UUID, asumir que g.subjectId es el nombre normalizado
        const rawName = found?.name || (g.subjectId ? String(g.subjectId).replace(/_/g, ' ') : (g as any).subject ? String((g as any).subject) : '');
        
        const gradeCanon = canonicalSubject(rawName);
        const filterCanon = canonicalSubject(subjectFilter);
        
        // DEBUG para primeras 10 comparaciones
        if (afterRoleFilter <= 10) {
          console.log(`🔍 [SUBJECT FILTER #${afterRoleFilter}] testId: ${g.testId}, subjectId: ${g.subjectId}, found: ${!!found}, name: "${rawName}", canon: "${gradeCanon}", filterCanon: "${filterCanon}", match: ${gradeCanon === filterCanon || nearEqual(gradeCanon, filterCanon)}`);
        }
        
        if (!(gradeCanon === filterCanon || nearEqual(gradeCanon, filterCanon))) return false;
      }
      afterSubjectFilter++;
      if (semester !== 'all') {
        // Usar primero la fecha propia de la calificación (gradedAt) y luego la fecha de creación de la tarea/evaluación
        const createdTs = g.gradedAt ?? createdMap.get(String(g.testId));
        
        // 🔍 DEBUG: Log semestre para primeras 3 calificaciones que pasaron el filtro de asignatura
        if (afterSubjectFilter <= 3) {
          console.log(`🔍 [SEMESTRE] #${afterSubjectFilter} testId: ${g.testId}, createdTs: ${createdTs}, gradedAt: ${g.gradedAt}, inMap: ${createdMap.has(String(g.testId))}, fecha: ${createdTs ? new Date(createdTs).toISOString() : 'N/A'}`);
        }
        
        if (!createdTs) {
          console.warn(`⚠️ [SEMESTRE] Sin fecha para testId: ${g.testId}`);
          return false; // Sin fecha, no podemos filtrar por semestre
        }
        
        // Cuando hay config de semestres, usar comparación local por día
        if (semestersCfg) {
          const dt = sameDayFloor(new Date(createdTs));
          const { start, end } = startEndFor(semestersCfg, semester);
          if (!start || !end) return false;
          if (!(dt >= start && dt <= end)) return false;
        } else {
          // Ventanas fijas solicitadas: 1er Semestre = Mar(2)–Jun(5); 2do Semestre = Jul(6)–Dic(11)
          const dt = new Date(createdTs);
          const m = dt.getMonth();
          if (semester === '1' && (m < 2 || m > 5)) return false; // Mar..Jun
          if (semester === '2' && (m < 6 || m > 11)) return false; // Jul..Dic
        }
      }
      afterSemesterFilter++;
      // 🔥 Usar normalizedStudentId para comparaciones de estudiante
      if (user?.role === 'student' && normalizedStudentId !== String((user as any).id)) return false;
      if (user?.role === 'teacher') {
        if (g.courseId && !allowed.courses.has(String(g.courseId))) return false;
        if (g.sectionId && !allowed.sections.has(String(g.sectionId))) return false;
      }
      // 🔥 Filtro de estudiante específico: comparar tanto con userId como con RUT
      // NOTA: En modo Admin/Teacher, el filtro de estudiante se aplica SOLO al frontend (tabla visual)
      // NO filtrar las calificaciones aquí para permitir ver todas las notas del curso
      if (studentFilter !== 'all' && user?.role === 'student') {
        const filterRut = userIdToRut.get(String(studentFilter)) || '';
        if (normalizedStudentId !== String(studentFilter) && originalStudentId !== filterRut) {
          return false;
        }
      }
      afterStudentFilter++;
      return true;
    });
    
    console.log(`🔍 [filteredGrades] 📊 ESTADÍSTICAS DE FILTRADO:`);
    console.log(`  📥 Entrada: ${grades.length} calificaciones`);
    console.log(`  🔄 Conversiones RUT→userId: ${gradesConverted} calificaciones`);
    console.log(`  📍 Con sectionId: ${gradesWithSectionId}, sin sectionId: ${gradesWithoutSectionId}`);
    console.log(`  ✅ Coincidencias de sección directas: ${gradesSectionMatch}/${gradesWithSectionId}`);
    console.log(`  📊 Después de filtro de sección: ${afterSectionFilter}`);
    console.log(`  📊 Después de filtro de rol: ${afterRoleFilter}`);
    console.log(`  📊 Después de filtro de asignatura: ${afterSubjectFilter}`);
    console.log(`  📊 Después de filtro de semestre: ${afterSemesterFilter}`);
    console.log(`  📊 Después de filtro de estudiante: ${afterStudentFilter}`);
    console.log(`  📤 Total final en list: ${list.length}`);
    
    // 🔥 DEBUG: Mostrar secciones únicas en calificaciones vs visibles
    if (grades.length > 0) {
      const gradeSections = new Set(grades.filter(g => g.sectionId).map(g => String(g.sectionId)));
      console.log(`🔍 [filteredGrades] Secciones en calificaciones (${gradeSections.size}):`, Array.from(gradeSections).slice(0, 5));
      console.log(`🔍 [filteredGrades] Secciones visibles (${visibleSectionIds.size}):`, Array.from(visibleSectionIds).slice(0, 5));
      
      // Buscar coincidencias
      const matches = Array.from(gradeSections).filter(s => visibleSectionIds.has(s));
      console.log(`🔍 [filteredGrades] Coincidencias de secciones: ${matches.length}/${gradeSections.size}`, matches.slice(0, 3));
    }
    
    // Log de algunas calificaciones para inspeccionar estructura
    if (grades.length > 0) {
      console.log(`🔍 [filteredGrades] Muestra de primeras 3 calificaciones:`, grades.slice(0, 3).map(g => ({
        id: g.id,
        studentId: g.studentId,
        courseId: g.courseId,
        sectionId: g.sectionId,
        subjectId: g.subjectId,
        testId: g.testId,
        gradedAt: g.gradedAt,
        score: g.score
      })));
      
      // NUEVO: Mostrar relación courseId → sectionId en grades
      const courseSeccionMap = new Map<string, Set<string>>();
      grades.forEach(g => {
        const cid = String(g.courseId || 'sin-curso');
        const sid = String(g.sectionId || 'sin-seccion');
        if (!courseSeccionMap.has(cid)) courseSeccionMap.set(cid, new Set());
        courseSeccionMap.get(cid)!.add(sid);
      });
      console.log(`🔍 [filteredGrades] Mapeo courseId → sectionId en grades:`, 
        Array.from(courseSeccionMap.entries()).map(([course, secs]) => ({
          courseId: course,
          secciones: Array.from(secs)
        }))
      );
      
      // NUEVO: Mostrar relación courseId → sectionId en studentAssignments
      const assignmentCourseSeccionMap = new Map<string, Set<string>>();
      studentAssignments.forEach(a => {
        const cid = String(a.courseId || 'sin-curso');
        const sid = String(a.sectionId || 'sin-seccion');
        if (!assignmentCourseSeccionMap.has(cid)) assignmentCourseSeccionMap.set(cid, new Set());
        assignmentCourseSeccionMap.get(cid)!.add(sid);
      });
      console.log(`🔍 [filteredGrades] Mapeo courseId → sectionId en assignments:`, 
        Array.from(assignmentCourseSeccionMap.entries()).slice(0, 3).map(([course, secs]) => ({
          courseId: course,
          secciones: Array.from(secs).slice(0, 3)
        }))
      );
      
      // Log para verificar si ALGUNA calificación tiene sectionId
      const conSectionId = grades.filter(g => g.sectionId).length;
      const sinSectionId = grades.length - conSectionId;
      console.log(`🔍 [filteredGrades] Distribución sectionId: ${conSectionId} con sectionId, ${sinSectionId} sin sectionId`);
      
      // Revisar si los studentIds de las calificaciones están en studentAssignments
      const studentIdsEnGrades = new Set(grades.map(g => String(g.studentId)));
      const studentIdsEnAssignments = new Set(studentAssignments.map(a => String(a.studentId)));
      console.log(`🔍 [filteredGrades] StudentIds en grades: ${studentIdsEnGrades.size}, en assignments: ${studentIdsEnAssignments.size}`);
      
      // Muestra de IDs para comparar formato
      console.log(`🔍 [filteredGrades] Ejemplos studentId en grades:`, Array.from(studentIdsEnGrades).slice(0, 3));
      console.log(`🔍 [filteredGrades] Ejemplos studentId en assignments:`, Array.from(studentIdsEnAssignments).slice(0, 3));
    }
    
    // Orden por fecha de creación asc (para N1..N10)
    return list.sort((a, b) => {
      // Orden cronológico usando primero gradedAt (fecha real de calificación) y fallback a fecha de la tarea
      const ca = a.gradedAt ?? createdMap.get(String(a.testId));
      const cb = b.gradedAt ?? createdMap.get(String(b.testId));
      return ca - cb;
    });
  }, [grades, visibleSectionIds, subjectFilter, semester, semestersCfg, user, allowed, subjects, studentFilter, refreshTick, isSQLConnected, activitiesSQL, users, studentAssignments, allTasks]);

  // Índice N1..N10 por estudiante (mantenido para otros usos)
  const gradeMap = useMemo(() => {
    const map = new Map<string, TestGrade[]>();
    filteredGrades.forEach(g => {
      const key = String(g.studentId);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(g);
    });
    return map;
  }, [filteredGrades]);

  // Calificaciones realmente visibles en la tabla (máx 10 por estudiante/asignatura/sección)
  // (Declarado más abajo originalmente loadPendingTasksBySubject, así que este bloque debe ubicarse DESPUÉS de su declaración)

  // visibleGrades: subconjunto limitado a lo que realmente se muestra (máx 10 por grupo)
  const visibleGrades = useMemo(() => {
    if (!filteredGrades.length) return [] as TestGrade[];
    const normSubj = (s?: string) => {
      const base = String(s || 'General')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      return base.endsWith('s') ? base.slice(0, -1) : base;
    };
    const subjectNameFromId = (sid?: string | number) => {
      if (!sid) return 'General';
      const found = subjects.find(s => String(s.id) === String(sid));
      return found?.name || String(sid);
    };
    // Agrupar
    const groups = new Map<string, TestGrade[]>();
    filteredGrades.forEach(g => {
  const subjName = subjectNameFromId((g as any).subjectId ?? (g as any).subject ?? 'General');
      const key = `${g.studentId}__${g.sectionId || ''}__${normSubj(subjName)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(g);
    });
    const result: TestGrade[] = [];
    groups.forEach((arr, key) => {
      // Orden cronológico ya aplicado en filteredGrades.
      // Recortar a 10.
      result.push(...arr.slice(0,10));
    });
    return result;
  }, [filteredGrades, subjects]);

  // Lista de "Pendientes" filtrada por todos los filtros (nivel, curso, sección, asignatura, estudiante, semestre)
  const filteredPendingCards = useMemo(() => {
    const list = [...pendingTasks];
    const secsVisible = new Set<string>([...visibleSectionIds]);
    const parseYmdLocal = (ymd?: string) => { if(!ymd) return undefined as any; const [y,m,d]=String(ymd).split('-').map(Number); if(!y||!m||!d) return undefined as any; return new Date(y,m-1,d); };
    const startEndFor = (cfg: any, which: '1' | '2') => { const start=parseYmdLocal(which==='1'?cfg?.first?.start:cfg?.second?.start); const end=parseYmdLocal(which==='1'?cfg?.first?.end:cfg?.second?.end); return {start,end}; };
    const sameDayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const deriveSectionId = (task: any): string | null => {
      if (task.sectionId) {
        // Normalizar si viene como compuesto curso+sección
        const raw = String(task.sectionId);
        const parts = raw.split('-');
        if (parts.length >= 10) {
          return parts.slice(5, 10).join('-');
        }
        if (raw.includes('::')) {
          const segs = raw.split('::');
          if (segs[1]) return String(segs[1]);
        }
        return String(task.sectionId);
      }
      if (task.assignedTo === 'student' && Array.isArray(task.assignedStudentIds) && task.assignedStudentIds.length > 0) {
        const sid = String(task.assignedStudentIds[0]);
        const asg = studentAssignments.find(a => String(a.studentId) === sid || String(a.studentUsername) === sid);
        if (asg?.sectionId) return String(asg.sectionId);
      }
      // Eliminar heurísticas basadas en task.course textual: provocaban asignaciones de sección cruzadas.
      if (task.courseId && task.title) {
        const courseObj = courses.find(c => String(c.id) === String(task.courseId));
        if (courseObj) {
          const dashMatch = String(task.title).match(/\s-\s([A-ZÑ])$/);
          const parenMatch = String(task.title).match(/\(([A-ZÑ])\)$/);
            const letter = dashMatch?.[1] || parenMatch?.[1];
            if (letter) {
              const sec = sections.find(s => String(s.courseId) === String(courseObj.id) && String(s.name).toUpperCase() === letter);
              if (sec) return String(sec.id);
            }
        }
      }
      // No adivinar por "única sección" para evitar asignaciones incorrectas.
      return null;
    };
    const selectedSectionId = cascadeSectionId ? String(cascadeSectionId) : (comboSectionId !== 'all' ? comboSectionId : null);
    const selectedCourseId = cascadeCourseId ? String(cascadeCourseId) : (selectedSectionId ? String(sections.find(s => String(s.id) === selectedSectionId)?.courseId || '') : null);
    // Preparar mapa de asignaturas permitidas por sección para el profesor
    const norm = (s: string) => String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const teacherSubjectsBySection = new Map<string, Set<string>>();
    if (user?.role === 'teacher') {
      teacherAssignments.forEach(a => {
        const isMine = String(a.teacherId) === String((user as any)?.id) || String(a.teacherUsername) === String(user?.username);
        if (!isMine || !a.sectionId) return;
        const secId = String(a.sectionId);
        if (!teacherSubjectsBySection.has(secId)) teacherSubjectsBySection.set(secId, new Set<string>());
        const set = teacherSubjectsBySection.get(secId)!;
        const list: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
        list.forEach(n => { if (n) set.add(norm(String(n))); });
      });
      // Extender con asignaturas detectadas desde actividades SQL para secciones visibles
      try {
        if (isSQLConnected && Array.isArray(activitiesSQL) && activitiesSQL.length) {
          activitiesSQL.forEach((a: any) => {
            const secId = a?.sectionId ? String(a.sectionId) : null;
            if (!secId || !visibleSectionIds.has(secId)) return;
            if (!teacherSubjectsBySection.has(secId)) teacherSubjectsBySection.set(secId, new Set<string>());
            const set = teacherSubjectsBySection.get(secId)!;
            const name = a.subjectName || a.subjectId || 'General';
            set.add(norm(String(name)));
          });
        }
      } catch {}
    }

    return list.filter(task => {
      let sid = deriveSectionId(task);
      const courseId = task.courseId ? String(task.courseId) : null;
      // 🔁 Fallback: si no se logró derivar sección pero el usuario seleccionó una sección
      // y la tarea/evaluación corresponde al mismo curso (o es 'course' sin courseId), asignar esa sección.
    if (!sid && selectedSectionId) {
        const selSec = sections.find(s => String(s.id) === selectedSectionId);
        const selCourseId = selSec ? String(selSec.courseId) : null;
        if (selCourseId) {
          // Solo permitir fallback si hay coincidencia fuerte por courseId o por nombre+letra en título.
          const letterFromTitle = (() => {
            const t = String((task as any).title || '');
            const m1 = t.match(/\s-\s([A-ZÑ])$/);
            const m2 = t.match(/\(([A-ZÑ])\)$/);
            return (m1?.[1] || m2?.[1]) as string | undefined;
          })();
          const selectedLetter = selSec?.name ? String(selSec.name).toUpperCase() : undefined;
          const strongByTitle = selectedLetter && letterFromTitle && selectedLetter === letterFromTitle;
      // ⚠️ Bloqueo: NO forzar sección solo por coincidencia de courseId (provocaba réplicas entre secciones)
      // Solo aplicar fallback cuando el título contiene explícitamente la letra de la sección seleccionada.
      if (strongByTitle) {
            sid = selectedSectionId;
          }
        }
      }
      // 🆕 Refuerzo: si ya hay una sección derivada pero NO coincide con la seleccionada,
      // y el título de la tarea/evaluación contiene explícitamente la letra de la sección seleccionada (" - A" o "(A)"),
      // entonces forzar la sección seleccionada para que no se pierda del panel.
      if (sid && selectedSectionId && sid !== selectedSectionId) {
        try {
          const selSec = sections.find(s => String(s.id) === String(selectedSectionId));
          const letter = selSec?.name ? String(selSec.name).toUpperCase() : null;
          if (letter) {
            const t = String((task as any).title || '');
            const hasLetter = new RegExp(`\\s-\\s${letter}$`).test(t) || new RegExp(`\\(${letter}\\)$`).test(t);
            if (hasLetter) sid = String(selectedSectionId);
          }
        } catch {/* ignore */}
      }
      // FILTRO CURSO → SECCIÓN para tarjetas pendientes (alineado con tablas):
      if (cascadeCourseId && courseId && courseId !== cascadeCourseId) return false; // curso explícito distinto → fuera
      if (cascadeSectionId) {
        // Si hay sección seleccionada:
        if (sid) {
          if (sid !== String(cascadeSectionId)) return false; // sección distinta
        } else {
          // Sin sección: aceptar sólo si la tarea pertenece al curso seleccionado o no tiene courseId (legacy genérica)
          if (courseId && courseId !== String(cascadeCourseId)) return false;
        }
      } else if (comboSectionId !== 'all') {
        // Caso selección directa de comboSectionId (sin cascada): misma lógica
        if (sid && sid !== comboSectionId) return false;
        if (!sid) {
          const secObj = sections.find(s => String(s.id) === comboSectionId);
          if (secObj && courseId && String(secObj.courseId) !== courseId) return false;
        }
      }
      // Reglas redundantes sustituidas por bloque curso→sección anterior.
      if (levelFilter !== 'all' && sid) {
        const secObj = sections.find(s => String(s.id) === sid);
        const courseObj = secObj ? courses.find(c => String(c.id) === String(secObj.courseId)) : null;
        if (courseObj && getCourseLevel(courseObj.name) !== levelFilter) return false;
      }
  if (sid && !secsVisible.has(sid)) return false;
      if (!sid && selectedSectionId) return false;
      // Restringir a asignaturas del profesor por sección si aplica
      if (user?.role === 'teacher') {
        const allowedSet = sid ? teacherSubjectsBySection.get(String(sid)) : undefined;
        if (allowedSet && allowedSet.size > 0) {
          const subjOk = allowedSet.has(norm(String(task.subject)));
          if (!subjOk) return false;
        }
      }
      if (subjectFilter !== 'all') {
        const norm = (s: string) => String(s||'')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g,' ')
          .trim();
        const tname = String(task.subject || '');
        if (norm(tname) !== norm(subjectFilter)) return false;
      }
      if (studentFilter !== 'all' && task.assignedTo === 'student') {
        const ids = (task.assignedStudentIds || []).map(String);
        if (!ids.includes(String(studentFilter))) return false;
      }
      if (semester !== 'all') {
        const ref = new Date(task.createdAt || Date.now());
        if (semestersCfg) {
          const dt = sameDayFloor(ref);
          const { start, end } = startEndFor(semestersCfg, semester);
          if (!start || !end) return false;
          if (!(dt >= start && dt <= end)) return false;
        } else {
          // Ventanas fijas: Mar(2)–Jun(5) y Jul(6)–Dic(11)
          const m = ref.getMonth();
          if (semester === '1' && (m < 2 || m > 5)) return false;
          if (semester === '2' && (m < 6 || m > 11)) return false;
        }
      }
      return true;
    })
    .sort((a,b)=> new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    // 🆕 DEDUPLICAR: Solo una tarjeta por (taskId, sectionId, taskType)
    // Esto elimina réplicas de la misma actividad que aparecen múltiples veces
    .reduce((acc, task) => {
      const key = `${task.taskId}|${task.sectionId || 'null'}|${task.taskType}`;
      const exists = acc.some(t => 
        `${t.taskId}|${t.sectionId || 'null'}|${t.taskType}` === key
      );
      if (!exists) acc.push(task);
      return acc;
    }, [] as typeof list);
  }, [
    // 🔧 FIX: depender de pendingTasks (no de timelineTasks) para que el panel "Pendientes"
    // se actualice cuando cambian las calificaciones y/o la detección de pendientes.
    pendingTasks,
    visibleSectionIds,
    subjectFilter,
    semester,
    semestersCfg,
    comboSectionId,
    cascadeCourseId,
    cascadeSectionId,
    levelFilter,
    studentFilter,
    sections,
    courses,
    studentAssignments,
    user,
    teacherAssignments,
    isSQLConnected,
    activitiesSQL,
  ]);

  // Construcción de calificaciones visibles (máx 10 por grupo) alineada con la tabla
  // (Eliminado visibleGradesCalc legacy)

  // Promedio general calculado a partir de promedios de fila visibles (se recalcula en mismo render)
  let runtimeRowAverages: number[] = [];
  const computeGeneralAverage = () => {
    const hasLevel = levelFilter !== 'all';
    const hasComboSection = Boolean(comboSectionId && comboSectionId !== 'all');
    const hasCascadeSection = Boolean(cascadeCourseId && cascadeSectionId);
    const hasSectionContext = hasComboSection || hasCascadeSection; // cualquier modalidad
    const hasSemester = semester !== 'all';
    // Reglas: mostrar si (semestre) y (sección por combo O sección por cascada) y (nivel seleccionado O se eligió directamente combo sección)
    if (!(hasSemester && hasSectionContext && (hasLevel || hasComboSection))) return null;
    if (!runtimeRowAverages.length) return null;
    const sum = runtimeRowAverages.reduce((a,b)=>a+b,0);
    return Math.round((sum / runtimeRowAverages.length) * 10) / 10;
  };
  // avg se llenará después de construir las filas (ver push más abajo) en la misma pasada de render
  let avg: number | null = null;

  // Estilos de badge para notas: 0-59 rojo, 60-100 verde
  const scoreBadgeClass = (score: number) => {
    const base = 'inline-flex items-center justify-center min-w-[2.2rem] rounded-full px-1.5 py-0.5 text-[11px] border';
    if (Number(score) < 60) {
      return `${base} bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-200 dark:border-red-600`;
    }
    return `${base} bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-600`;
  };

  // Componente para tooltip mejorado
  const TaskTooltip = ({ task, children }: { task: any; children: React.ReactNode }) => {
    const [isVisible, setIsVisible] = useState(false);
    
    const formatDate = (dateStr: string) => {
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
      } catch {
        return dateStr;
      }
    };

    return (
      <div 
        className="relative inline-block"
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
        {isVisible && task && (
          <div className="absolute z-50 bottom-full left-1/2 transform -translate-x-1/2 mb-2">
            <div className="bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg max-w-64 whitespace-normal">
              <div className="font-semibold text-yellow-200">{task.taskType === 'evaluacion' ? 'Evaluación' : task.taskType === 'prueba' ? 'Prueba' : 'Tarea'}: {task.title}</div>
              <div className="text-gray-300 mt-1">Creada: {formatDate(task.createdAt)}</div>
              {task.dueDate && (
                <div className="text-gray-300">Vence: {formatDate(task.dueDate)}</div>
              )}
              <div className="text-gray-300">Estado: {task.status === 'active' ? 'Activa' : task.status}</div>
            </div>
            {/* Flecha del tooltip */}
            <div className="absolute top-full left-1/2 transform -translate-x-1/2">
              <div className="border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Cargar tareas pendientes por asignatura
  const loadPendingTasksBySubject = useMemo(() => {
    // Clave compuesta: `${subject}__${sectionId}` para evitar mezclar secciones
    const tasksByKey = new Map<string, any[]>();
    const normSubj = (s?: string) => canonicalSubject(String(s || 'General'));
    // Resolver nombre canónico de asignatura desde id o nombre, eliminando acentos y plural simple
    const subjectNameFrom = (obj: any): string => {
      try {
        const byId = obj?.subjectId ? subjects.find(su => String(su.id) === String(obj.subjectId))?.name : undefined;
        const name = byId || obj?.subjectName || obj?.subject || 'General';
        return name;
      } catch { return String(obj?.subject || obj?.subjectName || 'General'); }
    };
    // Identidad del profesor logueado para filtros de autoría
    const uid = String((user as any)?.id || '');
    const uname = String(user?.username || '');
    const nl = (v: any) => String(v ?? '').trim().toLowerCase();
    
    try {
      // Helper: asegurar unicidad de IDs manteniendo duplicados reales (mismo id origen => generar sufijos)
      const ensureUnique = (arr: any[]) => {
        const counts = new Map<string, number>();
        return arr.map(item => {
          const base = String(item?.id || item?.testId || Math.random().toString(36).slice(2));
            const seen = counts.get(base) || 0;
            counts.set(base, seen + 1);
            if (seen === 0) return { ...item, id: base };
            // Generar id derivado para mantener instancia separada
            return { ...item, originalId: base, id: `${base}__dup${seen}` };
        });
      };
      // Cargar desde SQL si está conectado; si no, LocalStorage
      const tasks = isSQLConnected
        ? ensureUnique((activitiesSQL || []).filter((a: any) => String(a.taskType) === 'tarea').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Tarea'),
            topic: String(a.topic || a.title || 'Tarea'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            subjectId: a.subjectId ?? null,
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: String(a.dueDate || a.createdAt || new Date().toISOString()),
            createdAt: String(a.createdAt || new Date().toISOString()),
            status: String(a.status || 'pending'),
            priority: 'medium',
            taskType: 'tarea' as const,
          })))
        : ensureUnique(Array.isArray(JSON.parse(localStorage.getItem('smart-student-tasks') || '[]')) ? JSON.parse(localStorage.getItem('smart-student-tasks') || '[]') : []);
      const evaluations = isSQLConnected
        ? ensureUnique((activitiesSQL || []).filter((a: any) => String(a.taskType) === 'evaluacion').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Evaluación'),
            topic: String(a.topic || a.title || 'Evaluación'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: String(a.dueDate || a.createdAt || new Date().toISOString()),
            createdAt: String(a.createdAt || new Date().toISOString()),
            status: String(a.status || 'finished'),
            priority: 'medium',
            taskType: 'evaluacion' as const,
          })))
        : ensureUnique(Array.isArray(JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]')) ? JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]') : []);
      const tests: any[] = isSQLConnected
        ? ensureUnique((activitiesSQL || []).filter((a: any) => String(a.taskType) === 'prueba').map((a: any) => ({
            id: String(a.id),
            title: String(a.title || 'Prueba'),
            topic: String(a.topic || a.title || 'Prueba'),
            description: '',
            subject: String(a.subjectName || a.subjectId || 'General'),
            subjectId: a.subjectId ?? null,
            course: '',
            courseId: a.courseId ?? null,
            assignedById: String(a.assignedById || ''),
            assignedByName: String(a.assignedByName || ''),
            assignedTo: 'course',
            assignedStudentIds: undefined,
            sectionId: a.sectionId ?? null,
            dueDate: toIso(a.createdAt || Date.now()),
            createdAt: toIso(a.createdAt || Date.now()),
            status: 'pending',
            priority: 'medium',
            taskType: 'prueba' as const,
          })))
        : (() => {
            const acc: any[] = [];
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || !key.startsWith('smart-student-tests')) continue;
                const arr = JSON.parse(localStorage.getItem(key) || '[]');
                if (Array.isArray(arr)) acc.push(...arr);
              }
            } catch {}
            return ensureUnique(acc);
          })();
  const { LocalStorageManager } = require('@/lib/education-utils');
  const grades = (LocalStorageManager.getTestGradesForYear(selectedYear) as TestGrade[]) || [];
      
  // Debug: logging de fuentes
  console.log(`📊 Cargando actividades: ${tasks.length} tareas, ${evaluations.length} evaluaciones, ${tests.length} pruebas`);
      
  // Combinar (ya no deduplicar: cada instancia importa aunque comparta ID de origen)
  const allTasksRaw = [
        ...tasks.map((t: any) => ({ ...t, taskType: t.taskType || 'tarea' })),
        ...evaluations.map((e: any) => ({ ...e, taskType: 'evaluacion' })),
        ...tests.map((t: any) => ({
          ...t,
          taskType: 'prueba',
          subject: t.subjectName || t.subjectId || 'General',
          subjectId: t.subjectId ?? null,
          courseId: t.courseId ?? null,
          sectionId: t.sectionId ?? null,
          createdAt: toIso(t.createdAt ?? Date.now()),
          status: 'pending',
        }))
      ];
      const allTasks = allTasksRaw; // ahora incluye duplicados con id único derivado
      console.log(`✅ Actividades cargadas (sin eliminar duplicados): ${allTasks.length}`);
      
      // Helpers de fecha iguales a los de filteredGrades
      const parseYmdLocal = (ymd?: string) => {
        if (!ymd) return undefined as unknown as Date | undefined;
        const [y, m, d] = String(ymd).split('-').map(Number);
        if (!y || !m || !d) return undefined as unknown as Date | undefined;
        return new Date(y, (m || 1) - 1, d || 1);
      };
      const sameDayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const startEndFor = (cfg: any, which: '1' | '2') => {
        const start = parseYmdLocal(which === '1' ? cfg?.first?.start : cfg?.second?.start);
        const end = parseYmdLocal(which === '1' ? cfg?.first?.end : cfg?.second?.end);
        return { start, end } as { start?: Date; end?: Date };
      };

      // Derivar sección SIN expansión y respetar filtros activos
  const sectionsLS = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
      const assignsLS = JSON.parse(localStorage.getItem(`smart-student-student-assignments-${selectedYear}`) || '[]');
      const activeTasks: any[] = [];
      const activeSectionFilter = (comboSectionId && comboSectionId !== 'all') ? comboSectionId : (cascadeSectionId ? String(cascadeSectionId) : null);
      const deriveSectionId = (task: any): string | null => {
        if (task.sectionId) return String(task.sectionId);
        if (task.assignedTo === 'student' && Array.isArray(task.assignedStudentIds)) {
          for (const sidRaw of task.assignedStudentIds) {
            const sid = String(sidRaw);
            const asg = assignsLS.find((a: any) => String(a.studentId) === sid || String(a.studentUsername) === sid);
            if (asg?.sectionId) return String(asg.sectionId);
          }
        }
        if (task.title && task.courseId) {
          const m = String(task.title).match(/\s-\s([A-ZÑ])$/) || String(task.title).match(/\(([A-ZÑ])\)$/);
          const letter = m?.[1];
            if (letter) {
              const sec = sectionsLS.find((s: any) => String(s.courseId) === String(task.courseId) && String(s.name).toUpperCase() === letter);
              if (sec) return String(sec.id);
            }
        }
        // Solo aceptar task.course si es un sectionId directo o etiqueta EXACTA "Curso Sección"; no por coincidencias parciales del nombre de curso.
        if (task.course) {
          const norm = (v: string) => v
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\bseccion\b/gi, '')
            .replace(/\bsección\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          const courseValRaw = String(task.course).trim();
          const courseVal = courseValRaw;
          const courseValNorm = norm(courseValRaw);
          // 1. Coincidencia directa como sectionId
          const directSec = sectionsLS.find((s: any) => String(s.id) === courseVal);
          if (directSec) return String(directSec.id);
          // 2. Coincidencia como etiqueta compuesta
            for (const s of sectionsLS) {
              const c = courses.find((cc: any) => String(cc.id) === String(s.courseId));
              const label = `${c?.name || ''} ${s.name}`.trim();
              const labelNorm = norm(label);
              if (label && labelNorm === courseValNorm) return String(s.id);
            }
          // 3. No adivinar por nombre parcial de curso sin sección
        }
        // 🆕 Fallback seguro cuando solo hay UNA sección visible (típico en profesor):
        // si no se pudo derivar sección pero el contexto visible tiene exactamente una sección,
        // asignamos esa sección para que las burbujas N se alineen correctamente.
        try {
          const list = Array.from(visibleSectionIds);
          if (list.length === 1) {
            return String(list[0]);
          }
        } catch {}
        // No adivinar en escenarios con múltiples secciones visibles.
        return null;
      };
  allTasks.forEach(task => {
        // Si es profesor, incluir solamente tareas/evaluaciones/pruebas creadas por él
        if (user?.role === 'teacher') {
          const isMineTask = (
            nl(task.assignedById) === nl(uid) ||
            nl(task.assignedByName) === nl(uname) ||
            nl(task.teacherId) === nl(uid) ||
            nl(task.teacherName) === nl(uname) ||
            nl(task.ownerId) === nl(uid) ||
            nl(task.ownerUsername) === nl(uname)
          );
          // Mostrar también las tareas generadas por el sistema (importación masiva) para que el profesor vea el histórico.
          const isSystemGenerated = nl(task.assignedById) === 'system' || nl(task.assignedByName) === 'system';
          if (!isMineTask && !isSystemGenerated) return;
        }
        const st = String(task.status || '').toLowerCase();
        // Mostrar burbujas por "existencia" de la tarea/evaluación/prueba y no por si está pendiente.
        // Incluir todos los estados (pending/submitted/reviewed/delivered/finished/closed/active, etc.)
        // y excluir únicamente estados que representen eliminación/archivo/cancelación.
  const excluded = new Set(['deleted', 'archived', 'cancelled', 'canceled', 'eliminada', 'eliminado', 'archivada', 'archivado', 'cancelada', 'cancelado']);
        if (excluded.has(st)) return;
        const refRaw = task.createdAt || task.startAt || task.openAt || task.dueDate;
        const created = new Date(refRaw);
        if (semester !== 'all') {
          try {
            if (semestersCfg) {
              const dt = sameDayFloor(created);
              const { start, end } = startEndFor(semestersCfg, semester);
              if (!start || !end) return;
              if (!(dt >= start && dt <= end)) return;
            } else {
              const m = created.getMonth();
              if (semester === '1' && m > 5) return;
              if (semester === '2' && m < 6) return;
            }
          } catch {}
        }
  let secId = deriveSectionId(task);
  // Fallback seguro: si no hay sección y el usuario seleccionó una sección, y
  // el curso coincide (por ID o por nombre) o el título contiene la letra de la sección, usar la sección activa.
  if (!secId && activeSectionFilter) {
    try {
      const selSec = sectionsLS.find((s: any) => String(s.id) === String(activeSectionFilter));
      const selCourseId = selSec ? String(selSec.courseId) : null;
      const selectedLetter = selSec?.name ? String(selSec.name).toUpperCase() : undefined;
      const norm = (v: string) => String(v || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\bseccion\b/gi, '')
        .replace(/\bsección\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
  const matchesCourseId = selCourseId && task.courseId && String(task.courseId) === String(selCourseId);
      const letterFromTitle = (() => {
        const t = String((task as any).title || '');
        const m1 = t.match(/\s-\s([A-ZÑ])$/);
        const m2 = t.match(/\(([A-ZÑ])\)$/);
        return (m1?.[1] || m2?.[1]) as string | undefined;
      })();
      const strongByTitle = selectedLetter && letterFromTitle && selectedLetter === letterFromTitle;
  // Solo permitir si hay coincidencia fuerte: mismo courseId o letra explícita que coincide con la sección seleccionada
  if (matchesCourseId || strongByTitle) {
        secId = String(activeSectionFilter);
      }
    } catch {}
  }
  if (!secId) return; // sin sección real -> no se usa
  // Si hay filtro activo, exigir coincidencia exacta
  if (activeSectionFilter && String(secId) !== String(activeSectionFilter)) return;
  if (!visibleSectionIds.has(String(secId))) return;
  activeTasks.push({ ...task, sectionId: String(secId) });
      });
      
      // Agrupar por asignatura + sección
      activeTasks.forEach(task => {
        const subject = normSubj(subjectNameFrom(task));
        const secId = String(task.sectionId);
        const key = `${subject}__${secId}`;
        if (!tasksByKey.has(key)) tasksByKey.set(key, []);
        tasksByKey.get(key)!.push(task); // mantener todo para cálculo de N
      });
      
      // Ordenar por createdAt ascendente por cada clave
      tasksByKey.forEach((arr) => {
        const ref = (t: any) => new Date(t.createdAt || t.startAt || t.openAt || t.dueDate).getTime();
        arr.sort((a, b) => ref(a) - ref(b));
      });
      
    } catch (error) {
      console.warn('Error cargando tareas pendientes:', error);
    }
    
  return tasksByKey;
  }, [
  visibleSectionIds,
    refreshTick,
    semester,
    semestersCfg,
    user,
    subjects,
    teacherAssignments,
    // Recalcular cuando cambie la selección de curso/sección (profesor/estudiante)
    comboSectionId,
    cascadeSectionId,
    cascadeCourseId,
    // Incluye cursos ya que se usan para resolver etiquetas/derivar secciones
    courses,
  // Fallback derivado de notas
  filteredGrades,
  isSQLConnected,
  activitiesSQL,
  ]);

  // Mapa rápido de resultados de evaluaciones (taskId + studentId/username)
  const evaluationResultsMap = useMemo(() => {
    const map = new Map<string, any>();
    try {
      const arr = JSON.parse(localStorage.getItem('smart-student-evaluation-results') || '[]');
      if (Array.isArray(arr)) {
        arr.forEach((r: any) => {
          const sid = r.studentId || r.studentUsername;
            if (!r.taskId || !sid) return;
            map.set(`${r.taskId}__${sid}`, r);
        });
      }
    } catch {}
    return map;
  }, [refreshTick, selectedYear]);

  // (Eliminado) Generador de notas demo

  // (Eliminado) Generador de notas demo

  // Función para obtener tarea pendiente por columna y asignatura específica
  const getPendingTaskForColumn = (columnIndex: number, subjectName: string, sectionId?: string | null): PendingTask | null => {
    const normSubj = (s?: string) => canonicalSubject(String(s || 'General'));
    if (!sectionId) return null;
  const key = `${normSubj(subjectName)}__${String(sectionId)}`;
    const tasks = loadPendingTasksBySubject.get(key) || [];
    const t = tasks[columnIndex];
    if (!t) return null;
    return {
      taskId: String(t.id),
      title: String(t.title || t.name || ''),
      taskType: String(t.taskType || 'tarea') as any,
  createdAt: toIso(t.createdAt || t.startAt || t.openAt || t.dueDate || Date.now()),
      subject: String(subjectName || t.subject || 'General'),
      course: String(t.course || ''),
      courseId: t.courseId ?? null,
      sectionId: t.sectionId ?? null,
      assignedTo: String(t.assignedTo || 'course') as any,
      assignedStudentIds: Array.isArray(t.assignedStudentIds) ? t.assignedStudentIds.map(String) : undefined,
      columnIndex,
      topic: t.topic,
  description: typeof t.description === 'string' ? t.description : (typeof (t as any).details === 'string' ? (t as any).details : ''),
    };
  };

  // Función para formatear fecha
  const formatDate = (dateString: string): string => {
    try {
      const d = new Date(dateString);
      if (isNaN(d.getTime())) return dateString;
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    } catch {
      return dateString;
    }
  };

  // Años disponibles (sólo con calificaciones). Si ninguno tiene notas, usar todos los detectados.
  const availableYears = React.useMemo(() => {
    try {
      const { LocalStorageManager } = require('@/lib/education-utils');
      const raw: number[] = LocalStorageManager.listYears(); // ya ordena desc en lib
      // Filtrar que tengan calificaciones
      const withGrades = raw.filter(y => {
        try { const arr = LocalStorageManager.getTestGradesForYear(y) as any[]; return Array.isArray(arr) && arr.length > 0; } catch { return false; }
      });
      let base = withGrades.length ? withGrades : raw;
      // Asegurar año seleccionado en la lista
      if (!base.includes(selectedYear)) base = [...base, selectedYear];
      // Orden asc para navegación anterior/siguiente lógica sencilla
      const asc = [...new Set(base)].sort((a,b)=>a-b);
      return asc;
    } catch { return [selectedYear]; }
  }, [selectedYear, grades, refreshTick]);

  const yearIndex = availableYears.indexOf(selectedYear);
  const prevYear = yearIndex > 0 ? availableYears[yearIndex - 1] : null;
  const nextYear = yearIndex >= 0 && yearIndex < availableYears.length - 1 ? availableYears[yearIndex + 1] : null;

  return (
    <div className="container mx-auto px-4 py-6">
      {/* Overlay inicial de carga (estudiante) */}
      {user?.role === 'student' && showInitialOverlay && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-indigo-200 dark:border-indigo-700 bg-white/90 dark:bg-slate-900/90 shadow-xl">
            <div className="h-10 w-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" aria-label="Cargando" />
            <div className="text-sm font-medium text-indigo-700 dark:text-indigo-200">Preparando calificaciones…</div>
            <div className="w-48 h-2 rounded-full bg-indigo-100 dark:bg-indigo-800 overflow-hidden">
              <div className="h-2 bg-indigo-600 transition-all" style={{ width: `${overlayProgress}%` }} />
            </div>
            <div className="text-[11px] text-indigo-500 dark:text-indigo-300">Cargando datos y aplicando filtros...</div>
          </div>
        </div>
      )}
      {/* Avisos de migración SQL */}
      {sqlMigrating && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2 text-sm dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-200">
          Migrando calificaciones a SQL en segundo plano para {sqlMigrating.years.join(', ') || 'año actual'}… Puedes seguir trabajando.
        </div>
      )}
      {sqlMigratedInfo && (
        <div className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 px-3 py-2 text-sm dark:bg-emerald-900/20 dark:border-emerald-700 dark:text-emerald-200">
          Migración a SQL completada para {sqlMigratedInfo.years.join(', ') || 'año actual'}: {sqlMigratedInfo.totalInserted} calificaciones insertadas.
        </div>
      )}
      
      {/* Indicador sutil de sincronización SQL en segundo plano (gated) */}
      {isSQLConnected && isSyncing && !sqlFetchDone && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 px-4 py-3 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-700 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
              Sincronizando con BBDD
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-blue-200 dark:bg-blue-800 overflow-hidden">
              <div 
                className="h-full bg-blue-600 dark:bg-blue-400 transition-all duration-300 ease-out" 
                style={{ width: `${sqlFetchProgress}%` }}
              />
            </div>
            <span className="text-xs font-semibold text-blue-700 dark:text-blue-300 w-10 text-right">
              {sqlFetchProgress}%
            </span>
          </div>
        </div>
      )}
      {/* Layout: una columna amplia (se eliminan tarjetas laterales para dar más espacio a la tabla) */}
      <div className="flex flex-col gap-6">
        {/* Columna única */}
        <div className="flex-1 lg:w-full">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <CardTitle>
                  {tr('gradesDashboardTitle', 'Calificaciones')}
                  {': '}
                  {semester === '1' ? tr('firstSemester', '1er Semestre') : semester === '2' ? tr('secondSemester', '2do Semestre') : tr('allSemesters', 'Todos los semestres')}
                </CardTitle>
                {/* Filtro global de Año (versión destacada) */}
                <div className="flex items-center gap-2 pt-1 md:pt-0">
                  {/* Indicador de conexión a base de datos */}
                  {(() => {
                    const useFB = isFirebaseEnabled();
                    const provider = getCurrentProvider?.() as 'firebase' | 'supabase' | 'idb';
                    const isGreen = useFB && firebaseHealthy === true;
                    const isGray = !isGreen;
                    const label = useFB
                      ? (firebaseHealthy === true ? 'Activo' : 'Sin conexión')
                      : (isSQLConnected
                        ? 'Activo'
                        : 'Local');
                    const title = useFB
                      ? (firebaseHealthy === true ? 'Conectado a Firebase' : 'Firebase habilitado, sin conexión')
                      : (isSQLConnected
                        ? (provider === 'supabase' ? 'Conectado a Supabase' : 'Conectado a SQL local (IndexedDB)')
                        : 'Sin conexión - Modo local');
                    return (
                      <div className="flex items-center gap-1.5" title={title}>
                        <div className={`w-2 h-2 rounded-full ${isGreen ? 'bg-green-500 animate-pulse' : (isGray ? 'bg-gray-400' : 'bg-gray-400')}`} />
                        <span className="text-[10px] text-gray-600 dark:text-gray-400">{label}</span>
                      </div>
                    );
                  })()}
                  <span className="hidden sm:inline-flex items-center gap-1 text-[10px] tracking-wide uppercase font-medium text-indigo-400 dark:text-indigo-300">
                    <Calendar className="h-3 w-3" /> {tr('year','Año')}
                  </span>
                  <div className="flex items-center rounded-full border border-indigo-300/60 dark:border-indigo-500/50 bg-indigo-50/70 dark:bg-indigo-900/40 backdrop-blur px-1 shadow-sm">
                    <button
                      type="button"
                      aria-label="Año anterior"
                      disabled={!prevYear}
                      className={`p-1.5 rounded-full transition ${prevYear ? 'hover:bg-indigo-200 dark:hover:bg-indigo-800 text-indigo-700 dark:text-indigo-200' : 'opacity-30 cursor-not-allowed text-indigo-400 dark:text-indigo-600'}`}
                      onClick={() => {
                        if (!prevYear) return;
                        const y = prevYear;
                        localStorage.setItem('admin-selected-year', String(y));
                        // Reset de filtros al cambiar de año
                        setLevelFilter('all');
                        setCascadeCourseId(null);
                        setCascadeSectionId(null);
                        setCascadeSubject(null);
                        setComboSectionId('all');
                        setSubjectFilter('all');
                        setStudentFilter('all');
                        setSelectedGuardianStudent(null);
                        setSemester('all');
                        setSelectedYear(y);
                        window.dispatchEvent(new StorageEvent('storage', { key: 'admin-selected-year', newValue: String(y) }));
                      }}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <div className="relative group">
                      <button
                        type="button"
                        className="px-3 py-1.5 text-sm font-semibold text-indigo-700 dark:text-indigo-200 hover:text-indigo-900 dark:hover:text-white focus:outline-none"
                      >
                        {selectedYear}
                      </button>
                      {/* Dropdown años */}
                      <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 focus-within:visible focus-within:opacity-100 transition duration-150 absolute right-0 mt-2 z-50 min-w-[5rem] max-h-56 overflow-auto rounded-md border border-indigo-200 dark:border-indigo-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-lg p-1">
                        {availableYears.map(y => (
                          <button
                            key={`drop-year-${y}`}
                            className={`w-full text-left px-2 py-1 rounded text-xs font-medium tracking-wide transition ${y === selectedYear ? 'bg-indigo-600 text-white' : 'text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-800/50'}`}
                            onClick={() => {
                              if (y === selectedYear) return;
                              localStorage.setItem('admin-selected-year', String(y));
                              // Reset de filtros al cambiar de año vía dropdown
                              setLevelFilter('all');
                              setCascadeCourseId(null);
                              setCascadeSectionId(null);
                              setCascadeSubject(null);
                              setComboSectionId('all');
                              setSubjectFilter('all');
                              setStudentFilter('all');
                              setSelectedGuardianStudent(null);
                              setSemester('all');
                              setSelectedYear(y);
                              window.dispatchEvent(new StorageEvent('storage', { key: 'admin-selected-year', newValue: String(y) }));
                            }}
                          >{y}</button>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Año siguiente"
                      disabled={!nextYear}
                      className={`p-1.5 rounded-full transition ${nextYear ? 'hover:bg-indigo-200 dark:hover:bg-indigo-800 text-indigo-700 dark:text-indigo-200' : 'opacity-30 cursor-not-allowed text-indigo-400 dark:text-indigo-600'}`}
                      onClick={() => {
                        if (!nextYear) return;
                        const y = nextYear;
                        localStorage.setItem('admin-selected-year', String(y));
                        // Reset de filtros al cambiar de año
                        setLevelFilter('all');
                        setCascadeCourseId(null);
                        setCascadeSectionId(null);
                        setCascadeSubject(null);
                        setComboSectionId('all');
                        setSubjectFilter('all');
                        setStudentFilter('all');
                        setSelectedGuardianStudent(null);
                        setSemester('all');
                        setSelectedYear(y);
                        window.dispatchEvent(new StorageEvent('storage', { key: 'admin-selected-year', newValue: String(y) }));
                      }}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Vista en cascada y filtros */}
              {/* Vista en cascada: Nivel → Curso → Sección → Asignatura → Estudiantes */}
              <div className="space-y-4">
                
                {/* 🎓 APODERADO: Selector de estudiante asignado */}
                {user?.role === 'guardian' && guardianStudents.length > 0 && (
                  <div className="mb-4">
                    <div className="text-xs text-muted-foreground mb-2">{tr('selectStudent', 'Seleccionar Estudiante')}</div>
                    <div className="flex flex-wrap gap-2">
                      {guardianStudents.map(student => {
                        const isSelected = selectedGuardianStudent === String(student.id);
                        const studentAssign = studentAssignments.find(a => 
                          String(a.studentId) === String(student.id) || 
                          String(a.studentUsername) === String(student.username)
                        );
                        const studentSection = studentAssign ? sections.find(s => String(s.id) === String(studentAssign.sectionId)) : null;
                        const studentCourse = studentSection ? courses.find(c => String(c.id) === String(studentSection.courseId)) : null;
                        const courseLabel = studentCourse && studentSection ? `${studentCourse.name} ${studentSection.name}` : '';
                        
                        return (
                          <button
                            key={String(student.id)}
                            type="button"
                            onClick={() => {
                              if (isSelected) {
                                // Deseleccionar: limpiar filtros
                                setSelectedGuardianStudent(null);
                                setLevelFilter('all');
                                setCascadeCourseId(null);
                                setCascadeSectionId(null);
                                setComboSectionId('all');
                                setStudentFilter('all');
                              } else {
                                // Seleccionar estudiante
                                setSelectedGuardianStudent(String(student.id));
                              }
                            }}
                            className={`inline-flex flex-col items-start rounded-lg px-4 py-2 text-sm border transition ${
                              isSelected 
                                ? 'bg-indigo-600 border-indigo-600 text-white' 
                                : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                            }`}
                          >
                            <span className="font-medium">{student.displayName || student.name || student.username}</span>
                            {courseLabel && (
                              <span className={`text-xs ${isSelected ? 'text-indigo-200' : 'text-indigo-500 dark:text-indigo-400'}`}>
                                {courseLabel}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {!selectedGuardianStudent && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                        👆 {tr('selectStudentToViewGrades', 'Seleccione un estudiante para ver sus calificaciones')}
                      </p>
                    )}
                  </div>
                )}
                
                {/* Niveles - Ocultar completamente para apoderados */}
                {user?.role !== 'guardian' && (
                <div>
                  <div className="text-xs text-muted-foreground mb-2">{tr('levels', 'Niveles')}</div>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const canShowBasica = teacherLevelsAllowed.has('basica') || user?.role === 'admin' || user?.role === 'guardian';
                      const canShowMedia = teacherLevelsAllowed.has('media') || user?.role === 'admin' || user?.role === 'guardian';
                      const isStudent = user?.role === 'student';
                      const isGuardian = user?.role === 'guardian';
                      return (
                        <>
                          {canShowBasica && (
                            <Badge
                              onClick={() => { if (isStudent || isGuardian) return; const next = levelFilter === 'basica' ? 'all' : 'basica'; setLevelFilter(next); setCascadeCourseId(null); setCascadeSectionId(null); setCascadeSubject(null); setComboSectionId('all'); setSubjectFilter('all'); setStudentFilter('all'); }}
                              className={`${isGuardian ? 'cursor-default' : 'cursor-pointer'} select-none rounded-full px-3 py-1 ${levelFilter === 'basica' ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-600'}`}
                            >{tr('basicLevel', 'Básica')}</Badge>
                          )}
                          {canShowMedia && (!isStudent) && (
                            <Badge
                              onClick={() => { if (isGuardian) return; const next = levelFilter === 'media' ? 'all' : 'media'; setLevelFilter(next); setCascadeCourseId(null); setCascadeSectionId(null); setCascadeSubject(null); setComboSectionId('all'); setSubjectFilter('all'); setStudentFilter('all'); }}
                              className={`${isGuardian ? 'cursor-default' : 'cursor-pointer'} select-none rounded-full px-3 py-1 ${levelFilter === 'media' ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-600'}`}
                            >{tr('middleLevel', 'Media')}</Badge>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
                )}

                {/* Cursos del nivel seleccionado - Ocultar para apoderados */}
                {levelFilter !== 'all' && user?.role !== 'guardian' && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">{tr('courses', 'Cursos')}</div>
                    <div className="flex flex-wrap gap-2">
                      {courses
                        .filter(c => getCourseLevel(c.name) === levelFilter)
                        .filter(c => {
                          if (user?.role === 'teacher') {
                            const hasActiveSection = sections.some(s => String(s.courseId) === String(c.id) && allowed.sections.has(String(s.id)));
                            return hasActiveSection;
                          }
                          if (user?.role === 'student') {
                            // Solo su curso
                            const myAssign = studentAssignments.find(a => String(a.studentId) === String((user as any).id) || String(a.studentUsername) === String(user?.username));
                            if (!myAssign) return false;
                            const mySection = sections.find(s => String(s.id) === String(myAssign.sectionId));
                            return String(mySection?.courseId) === String(c.id);
                          }
                          if (user?.role === 'guardian') {
                            // Solo los cursos de los estudiantes asignados
                            return allowed.courses.has(String(c.id));
                          }
                          return true;
                        })
                        .sort((a, b) => {
                          const ra = courseRank(a.name);
                          const rb = courseRank(b.name);
                          if (ra !== rb) return ra - rb;
                          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                        })
                        .map(c => {
                          const sectionsOfCourse = sections.filter(s => s.courseId === c.id);
                          const sectionIds = new Set(sectionsOfCourse.map(s => String(s.id)));
                          let studentCount = studentAssignments.filter(a => a.sectionId && sectionIds.has(String(a.sectionId))).length;
                          // Fallback: si no hay asignaciones, contar estudiantes únicos con nota en esas secciones
                          if (!studentCount && gradedStudentIdsBySection.size) {
                            const uniq = new Set<string>();
                            sectionIds.forEach(sec => {
                              const set = gradedStudentIdsBySection.get(String(sec));
                              if (set) set.forEach(id => uniq.add(String(id)));
                            });
                            studentCount = uniq.size;
                          }
                          return (
                            <button
                              key={c.id}
                              type="button"
                              disabled={user?.role === 'guardian'}
                              onClick={() => { if (user?.role === 'guardian') return; const isSelected = cascadeCourseId === c.id; setCascadeCourseId(isSelected ? null : c.id); setCascadeSectionId(null); setCascadeSubject(null); setComboSectionId('all'); setSubjectFilter('all'); setStudentFilter('all'); }}
                              className={`inline-flex items-center rounded-full px-3 py-1 text-xs border transition ${
                                cascadeCourseId === c.id ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                              } ${user?.role === 'guardian' ? 'cursor-default' : ''}`}
                              title={`${studentCount} estudiante(s)`}
                            >{c.name} <span className="ml-2 opacity-80">({studentCount})</span></button>
                          );
                        })}
                    </div>
                  </div>
                )}

                {/* Secciones: visibles con curso seleccionado o solo nivel - Ocultar para apoderados */}
                {(cascadeCourseId || levelFilter !== 'all') && user?.role !== 'guardian' && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">{tr('sections', 'Secciones')}</div>
                    <div className="flex flex-wrap gap-2">
                      {(() => {
                        let list = sections.slice();
                        if (cascadeCourseId) {
                          list = list.filter(s => s.courseId === cascadeCourseId);
                        } else if (levelFilter !== 'all') {
                          list = list.filter(s => getCourseLevel(courseById.get(s.courseId)?.name) === levelFilter);
                        }
                        // Restringir a secciones activas del profesor
                        if (user?.role === 'teacher') {
                          list = list.filter(s => allowed.sections.has(String(s.id)));
                        } else if (user?.role === 'student') {
                          // Solo su sección
                          const myAssign = studentAssignments.find(a => String(a.studentId) === String((user as any).id) || String(a.studentUsername) === String(user?.username));
                          list = myAssign ? list.filter(s => String(s.id) === String(myAssign.sectionId)) : [];
                        } else if (user?.role === 'guardian') {
                          // Solo las secciones de los estudiantes asignados
                          list = list.filter(s => allowed.sections.has(String(s.id)));
                        }
                        list.sort((a, b) => {
                          const ca = courseById.get(a.courseId)?.name || '';
                          const cb = courseById.get(b.courseId)?.name || '';
                          const ra = courseRank(ca);
                          const rb = courseRank(cb);
                          if (ra !== rb) return ra - rb;
                          const sa = sectionRank(a.name);
                          const sb = sectionRank(b.name);
                          if (sa !== sb) return sa - sb;
                          const na = `${ca} ${a.name}`.trim();
                          const nb = `${cb} ${b.name}`.trim();
                          return na.localeCompare(nb, undefined, { sensitivity: 'base' });
                        });
                        return list;
                      })().map(s => {
                        let studentCount = studentAssignments.filter(a => String(a.sectionId) === String(s.id)).length;
                        if (!studentCount && gradedStudentIdsBySection.size) {
                          studentCount = gradedStudentIdsBySection.get(String(s.id))?.size || 0;
                        }
                        const courseName = courseById.get(s.courseId)?.name;
                        const label = cascadeCourseId ? s.name : `${courseName ?? ''} ${s.name}`.trim();
                        return (
                          <button
                            key={s.id}
                            type="button"
                            disabled={user?.role === 'guardian'}
                            onClick={() => { if (user?.role === 'guardian') return; const isSelected = cascadeSectionId === s.id; setCascadeSectionId(isSelected ? null : s.id); setCascadeSubject(null); setComboSectionId(isSelected ? 'all' : String(s.id)); setSubjectFilter('all'); setStudentFilter('all'); }}
                            className={`inline-flex items-center rounded-full px-3 py-1 text-xs border transition ${
                              cascadeSectionId === s.id ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                            } ${user?.role === 'guardian' ? 'cursor-default' : ''}`}
                            title={`${studentCount} estudiante(s)`}
                          >{label} <span className="ml-2 opacity-80">({studentCount})</span></button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Asignaturas de la sección seleccionada - Filtradas por asignaciones del nivel y curso */}
                {cascadeSectionId && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">{tr('subjects', 'Asignaturas')}</div>
                    <div className="flex flex-wrap gap-2">
                      {(() => {
                        const names = new Set<string>();
                        
                        // 🎯 LÓGICA CORREGIDA: Verificar que la sección pertenezca al curso seleccionado
                        const selectedSection = sections.find(s => String(s.id) === String(cascadeSectionId));
                        const selectedCourse = selectedSection ? courseById.get(selectedSection.courseId) : null;
                        const selectedCourseLevel = selectedCourse ? getCourseLevel(selectedCourse.name) : null;
                        
                        // 📊 Debug: Información del filtro actual
                        console.log(`🎓 [Filtro Asignaturas] DEBUG:`);
                        console.log(`   📌 Nivel seleccionado: ${levelFilter}`);
                        console.log(`   📌 Curso seleccionado: ${cascadeCourseId}`);
                        console.log(`   📌 Sección seleccionada: ${cascadeSectionId}`);
                        console.log(`   📌 Sección encontrada:`, selectedSection);
                        console.log(`   📌 Curso de la sección:`, selectedCourse?.name);
                        console.log(`   📌 Nivel del curso:`, selectedCourseLevel);
                        
                        // Validación: La sección debe corresponder al curso seleccionado
                        const isValidSection = selectedSection && (
                          !cascadeCourseId || String(selectedSection.courseId) === String(cascadeCourseId)
                        );
                        
                        if (!isValidSection) {
                          console.warn(`⚠️ [Filtro Asignaturas] La sección ${cascadeSectionId} no corresponde al curso ${cascadeCourseId}`);
                          return [];
                        }
                        
                        // 🎯 Obtener lista de asignaturas válidas para el nivel del curso
                        // Importar la función que obtiene asignaturas por nivel
                        const { getSubjectsForLevel } = require('@/lib/subjects-colors');
                        const validSubjectsForLevel = selectedCourseLevel ? getSubjectsForLevel(selectedCourseLevel) : [];
                        const validSubjectNames = new Set(validSubjectsForLevel.map((s: any) => s.name));
                        
                        console.log(`   📚 Asignaturas válidas para nivel ${selectedCourseLevel}:`, Array.from(validSubjectNames));
                        
                        // 🎯 Filtrar asignaturas SOLO de la sección específica Y que correspondan al nivel
                        if (user?.role === 'teacher') {
                          teacherAssignments.forEach(a => {
                            const isMine = (String(a.teacherId) === String((user as any)?.id)) || (String(a.teacherUsername) === String(user?.username));
                            if (!isMine) return;
                            if (String(a.sectionId) !== String(cascadeSectionId)) return;
                            
                            const list: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                            list.forEach(n => {
                              // ✅ FILTRO ADICIONAL: Solo agregar si la asignatura es válida para el nivel
                              if (n && validSubjectNames.has(n)) {
                                names.add(String(n));
                              } else if (n) {
                                console.warn(`⚠️ Asignatura "${n}" no corresponde al nivel ${selectedCourseLevel}, omitida`);
                              }
                            });
                          });
                        } else if (user?.role === 'admin') {
                          teacherAssignments.forEach(a => {
                            if (String(a.sectionId) !== String(cascadeSectionId)) return;
                            
                            const list: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                            list.forEach(n => {
                              // ✅ FILTRO ADICIONAL: Solo agregar si la asignatura es válida para el nivel
                              if (n && validSubjectNames.has(n)) {
                                names.add(String(n));
                              } else if (n) {
                                console.warn(`⚠️ Asignatura "${n}" no corresponde al nivel ${selectedCourseLevel}, omitida`);
                              }
                            });
                          });
                        } else {
                          teacherAssignments.forEach(a => {
                            if (String(a.sectionId) !== String(cascadeSectionId)) return;
                            
                            const list: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                            list.forEach(n => {
                              // ✅ FILTRO ADICIONAL: Solo agregar si la asignatura es válida para el nivel
                              if (n && validSubjectNames.has(n)) {
                                names.add(String(n));
                              }
                            });
                          });
                        }
                        
                        const items = Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
                        
                        // 📊 Log detallado para debugging
                        console.log(`📚 [Filtro Asignaturas] Asignaciones encontradas para sección ${cascadeSectionId}:`);
                        console.log(`   Total de teacherAssignments en sistema: ${teacherAssignments.length}`);
                        const relevantAssignments = teacherAssignments.filter(a => String(a.sectionId) === String(cascadeSectionId));
                        console.log(`   Asignaciones para esta sección: ${relevantAssignments.length}`);
                        console.table(relevantAssignments.map(a => ({
                          teacherId: a.teacherId,
                          teacherUsername: a.teacherUsername,
                          sectionId: a.sectionId,
                          subjectName: a.subjectName,
                          subjects: Array.isArray(a.subjects) ? a.subjects.join(', ') : a.subjectName
                        })));
                        console.log(`   ✅ Asignaturas filtradas por nivel (${selectedCourseLevel}):`, items);
                        
                        return items;
                      })().map(n => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => { const isSelected = cascadeSubject === n; setCascadeSubject(isSelected ? null : n); setSubjectFilter(isSelected || n === 'General' ? 'all' : n); }}
                          className={`inline-flex items-center rounded-full px-3 py-1 text-xs border transition ${
                            cascadeSubject === n ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                          }`}
                        >{n}</button>
                      ))}
                    </div>
                  </div>
                )}

                {(() => { // mostrar estudiantes cuando hay una sección seleccionada
                  const basicFiltersReady = !!cascadeSectionId;
                  // No mostrar para estudiantes ni para apoderados (ellos ya tienen selector propio)
                  if (!(basicFiltersReady && user?.role !== 'student' && user?.role !== 'guardian')) return null;
                  return (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">{tr('students', 'Estudiantes')}</div>
                    <div className="flex flex-wrap gap-2">
                      {users
                        .filter(u => (u?.role === 'student' || u?.role === 'estudiante'))
                        .filter(u => studentAssignments.some(a => (String(a.studentId) === String(u.id) || String(a.studentUsername) === String(u.username)) && String(a.sectionId) === String(cascadeSectionId)))
                        .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')))
                        .map(u => {
                          const selected = studentFilter !== 'all' && String(studentFilter) === String(u.id);
                          return (
                            <button
                              key={String(u.id)}
                              type="button"
                              onClick={() => setStudentFilter(selected ? 'all' : String(u.id))}
                              className={`inline-flex items-center rounded-full px-3 py-1 text-xs border transition ${
                                selected ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                              }`}
                            >{u.displayName || u.name || u.username}</button>
                          );
                        })}
                    </div>
                  </div>
                  );
                })()}

                {/* Filtro de Semestre inferior (sin "Todos los semestres") */}
                <div>
                  <div className="text-xs text-muted-foreground mb-2">{tr('filterSemester', 'Semestre')}</div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      type="button"
                      onClick={() => setSemester(semester === '1' ? 'all' : '1')}
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs border transition ${
                        semester === '1'
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                      }`}
                    >{tr('firstSemester', '1er Semestre')}</button>
                    <button
                      type="button"
                      onClick={() => setSemester(semester === '2' ? 'all' : '2')}
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs border transition ${
                        semester === '2'
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500 dark:text-indigo-200'
                      }`}
                    >{tr('secondSemester', '2do Semestre')}</button>
                    {/* Botones de notas demo eliminados */}
                  </div>
                </div>

                {/* Botón de sincronización manual eliminado: la sincronización ahora es automática por eventos */}
              </div>
              {/* La tabla de resultados se mantiene debajo del Card en la misma columna */}
          </CardContent>
        </Card>

        {/* Resultados: un cuadro (Card) separado por cada asignatura - permanecen en columna izquierda */}
        {(() => {
          // 🎓 APODERADO: Mostrar todas las asignaturas cuando hay estudiante seleccionado
          const isGuardianWithStudent = user?.role === 'guardian' && selectedGuardianStudent;
          
          // 🎓 ESTUDIANTE: Mostrar todas las asignaturas automáticamente
          const isStudentRole = user?.role === 'student' || user?.role === 'estudiante';
          
          // 🔥 CAMBIO: Requiere nivel + curso + sección + semestre + ASIGNATURA para mostrar tabla
          // Excepto para apoderados y estudiantes que ven todas las asignaturas automáticamente
          const hasSubjectSelected = (subjectFilter && subjectFilter !== 'all') || (cascadeSubject && cascadeSubject !== '') || isGuardianWithStudent || isStudentRole;
          
          // 🎓 APODERADO: No requiere semestre específico, puede ver "all" (ambos semestres)
          const semesterReady = (semester === '1' || semester === '2') || isGuardianWithStudent;
          const minimalReady = !!cascadeSectionId && semesterReady && hasSubjectSelected;
          
          if (!cascadeSectionId || (!semesterReady)) {
            // Mensaje especial para apoderados sin estudiante seleccionado
            if (user?.role === 'guardian' && !selectedGuardianStudent) {
              return <Card className="mt-4"><CardContent><div className="text-muted-foreground text-sm py-4">
                <div className="flex items-center gap-2">
                  <span className="text-lg">👨‍👩‍👧</span>
                  <span>{tr('selectStudentFirst', 'Seleccione un estudiante para ver sus calificaciones')}</span>
                </div>
              </div></CardContent></Card>;
            }
            return <Card className="mt-4"><CardContent><div className="text-muted-foreground text-sm">{tr('selectAllFiltersToSeeStudents','Selecciona nivel, curso, sección y semestre para ver estudiantes')}</div></CardContent></Card>;
          }
          
          if (!hasSubjectSelected) {
            return <Card className="mt-4"><CardContent><div className="text-muted-foreground text-sm py-4">
              <div className="flex items-center gap-2">
                <span className="text-lg">📚</span>
                <span>{tr('selectSubjectToShowTable', 'Selecciona una asignatura para ver la tabla de calificaciones')}</span>
              </div>
              <div className="text-xs text-gray-500 mt-2">
                💡 Esto optimiza el rendimiento al cargar solo los datos necesarios
              </div>
            </div></CardContent></Card>;
          }
          
          if (studentsInView.length === 0) {
            return <Card className="mt-4"><CardContent><div className="text-muted-foreground text-sm">{tr('noStudentsForFilters', 'Sin estudiantes para los filtros seleccionados')}</div></CardContent></Card>;
          }
          return (
          (() => {
            // 🔎 Coincidencia flexible de asignaturas para datos heterogéneos (CSV/LS/SQL)
            const subjectLooseMatch = (a?: string, b?: string) => {
              // Limpiar mojibake antes de canonizar
              const cleanA = fixMojibake(String(a || ''));
              const cleanB = fixMojibake(String(b || ''));
              const A = canonicalSubject(cleanA);
              const B = canonicalSubject(cleanB);
              if (!A && !B) return true;
              if (!A || !B) return false;
              if (A === B || nearEqual(A, B)) return true;
              if (A.includes(B) || B.includes(A)) return true;
              const split = (s: string) => s
                .replace(/_/g, '')
                .split(/(y|e|de|del|la|las|los|el)/g)
                .map(t => t.trim())
                .filter(t => t && !['y','e','de','del','la','las','los','el'].includes(t) && t.length >= 4);
              const ta = split(A);
              const tb = split(B);
              const inter = ta.filter(t => tb.includes(t));
              return inter.length > 0;
            };
            let subjectsToRender: string[] = [];
            if (subjectFilter !== 'all') {
              subjectsToRender = [subjectFilter];
            } else if (cascadeSubject) {
              subjectsToRender = [cascadeSubject];
            } else {
              const nameSet = new Set<string>();
              
              // 🎯 OBTENER EL CURSO DE LA SECCIÓN SELECCIONADA
              const selectedSectionObj = cascadeSectionId 
                ? sections.find(s => String(s.id) === String(cascadeSectionId))
                : null;
              
              const selectedCourseId = selectedSectionObj 
                ? String(selectedSectionObj.courseId) 
                : null;
              
              console.log(`🎓 [Asignaturas] Curso seleccionado: ${selectedCourseId}`);
              console.log(`🔍 [Asignaturas] Secciones visibles:`, Array.from(visibleSectionIds));
              
              if (user?.role === 'teacher') {
                // Profesor: incluir todas las asignaturas disponibles del curso (secciones visibles)
                teacherAssignments.forEach(a => {
                  const isMine = (String(a.teacherId) === String((user as any)?.id)) || (String(a.teacherUsername) === String(user?.username));
                  if (!isMine) return;
                  if (!a || !a.sectionId) return;
                  
                  // ✅ IMPORTANTE: Verificar que la sección esté en las secciones visibles
                  if (!visibleSectionIds.has(String(a.sectionId))) return;
                  
                  // 🔥 Verificar que la sección pertenezca al curso seleccionado
                  if (selectedCourseId) {
                    const assignmentSection = sections.find(s => String(s.id) === String(a.sectionId));
                    if (!assignmentSection || String(assignmentSection.courseId) !== selectedCourseId) {
                      console.log(`⏭️ Omitiendo asignatura de otra sección/curso: ${a.subjectName || a.subjects}`);
                      return; // Skip asignaturas de otros cursos
                    }
                  }
                  
                  const names: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                  names.forEach(n => { if (n) nameSet.add(String(n)); });
                });
                // Importante: no hacer fallback al catálogo global para profesores
              } else if (user?.role === 'student') {
                // Estudiante: todas las asignaturas asignadas en su sección (cualquier profesor)
                teacherAssignments.forEach(a => {
                  if (!a || !a.sectionId) return;
                  
                  // ✅ IMPORTANTE: Verificar que la sección esté en las secciones visibles
                  if (!visibleSectionIds.has(String(a.sectionId))) return;
                  
                  // 🔥 Filtrar por curso del estudiante
                  if (selectedCourseId) {
                    const assignmentSection = sections.find(s => String(s.id) === String(a.sectionId));
                    if (!assignmentSection || String(assignmentSection.courseId) !== selectedCourseId) {
                      return;
                    }
                  }
                  
                  const names: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                  names.forEach(n => { if (n) nameSet.add(String(n)); });
                });
                if (nameSet.size === 0) {
                  subjects.forEach(su => { if (su?.name) nameSet.add(String(su.name)); });
                }
              } else if (user?.role === 'guardian') {
                // 🎓 APODERADO: Todas las asignaturas del curso/sección del estudiante seleccionado
                console.log(`👨‍👩‍👧 [Asignaturas Guardian] Cargando asignaturas para sección:`, cascadeSectionId);
                teacherAssignments.forEach(a => {
                  if (!a || !a.sectionId) return;
                  
                  // Solo mostrar asignaturas de la sección del estudiante seleccionado
                  if (String(a.sectionId) !== String(cascadeSectionId)) return;
                  
                  const names: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                  names.forEach(n => { if (n) nameSet.add(String(n)); });
                });
                
                // Fallback: si no hay teacher-assignments, extraer de calificaciones
                if (nameSet.size === 0 && filteredGrades.length > 0) {
                  console.log(`👨‍👩‍👧 [Asignaturas Guardian] Fallback: extrayendo de calificaciones`);
                  filteredGrades.forEach(g => {
                    const found = subjects.find(su => String(su.id) === String(g.subjectId));
                    const name = found?.name || (g.subjectId ? String(g.subjectId).replace(/_/g, ' ') : (g as any).subject ? String((g as any).subject) : '');
                    if (name) nameSet.add(String(name));
                  });
                }
                
                // Si aún no hay, usar catálogo global del nivel
                if (nameSet.size === 0) {
                  console.log(`👨‍👩‍👧 [Asignaturas Guardian] Usando catálogo global del nivel`);
                  subjects.forEach(su => { if (su?.name) nameSet.add(String(su.name)); });
                }
                
                console.log(`👨‍👩‍👧 [Asignaturas Guardian] Total asignaturas encontradas:`, nameSet.size);
              } else {
                // Admin: todas las asignaturas del curso seleccionado
                teacherAssignments.forEach(a => {
                  if (!a || !a.sectionId) return;
                  
                  // ✅ IMPORTANTE: Verificar que la sección esté en las secciones visibles
                  if (!visibleSectionIds.has(String(a.sectionId))) return;
                  
                  // 🔥 Filtrar por curso seleccionado
                  if (selectedCourseId) {
                    const assignmentSection = sections.find(s => String(s.id) === String(a.sectionId));
                    if (!assignmentSection || String(assignmentSection.courseId) !== selectedCourseId) {
                      return;
                    }
                  }
                  
                  const names: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                  names.forEach(n => { if (n) nameSet.add(String(n)); });
                });
                if (nameSet.size === 0) {
                  subjects.forEach(su => { if (su?.name) nameSet.add(String(su.name)); });
                }
              }
              
              // 🔁 FALLBACK: Si hay un estudiante seleccionado, incluir asignaturas detectadas
              // directamente desde sus calificaciones, para el caso en que no existan
              // teacher-assignments para esa asignatura en la sección.
              try {
                if (studentFilter !== 'all') {
                  const selectedStudent = studentsInView.find(s => String(s.id) === String(studentFilter));
                  if (selectedStudent) {
                    const stuRut = String((selectedStudent as any).rut || '').trim();
                    const stuUsername = String((selectedStudent as any).username || '');
                    const stuId = String((selectedStudent as any).id || '');
                    const gradesForStudent = filteredGrades.filter(g => {
                      const sid = String(g.studentId || '');
                      return sid === stuId || sid === stuUsername || (stuRut && sid === stuRut);
                    });
                    if (gradesForStudent.length) {
                      gradesForStudent.forEach(g => {
                        const found = subjects.find(su => String(su.id) === String(g.subjectId));
                        const name = found?.name || (g.subjectId ? String(g.subjectId).replace(/_/g, ' ') : (g as any).subject ? String((g as any).subject) : '');
                        if (name) nameSet.add(String(name));
                      });
                    }
                  }
                }
              } catch {}

              // 🔥 FILTRO CRÍTICO: Solo asignaturas válidas para el nivel del curso
              if (cascadeSectionId && selectedCourseId) {
                const course = courses.find(c => String(c.id) === selectedCourseId);
                if (course) {
                  const courseLevel = getCourseLevel(course.name) || 'basica';
                  const validLevelSubjects = getSubjectsForLevel(courseLevel);
                  const validNames = new Set(validLevelSubjects.map(s => normSubj(s.name)));
                  
                  console.log(`🔍 [Asignaturas] Nivel del curso: ${courseLevel}`);
                  console.log(`🔍 [Asignaturas] Válidas para nivel:`, Array.from(validNames));
                  
                  const filteredNames = new Set<string>();
                  nameSet.forEach(name => {
                    // Aplicar fixMojibake ANTES de normalizar para que coincida con validNames
                    const cleanedName = fixMojibake(String(name));
                    const normalized = normSubj(cleanedName);
                    if (validNames.has(normalized)) {
                      filteredNames.add(name);
                    } else {
                      console.log(`   ❌ Omitiendo "${name}" (no corresponde al nivel ${courseLevel})`);
                    }
                  });
                  
                  nameSet.clear();
                  filteredNames.forEach(name => nameSet.add(name));
                }
              }
              
              // 🧹 De-duplicar por forma canónica para evitar tarjetas repetidas (p.ej.,
              // "Ciencias Naturales" vs "ciencias naturales"). Preferir etiquetas con tildes bonitas.
              const canonToLabel = new Map<string, string>();
              const prettyByCanon: Record<string, string> = {
                'matematicas': 'Matemáticas',
                'lenguaje y comunicacion': 'Lenguaje y Comunicación',
                'ciencias naturales': 'Ciencias Naturales',
                'educacion fisica': 'Educación Física',
                'tecnologia': 'Tecnología',
                'musica': 'Música',
                'historia y geografia': 'Historia, Geografía y Ciencias Sociales'
              };
              const pickBetter = (prev: string | undefined, next: string, canon: string) => {
                // Si tenemos un nombre bonito predefinido para este canon, usarlo siempre
                if (prettyByCanon[canon]) return prettyByCanon[canon];
                const hasAccents = /[áéíóúñÁÉÍÓÚÑ]/.test(next);
                const prevAccents = prev ? /[áéíóúñÁÉÍÓÚÑ]/.test(prev) : false;
                if (hasAccents && !prevAccents) return next;
                // Mantener el existente por defecto
                return prev || next;
              };
              nameSet.forEach(n => {
                const cleaned = fixMojibake(String(n));
                const c = canonicalSubject(cleaned);
                if (!canonToLabel.has(c)) {
                  canonToLabel.set(c, pickBetter(undefined, cleaned, c));
                } else {
                  const prev = canonToLabel.get(c);
                  canonToLabel.set(c, pickBetter(prev, cleaned, c));
                }
              });
              subjectsToRender = Array.from(canonToLabel.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
              
              console.log(`✅ [Asignaturas] Total para renderizar: ${subjectsToRender.length}`, subjectsToRender);
            }
            if (subjectsToRender.length === 0) subjectsToRender = [''];
            return (
              <div className="pr-2">
                {subjectsToRender.map((subjName, idx) => (
                  <Card key={`card-${subjName || 'general'}`} className={`mt-4 ${studentFilter !== 'all' ? 'overflow-visible' : ''}`}>
                    <CardContent className={studentFilter !== 'all' ? 'overflow-visible' : ''}>
                  {/* Evitar scroll vertical dentro de cada tabla de asignatura; mantener solo scroll horizontal si es necesario */}
                  {/* Cuando hay estudiante filtrado: sin límite de altura, la tabla se expande completamente */}
                  <div className={studentFilter !== 'all' ? 'pb-8' : 'overflow-x-auto pb-12'}>
                    {/* Tabla optimizada: menos espacios vacíos; reducir tipografía en vista filtrada por estudiante para mayor densidad */}
                    <table className={`w-full table-fixed border-collapse ${studentFilter !== 'all' ? 'text-sm' : 'text-sm'}`}>
                      <colgroup>
                        {studentFilter === 'all' ? (
                          <>
                            <col style={{ width: '18%' }} />
                            <col style={{ width: '14%' }} />
                            {/* Ancho fijo para TODAS las asignaturas para alinear burbujas */}
                            <col style={{ width: '20%' }} />
                            {Array.from({ length: 10 }).map((_, i) => (
                              <col key={i} style={{ width: '3.8%' }} />
                            ))}
                            <col style={{ width: '10%' }} />
                          </>
                        ) : (
                          <>
                            <col style={{ width: '22%' }} />
                            <col style={{ width: '18%' }} />
                            {/* Ancho fijo para TODAS las asignaturas para alinear burbujas */}
                            <col style={{ width: '24%' }} />
                            {Array.from({ length: 10 }).map((_, i) => (
                              <col key={i} style={{ width: '3.2%' }} />
                            ))}
                            <col style={{ width: '11%' }} />
                          </>
                        )}
                      </colgroup>
                      {/* Encabezado visible solo en la primera tabla */}
                      {idx === 0 && (
                        <thead>
                          <tr>
                            <th className={`py-2 px-2 align-bottom text-left whitespace-nowrap text-sm`}>{tr('courseSection', 'Curso/Sección')}</th>
                            <th className={`py-2 px-2 pr-6 align-bottom text-left whitespace-nowrap text-sm`}>{tr('student', 'Estudiante')}</th>
                            <th className={`py-2 px-2 pl-6 align-bottom text-left whitespace-nowrap text-sm`}>{tr('subject', 'Asignatura')}</th>
                            <th className="py-2 px-2 text-center font-semibold text-sm" colSpan={10}>
                              {semester === '1' ? tr('firstSemester', '1er Semestre') : semester === '2' ? tr('secondSemester', '2do Semestre') : tr('allSemesters', 'Todos los semestres')}
                            </th>
                            <th className={`py-2 px-2 align-bottom text-center whitespace-nowrap text-sm`}>{tr('average', 'Promedio')}</th>
                          </tr>
                        </thead>
                      )}
                      <tbody>
                        {(() => {
                          // ============================================
                          // 🎯 PASO 1: CONSTRUIR ACTIVIDADES VISIBLES (FUENTE PRINCIPAL: activitiesSQL Firestore)
                          // Requerimiento usuario: mostrar actividades cargadas masivamente (Firebase) en las tablas
                          // Ordenadas por openAt (luego startAt / createdAt / dueDate) y filtradas por semestre, nivel, curso, sección, asignatura
                          // Fallback: si no hay activitiesSQL, derivar desde calificaciones como antes
                          // ============================================
                          const normSubj = (s?: string) => canonicalSubject(String(s || 'General'));
                          const subjCanon = normSubj(subjName);
                          const selectedSectionId = cascadeSectionId || comboSectionId !== 'all' ? comboSectionId : null;
                          
                          // Helper: determina semestre priorizando openAt > startAt > dueDate > createdAt
                          const pickSemesterBaseDate = (act: any): string | null => {
                            return act?.openAt || act?.startAt || act?.dueDate || act?.createdAt || null;
                          };
                          // Fuente de la fecha usada para el semestre (para debug)
                          const pickSemesterBaseSource = (act: any): 'openAt' | 'startAt' | 'dueDate' | 'createdAt' | 'none' => {
                            if (act?.openAt) return 'openAt';
                            if (act?.startAt) return 'startAt';
                            if (act?.dueDate) return 'dueDate';
                            if (act?.createdAt) return 'createdAt';
                            return 'none';
                          };
                          const getSemesterFromDate = (iso?: string | null) => {
                            if (!iso) return null;
                            const dt = new Date(iso); if (isNaN(dt.getTime())) return null;
                            const m = dt.getMonth(); // 0-based
                            if (m >= 2 && m <= 5) return '1'; // Mar-Jun
                            if (m >= 6 && m <= 11) return '2'; // Jul-Dic
                            return null;
                          };
                          // Resolver letter de una sección seleccionada para emparejar con actividades que tengan solo letra
                          const sectionLetter = (() => {
                            if (!cascadeSectionId) return null;
                            const sec = sections.find(s => String(s.id) === String(cascadeSectionId));
                            if (!sec) return null;
                            const nm = String(sec.name || '').trim();
                            if (/^[A-Za-zÑñ]$/.test(nm)) return nm.toLowerCase();
                            const m = nm.match(/([A-Za-zÑñ])$/);
                            return m ? m[1].toLowerCase() : null;
                          })();
                          // Nivel del curso seleccionado para filtro adicional
                          const selectedCourse = cascadeSectionId ? courses.find(c => String(c.id) === String(sections.find(s => String(s.id) === String(cascadeSectionId))?.courseId)) : null;
                          const selectedLevel = selectedCourse ? getCourseLevel(selectedCourse.name) : null;
                          const selectedCourseId = selectedCourse ? String(selectedCourse.id) : null;
                          
                          // Helper para normalizar nombres a formato ID (IGUAL que en el API backend)
                          // DEBE estar definido ANTES de usarse
                          function toId(...parts: string[]): string {
                            return parts
                              .map(p => String(p || '')
                                .toLowerCase()
                                .replace(/\s+/g, '_')
                                // Convertir vocales acentuadas a sin acento (igual que backend)
                                .replace(/[áàäâ]/g, 'a')
                                .replace(/[éèëê]/g, 'e')
                                .replace(/[íìïî]/g, 'i')
                                .replace(/[óòöô]/g, 'o')
                                .replace(/[úùüû]/g, 'u')
                                .replace(/ñ/g, 'n')
                                // Eliminar caracteres especiales restantes
                                .replace(/[^a-z0-9_\-]/g, '')
                              )
                              .filter(Boolean)
                              .join('-');
                          }
                          
                          // Nombre normalizado del curso seleccionado (para comparar con courseId legacy)
                          const selectedCourseNameNormalized = selectedCourse ? toId(selectedCourse.name) : null;
                          
                          // ============================================
                          // 🎯 ESTRATEGIA DE ACTIVIDADES:
                          // - SIEMPRE usar activitiesSQL de Firebase (tienen topic correcto de carga masiva)
                          // - Solo usar fallback de calificaciones si no hay actividades
                          // ============================================
                          
                          // Filtrar actividades
                          let activitiesForSubject: any[] = [];
                          if (Array.isArray(activitiesSQL) && activitiesSQL.length) {
                            const debugSem = (() => { try { return localStorage.getItem('debug-semester') === '1'; } catch { return false; } })();
                            const debugActivities = subjName && subjName.toLowerCase().includes('lenguaje');
                            if (debugActivities) {
                              console.log(`🎯 [DEBUG Actividades] Total activitiesSQL: ${activitiesSQL.length}`);
                              console.log(`🎯 [DEBUG Actividades] subjName: "${subjName}", subjCanon: "${subjCanon}"`);
                              console.log(`🎯 [DEBUG Actividades] selectedCourseId: ${selectedCourseId}, cascadeSectionId: ${cascadeSectionId}`);
                              console.log(`🎯 [DEBUG Actividades] Muestra activitiesSQL:`, activitiesSQL.slice(0, 5).map((a: any) => ({
                                id: a.id,
                                subjectName: a.subjectName,
                                courseId: a.courseId,
                                sectionId: a.sectionId,
                                title: a.title
                              })));
                            }
                            activitiesForSubject = activitiesSQL.filter((act: any) => {
                              try {
                                // Año ya filtrado al cargar activitiesSQL; se asume coincide selectedYear
                                // Filtrar por asignatura (tolerante)
                                const actSubCanon = normSubj(act.subjectName || act.subjectId || 'General');
                                // Aceptar coincidencia exacta o cercana (tolerar mojibake / pérdida de 1-2 caracteres)
                                const subjMatch = actSubCanon === subjCanon || nearEqual(actSubCanon, subjCanon, 2);
                                if (debugActivities && !subjMatch) {
                                  console.log(`❌ [DEBUG Filtro] Rechazado por asignatura: actSubCanon="${actSubCanon}" vs subjCanon="${subjCanon}"`, act.id);
                                }
                                if (!subjMatch) return false;
                                
                                // =====================================================
                                // 📌 FILTRO CURSO → SECCIÓN (estricto - nunca mezclar cursos)
                                // =====================================================
                                if (cascadeSectionId) {
                                  const actCourseId = act.courseId ? String(act.courseId) : null;
                                  const actSectionId = act.sectionId != null ? String(act.sectionId) : null;

                                  // Detectar si courseId es UUID vs string normalizado
                                  const isUUID = (id: string | null) => id && /[0-9a-f]{8}-[0-9a-f]{4}/.test(id.toLowerCase());
                                  const actCourseIdIsValid = isUUID(actCourseId);

                                  // REGLA CRÍTICA: La actividad DEBE tener courseId y DEBE coincidir
                                  if (!actCourseId) {
                                    return false;
                                  }

                                  // Helper para normalizar nombres de curso para comparación
                                  const normalizeCourseId = (s: string) => s.toLowerCase()
                                    .replace(/\s+/g, '_')
                                    .replace(/[áàäâ]/g, 'a')
                                    .replace(/[éèëê]/g, 'e')
                                    .replace(/[íìïî]/g, 'i')
                                    .replace(/[óòöô]/g, 'o')
                                    .replace(/[úùüû]/g, 'u')
                                    .replace(/ñ/g, 'n')
                                    .replace(/[^a-z0-9_-]/g, '');

                                  // Verificar courseId - debe coincidir con UUID o nombre normalizado
                                  let courseMatches = false;
                                  
                                  // Caso 1: Ambos son UUID - comparar directamente
                                  if (actCourseIdIsValid && selectedCourseId && isUUID(selectedCourseId)) {
                                    courseMatches = actCourseId === selectedCourseId;
                                  }
                                  // Caso 2: La actividad tiene string normalizado - comparar con nombre normalizado del curso
                                  else if (!actCourseIdIsValid && selectedCourseNameNormalized) {
                                    courseMatches = normalizeCourseId(actCourseId) === normalizeCourseId(selectedCourseNameNormalized);
                                  }
                                  // Caso 3: La actividad tiene UUID pero selectedCourse no es UUID - no debería pasar pero fallback
                                  else if (actCourseIdIsValid && selectedCourseId) {
                                    courseMatches = actCourseId === selectedCourseId;
                                  }
                                  // Caso 4: La actividad tiene string normalizado, comparar con nombre del curso seleccionado
                                  else if (!actCourseIdIsValid && selectedCourse?.name) {
                                    courseMatches = normalizeCourseId(actCourseId) === normalizeCourseId(selectedCourse.name);
                                  }

                                  if (!courseMatches) {
                                    if (debugActivities) {
                                      console.log(`❌ [DEBUG Filtro] Rechazado por curso: actCourseId="${actCourseId}" vs selectedCourseId="${selectedCourseId}" / selectedCourseName="${selectedCourse?.name}"`, act.id);
                                    }
                                    return false;
                                  }

                                  // Verificar sectionId si existe
                                  if (actSectionId) {
                                    // Normalizar sección para comparación
                                    const normSection = (s: string) => s.toLowerCase().trim();
                                    
                                    if (actSectionId.length <= 2) {
                                      // Es letra (A, B, etc.)
                                      if (!sectionLetter || normSection(actSectionId) !== normSection(sectionLetter)) {
                                        if (debugActivities) {
                                          console.log(`❌ [DEBUG Filtro] Rechazado por sección letra: actSectionId="${actSectionId}" vs sectionLetter="${sectionLetter}"`, act.id);
                                        }
                                        return false;
                                      }
                                    } else {
                                      // Es UUID o string normalizado
                                      const sectionMatches = actSectionId === String(cascadeSectionId) || 
                                                            (sectionLetter && normSection(actSectionId) === normSection(sectionLetter));
                                      if (!sectionMatches) {
                                        if (debugActivities) {
                                          console.log(`❌ [DEBUG Filtro] Rechazado por sección: actSectionId="${actSectionId}" vs cascadeSectionId="${cascadeSectionId}" / sectionLetter="${sectionLetter}"`, act.id);
                                        }
                                        return false;
                                      }
                                    }
                                  }
                                }
                                
                                if (debugActivities) {
                                  console.log(`✅ [DEBUG Filtro ACEPTADO FINAL]:`, act.id, act.title, `courseId=${act.courseId}, sectionId=${act.sectionId}`);
                                }
                                // Filtrar por nivel si corresponde
                                if (levelFilter !== 'all' && selectedLevel && levelFilter !== selectedLevel) return false;
                                // Filtrar por semestre
                                // Prioridad para definir el semestre de una actividad:
                                // 1) openAt (apertura real) 2) startAt 3) dueDate 4) createdAt (último recurso)
                                if (semester === '1' || semester === '2') {
                                  const semRef = pickSemesterBaseDate(act);
                                  const src = pickSemesterBaseSource(act);
                                  const sem = getSemesterFromDate(semRef);
                                  const include = sem === semester;
                                  if (debugSem && subjName && subjName.toLowerCase().includes('lenguaje')) {
                                    console.debug(`[SEM-FILTER] ${include ? '✓' : '✗'} ${act.title || act.id} | src=${src} | ref=${semRef} | openAt=${act.openAt} | startAt=${act.startAt} | dueDate=${act.dueDate} | createdAt=${act.createdAt} | sem=${sem}`);
                                  }
                                  if (!include) return false;
                                }
                                return true;
                              } catch { return false; }
                            });
                            // Deduplicar por clave unificada: asignaturaCanon | yyyy-mm-dd | tipoAgrupado | tituloNormalizado
                            const before = activitiesForSubject.length;
                            const seen = new Set<string>();
                            const toCanon = (s: string) => canonicalSubject(String(s || 'General'));
                            const normTitle = (s: any) => {
                              const t = fixMojibake(String(s || '')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                              return t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
                            };
                            const groupType = (t: any) => {
                              const ty = String(t || '').toLowerCase();
                              if (ty.includes('tarea')) return 'tarea';
                              if (ty.includes('prueba') || ty.includes('evaluacion')) return 'eval';
                              return 'eval';
                            };
                            const deduped: any[] = [];
                            const debugDedupe = (() => { try { return localStorage.getItem('debug-semester') === '1' && subjName && subjName.toLowerCase().includes('lenguaje'); } catch { return false; } })();
                            activitiesForSubject.forEach(a => {
                              const rawDate = a.openAt || a.startAt || a.dueDate || a.createdAt || a.timestamp || a.id;
                              const d = new Date(rawDate);
                              const day = isNaN(d.getTime()) ? String(rawDate) : d.toISOString().slice(0,10);
                              const typeKey = groupType(a.taskType || a.type || 'tarea');
                              const titleKey = normTitle(a.title || a.topic || a.id);
                              const subjectKey = subjCanon || toCanon(a.subjectName || a.subjectId || 'General');
                              const key = `${subjectKey}|${day}|${typeKey}|${titleKey}`;
                              if (debugDedupe) {
                                console.log(`🔑 Dedup key: ${key}`);
                                console.log(`   Actividad: ${a.title || a.id} | tipo=${a.taskType} | día=${day} | ya existe=${seen.has(key)}`);
                              }
                              if (!seen.has(key)) { seen.add(key); deduped.push(a); }
                            });
                            if (deduped.length !== before) {
                              try { if (localStorage.getItem('debug-semester') === '1') console.info(`🧹 Dedup actividades: ${before} → ${deduped.length}`); } catch {}
                            }
                            if (debugDedupe && deduped.length > 5) {
                              console.warn(`⚠️ PROBLEMA: Después de dedup quedan ${deduped.length} actividades (esperadas: 5)`);
                              console.log('📋 Actividades deduplicadas:', deduped.map(a => ({
                                id: a.id,
                                title: a.title || a.topic,
                                tipo: a.taskType,
                                día: new Date(a.openAt || a.startAt || a.dueDate || a.createdAt).toISOString().slice(0,10),
                                createdAt: a.createdAt
                              })));
                            }
                            activitiesForSubject = deduped;

                            // ✂️ Poda especial: excluir actividades cuya única fecha es createdAt (ruido de carga) si hay suficientes con fechas reales
                            const withSrc = activitiesForSubject.map(a => ({ ...a, __semSrc: pickSemesterBaseSource(a) }));
                            const real = withSrc.filter(a => a.__semSrc !== 'createdAt');
                            const onlyCreated = withSrc.filter(a => a.__semSrc === 'createdAt');
                            // Preferir fechas reales, pero completar con createdAt hasta 10 si es necesario
                            if ((semester === '1' || semester === '2')) {
                              if (real.length >= 10) {
                                activitiesForSubject = real.slice(0, 10);
                              } else if (real.length > 0) {
                                const needed = 10 - real.length;
                                activitiesForSubject = [...real, ...onlyCreated.slice(0, needed)];
                              } else {
                                // solo createdAt disponibles para este semestre: mantenerlas
                                activitiesForSubject = onlyCreated;
                              }
                            }
                            // Límite específico solicitado: 1er semestre Lenguaje debe mostrar solo 6
                            // Eliminada poda específica a 6: mostrar actividades reales tal cual (5 en 1er semestre según CSV)
                            // Log resumen final
                            try {
                              if (localStorage.getItem('debug-semester') === '1' && subjName && subjName.toLowerCase().includes('lenguaje')) {
                                console.info(`🔎 Resumen actividades filtradas (${subjName}, semestre=${semester}): total=${withSrc.length}, reales=${real.length}, soloCreated=${onlyCreated.length}, usadas=${activitiesForSubject.length}`);
                              }
                            } catch {}
                          }
                          // Ordenar por prioridad correcta de fechas: openAt > startAt > dueDate > createdAt
                          // Helper para convertir Firestore Timestamp a millis
                          const toMs = (v: any): number => {
                            if (!v) return 0;
                            // Firestore Timestamp con método toMillis()
                            if (typeof v.toMillis === 'function') return v.toMillis();
                            // Firestore Timestamp con método toDate()
                            if (typeof v.toDate === 'function') return v.toDate().getTime();
                            // Objeto con _seconds (formato serializado de Firestore)
                            if (typeof v._seconds === 'number') return v._seconds * 1000 + (v._nanoseconds || 0) / 1000000;
                            // Objeto con seconds (formato alternativo)
                            if (typeof v.seconds === 'number') return v.seconds * 1000 + (v.nanoseconds || 0) / 1000000;
                            // Número directo (timestamp)
                            if (typeof v === 'number' && isFinite(v)) return v;
                            // String ISO o fecha
                            if (typeof v === 'string') {
                              const d = new Date(v);
                              return isFinite(d.getTime()) ? d.getTime() : 0;
                            }
                            // Intentar new Date como último recurso
                            const d = new Date(v);
                            return isFinite(d.getTime()) ? d.getTime() : 0;
                          };
                          const pickTs = (a: any) => {
                            const val = a.openAt || a.startAt || a.dueDate || a.createdAt;
                            return toMs(val);
                          };
                          activitiesForSubject.sort((a,b)=> pickTs(a) - pickTs(b));
                          
                          // 🆕 Crear mapa de topics desde calificaciones usando fecha+tipo como clave
                          // Esto permite vincular actividades con sus temas aunque los IDs sean diferentes
                          // ⚠️ IMPORTANTE: Filtrar solo calificaciones de la asignatura actual
                          const topicByDateType = new Map<string, string>();
                          filteredGrades.forEach(grade => {
                            const gradeAny = grade as any;
                            // Verificar que la calificación pertenece a esta asignatura
                            const gradeSubj = normSubj(gradeAny.subjectId || gradeAny.subject || '');
                            if (gradeSubj !== subjCanon) return;
                            
                            if (gradeAny.topic && String(gradeAny.topic).trim()) {
                              // Crear clave basada en fecha (día) + tipo
                              const ts = typeof grade.gradedAt === 'number' ? grade.gradedAt : normalizeGradedAt(grade.gradedAt);
                              const dateKey = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
                              const typeKey = String(gradeAny.type || gradeAny.taskType || 'tarea').toLowerCase();
                              const key = `${dateKey}|${typeKey}`;
                              if (!topicByDateType.has(key)) {
                                topicByDateType.set(key, String(gradeAny.topic).trim());
                              }
                            }
                          });
                          
                          // Limitar a 10 (N1..N10) después de ordenar; tipos deben reflejar CSV
                          let courseActivities = activitiesForSubject.slice(0,10).map((a, idx) => {
                            const taskType = String(a.taskType || a.type || 'tarea');
                            const ts = pickTs(a);
                            // Nombres de tipos en español
                            const tipoLabel: Record<string, string> = {
                              'tarea': 'Tarea',
                              'evaluacion': 'Evaluación', 
                              'prueba': 'Prueba'
                            };
                            const tipoNombre = tipoLabel[taskType.toLowerCase()] || 'Actividad';
                            
                            // Función para limpiar fecha ISO del final del string (ej: "Matemáticas 2025-07-14" -> "Matemáticas")
                            const cleanDateSuffix = (s: string) => s.replace(/\s*\d{4}-\d{2}-\d{2}$/, '').trim();
                            
                            // Función para detectar si un string parece ser un ID técnico (no un título legible)
                            const looksLikeTechnicalId = (s: string): boolean => {
                              if (!s || !s.trim()) return true;
                              const str = s.trim();
                              // Detectar UUID típico al inicio
                              if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(str)) return true;
                              // Detectar IDs técnicos snake_case/kebab-case largos sin espacios
                              if (/^[a-z0-9_-]+$/i.test(str) && str.length > 25 && !str.includes(' ')) return true;
                              // Detectar patrón de ID con underscores múltiples
                              if ((str.match(/_/g) || []).length >= 3) return true;
                              return false;
                            };
                            
                            // Obtener topic y title limpios
                            const rawTopic = String(a.topic || '').trim();
                            const rawTitle = String(a.title || '').trim();
                            
                            // 🆕 Buscar topic desde calificaciones usando fecha+tipo
                            const actDateKey = ts ? new Date(ts).toISOString().slice(0, 10) : '';
                            const actTypeKey = taskType.toLowerCase();
                            const gradeTopicKey = `${actDateKey}|${actTypeKey}`;
                            const topicFromGrade = topicByDateType.get(gradeTopicKey) || '';
                            
                            // 🔍 DEBUG: Ver de dónde viene el topic
                            console.log(`📋 [Topic Debug] Activity ${a.id}:`, {
                              rawTopic,
                              rawTitle,
                              topicFromGrade,
                              gradeTopicKey,
                              rawTopicIsTechnical: looksLikeTechnicalId(rawTopic),
                              topicFromGradeIsTechnical: looksLikeTechnicalId(topicFromGrade)
                            });
                            
                            // Priorizar: 1) topic de calificación (más reciente), 2) topic de actividad, 3) title de actividad
                            let finalTopic: string;
                            if (topicFromGrade && !looksLikeTechnicalId(topicFromGrade)) {
                              finalTopic = cleanDateSuffix(topicFromGrade);
                            } else if (rawTopic && !looksLikeTechnicalId(rawTopic)) {
                              finalTopic = cleanDateSuffix(rawTopic);
                            } else if (rawTitle && !looksLikeTechnicalId(rawTitle)) {
                              finalTopic = cleanDateSuffix(rawTitle);
                            } else {
                              finalTopic = `${tipoNombre} ${subjName || ''}`.trim();
                            }
                            
                            // Para title, usar: 1) topic de calificación, 2) title de actividad, 3) topic de actividad
                            let finalTitle: string;
                            if (topicFromGrade && !looksLikeTechnicalId(topicFromGrade)) {
                              finalTitle = cleanDateSuffix(topicFromGrade);
                            } else if (rawTitle && !looksLikeTechnicalId(rawTitle)) {
                              finalTitle = cleanDateSuffix(rawTitle);
                            } else if (rawTopic && !looksLikeTechnicalId(rawTopic)) {
                              finalTitle = cleanDateSuffix(rawTopic);
                            } else {
                              finalTitle = `${tipoNombre} ${subjName || ''}`.trim();
                            }
                            
                            return {
                              id: String(a.id),
                              testId: String(a.id),
                              title: fixMojibake(finalTitle),
                              taskType,
                              timestamp: ts,
                              subject: subjName,
                              topic: fixMojibake(finalTopic)
                            };
                          });
                          // Fallback si NO hay actividades SQL: reconstruir desde calificaciones
                          if (courseActivities.length === 0) {
                            const activitiesMap = new Map<string, any>();
                            // Función para limpiar fecha ISO del final
                            const cleanDateSuffix = (s: string) => s.replace(/\s*\d{4}-\d{2}-\d{2}$/, '').trim();
                            // Función para detectar IDs técnicos
                            const looksLikeTechnicalId = (s: string): boolean => {
                              if (!s || !s.trim()) return true;
                              const str = s.trim();
                              if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(str)) return true;
                              if (/^[a-z0-9_-]+$/i.test(str) && str.length > 25 && !str.includes(' ')) return true;
                              if ((str.match(/_/g) || []).length >= 3) return true;
                              return false;
                            };
                            
                            filteredGrades.forEach(grade => {
                              const gradeAny = grade as any;
                              const gradeSub = grade.subjectId || gradeAny.subject || grade.title?.split(' ')[0] || '';
                              if (normSubj(gradeSub) !== subjCanon) return;
                              
                              // Filtrar por semestre
                              const ts = typeof grade.gradedAt === 'number' ? grade.gradedAt : normalizeGradedAt(grade.gradedAt);
                              if (semester === '1' || semester === '2') {
                                const m = new Date(ts).getMonth();
                                const sem = (m >= 2 && m <=5) ? '1' : (m >=6 && m <=11 ? '2' : null);
                                if (sem !== semester) return;
                              }
                              
                              // Determinar tipo desde calificación
                              const gradeType = String(gradeAny.type || gradeAny.taskType || '').toLowerCase();
                              const testId = String(grade.testId || '');
                              const idLow = testId.toLowerCase();
                              const taskType: any = gradeType || (idLow.includes('evaluacion') ? 'evaluacion' : (idLow.includes('prueba') ? 'prueba' : 'tarea'));
                              
                              // 🆕 CLAVE: usar fecha+tipo para evitar duplicados (misma actividad = mismo día + tipo)
                              const dateKey = new Date(ts).toISOString().slice(0, 10);
                              const activityKey = `${dateKey}|${taskType}`;
                              
                              if (!activitiesMap.has(activityKey)) {
                                const tipoLabel: Record<string, string> = { 'tarea': 'Tarea', 'evaluacion': 'Evaluación', 'prueba': 'Prueba' };
                                const tipoNombre = tipoLabel[taskType] || 'Actividad';
                                const fallbackLabel = `${tipoNombre} ${subjName || ''}`.trim();
                                
                                const rawTopic = String(gradeAny.topic || '').trim();
                                const rawTitle = String(grade.title || '').trim();
                                
                                let finalTopic: string;
                                const topicIsTechnical = looksLikeTechnicalId(rawTopic);
                                const titleIsTechnical = looksLikeTechnicalId(rawTitle);
                                
                                if (rawTopic && !topicIsTechnical) {
                                  finalTopic = cleanDateSuffix(rawTopic);
                                } else if (rawTitle && !titleIsTechnical) {
                                  finalTopic = cleanDateSuffix(rawTitle);
                                } else {
                                  finalTopic = fallbackLabel;
                                }
                                
                                let finalTitle: string;
                                if (rawTitle && !titleIsTechnical) {
                                  finalTitle = cleanDateSuffix(rawTitle);
                                } else if (rawTopic && !topicIsTechnical) {
                                  finalTitle = cleanDateSuffix(rawTopic);
                                } else {
                                  finalTitle = fallbackLabel;
                                }
                                
                                // 🆕 Usar activityKey (fecha|tipo) como clave para evitar duplicados
                                activitiesMap.set(activityKey, { 
                                  id: activityKey, 
                                  testId: grade.testId, 
                                  title: finalTitle, 
                                  taskType, 
                                  timestamp: ts, 
                                  subject: subjName, 
                                  topic: finalTopic 
                                });
                              }
                            });
                            courseActivities = Array.from(activitiesMap.values()).sort((a,b)=>a.timestamp-b.timestamp).slice(0,10);
                          }
                          const activitiesSource = activitiesForSubject.length ? 'Firestore' : 'fallback-grades';
                          console.log(`🎯 [Actividades Tablas] ${subjName}: ${courseActivities.length} actividades (origen=${activitiesSource}, studentFilter=${studentFilter})`, courseActivities.slice(0, 3).map(a=>({tipo:a.taskType, fecha:new Date(a.timestamp).toLocaleDateString('es-CL'), topic: a.topic})));
                          
                          // ============================================
                          // 🎯 PASO 2: CONSTRUIR ITEMS (GRUPOS Y FILAS)
                          // ============================================
                          type Item =
                            | { kind: 'group'; key: string; courseSectionLabel: string; sectionId?: string | null; activities: any[] }
                            | { kind: 'row'; key: string; courseSectionLabel: string; student: any; subjectName: string; gradesList: TestGrade[]; rowAvg: number | null; sectionId?: string | null };
                          const items: Item[] = [];
                          let prevGroup: string | null = null;
                          // 🚫 Evitar filas duplicadas por (estudiante, sección, asignatura canónica)
                          const seenRowKeys = new Set<string>();
                          const pushGroup = (label: string, sectionId?: string | null, activities: any[] = []) => {
                            items.push({ kind: 'group', key: `grp-${subjName || 'general'}-${label}`, courseSectionLabel: label, sectionId: sectionId ?? null, activities });
                          };
                          const pushRow = (opts: { label: string; stu: any; subjectName: string; list: TestGrade[]; rowAvg: number | null; sectionId?: string | null }) => {
                            const canon = canonicalSubject(subjName || 'general');
                            const dedupKey = `${String(opts.stu.id)}|${String(opts.sectionId ?? '')}|${canon}`;
                            if (seenRowKeys.has(dedupKey)) {
                              // Debug opcional para rastrear duplicados
                              try { console.debug(`↩️ Saltando fila duplicada: ${dedupKey}`); } catch {}
                              return;
                            }
                            seenRowKeys.add(dedupKey);
                            items.push({ kind: 'row', key: `${String(opts.stu.id)}-${String(opts.sectionId)}-${subjName || 'general'}`, courseSectionLabel: opts.label, student: opts.stu, subjectName: opts.subjectName, gradesList: opts.list, rowAvg: opts.rowAvg, sectionId: opts.sectionId ?? null });
                          };
                          
                          // 🔍 DEBUG GLOBAL: Verificar campo RUT en estudiantes (solo una vez)
                          const debugKey = `rut-debug-${subjName}`;
                          if (!seenRowKeys.has(debugKey)) {
                            seenRowKeys.add(debugKey);
                            const withRut = studentsInView.filter(s => s.rut && String(s.rut).trim() !== '');
                            const withoutRut = studentsInView.filter(s => !s.rut || String(s.rut).trim() === '');
                            console.log(`\n📊 [DEBUG RUT] Estudiantes en vista: ${studentsInView.length}, CON RUT: ${withRut.length}, SIN RUT: ${withoutRut.length}`);
                            if (withoutRut.length > 0) {
                              console.log(`   Primeros 3 SIN RUT:`, withoutRut.slice(0, 3).map(s => ({ id: s.id, name: s.displayName || s.name, username: s.username, rut: s.rut })));
                            }
                            if (withRut.length > 0) {
                              console.log(`   Primeros 3 CON RUT:`, withRut.slice(0, 3).map(s => ({ id: s.id, name: s.displayName || s.name, username: s.username, rut: s.rut })));
                            }
                            // Ver también algunas calificaciones
                            console.log(`   Total filteredGrades: ${filteredGrades.length}`);
                            if (filteredGrades.length > 0) {
                              console.log(`   Ejemplo calificación:`, { studentId: filteredGrades[0].studentId, studentName: filteredGrades[0].studentName });
                            }
                          }
                          
                          studentsInView.forEach((stu) => {
                            const assign = studentAssignments.find(a => (String(a.studentId) === String(stu.id) || String(a.studentUsername) === String(stu.username)) && visibleSectionIds.has(String(a.sectionId)));
                            const section = sections.find(s => String(s.id) === String(assign?.sectionId));
                            const course = courses.find(c => String(c.id) === String(section?.courseId));
                            
                            // 🔥 Buscar calificaciones usando tanto userId como RUT
                            const stuRut = String(stu.rut || '').trim();
                            const stuUsername = String(stu.username || '').trim();
                            
                            // Helper para normalizar nombres (quitar acentos, lowercase, trim)
                            const normalizeName = (name: string): string => {
                              return String(name || '')
                                .toLowerCase()
                                .trim()
                                .normalize('NFD')
                                .replace(/[\u0300-\u036f]/g, '');
                            };
                            const stuName = normalizeName(stu.displayName || stu.name || '');
                            
                            // Extraer sufijo numérico del username para match con RUT
                            const extractRutSuffix = (username: string): string => {
                              const match = username.match(/(\d+)$/);
                              return match ? match[1] : '';
                            };
                            const usernameSuffix = extractRutSuffix(stuUsername);
                            
                            // 🔍 DEBUG Alberto: Ver por qué no aparecen sus calificaciones
                            if (stu.displayName?.includes('Alberto') || stu.name?.includes('Alberto')) {
                              console.log(`\n🔍 [DEBUG Alberto] TODOS LOS CAMPOS:`, JSON.stringify(stu, null, 2));
                              console.log(`   stuName normalizado: "${stuName}"`);
                              console.log(`   stuRut: "${stuRut}"`);
                              console.log(`   stuUsername: "${stuUsername}"`);
                              console.log(`   usernameSuffix: "${usernameSuffix}"`);
                              console.log(`   Total filteredGrades: ${filteredGrades.length}`);
                              
                              // Buscar calificaciones de Alberto por nombre y por RUT
                              const albertoGrades = filteredGrades.filter(g => 
                                String(g.studentName || '').toLowerCase().includes('alberto') ||
                                String(g.studentId || '').includes('10000761')
                              );
                              console.log(`   Calificaciones de Alberto en Firebase (por nombre o RUT 10000761): ${albertoGrades.length}`);
                              if (albertoGrades.length > 0) {
                                const g = albertoGrades[0];
                                const gName = normalizeName(g.studentName || '');
                                console.log(`   Ejemplo calificación:`, {
                                  studentId: g.studentId,
                                  studentName: g.studentName,
                                  studentNameNormalized: gName,
                                  score: g.score
                                });
                                console.log(`   Comparación nombres: stuName="${stuName}" vs gName="${gName}" → match=${stuName === gName}`);
                              }
                            }
                            
                            // 🔍 DEBUG Martina: Ver qué hay en filteredGrades
                            if (stu.displayName?.includes('Martina')) {
                              console.log(`\n🔍 [DEBUG Martina Pre-Filter]`);
                              console.log(`   Estudiante ID: ${stu.id}`);
                              console.log(`   Estudiante username: ${stu.username}`);
                              console.log(`   Estudiante RUT: ${stuRut}`);
                              console.log(`   Total filteredGrades: ${filteredGrades.length}`);
                              const potentialGrades = filteredGrades.filter(g => {
                                const gradeStudentId = String(g.studentId);
                                return gradeStudentId.includes('10000004') || 
                                       String(g.studentName).includes('Martina');
                              });
                              console.log(`   Calificaciones que podrían ser de Martina (${potentialGrades.length}):`, potentialGrades.map(g => ({
                                studentId: g.studentId,
                                studentName: g.studentName,
                                score: g.score,
                                subjectId: g.subjectId,
                                title: g.title
                              })));
                            }
                            
                            const listAll = filteredGrades.filter(g => {
                              const gradeStudentId = String(g.studentId || '');
                              const gradeStudentName = normalizeName(g.studentName || '');
                              
                              // 1. Match por ID directo
                              if (gradeStudentId === String(stu.id)) return true;
                              // 2. Match por username
                              if (gradeStudentId === stuUsername) return true;
                              // 3. Match por RUT (con y sin puntos/guión)
                              if (stuRut && gradeStudentId === stuRut) return true;
                              if (stuRut && gradeStudentId.replace(/[.-]/g, '') === stuRut.replace(/[.-]/g, '')) return true;
                              // 4. Match por nombre exacto normalizado (para carga masiva)
                              if (stuName && gradeStudentName && stuName === gradeStudentName) return true;
                              // 5. Match por nombre parcial (primer nombre + primer apellido)
                              if (stuName && gradeStudentName) {
                                const stuParts = stuName.split(/\s+/).filter(Boolean);
                                const gradeParts = gradeStudentName.split(/\s+/).filter(Boolean);
                                // Si comparten al menos nombre y un apellido
                                if (stuParts.length >= 2 && gradeParts.length >= 2) {
                                  if (stuParts[0] === gradeParts[0] && stuParts[1] === gradeParts[1]) return true;
                                }
                              }
                              // 6. Match inverso - si el studentId de la calificación es un RUT
                              if (gradeStudentId && stuUsername) {
                                if (/^\d{7,8}-[\dkK]$/i.test(gradeStudentId)) {
                                  if (gradeStudentId.toLowerCase() === stuUsername.toLowerCase()) return true;
                                  if (gradeStudentId.replace(/-/g, '').toLowerCase() === stuUsername.replace(/-/g, '').toLowerCase()) return true;
                                }
                              }
                              // 🔥 7. Match por sufijo del username vs sufijo del RUT
                              // Username: a.araya7614 → sufijo "7614"
                              // RUT: 10000761-4 → sin guión "100007614" → últimos 4 dígitos "7614"
                              if (usernameSuffix && usernameSuffix.length >= 3 && /^\d{7,8}-[\dkK]$/i.test(gradeStudentId)) {
                                const rutClean = gradeStudentId.replace(/-/g, '').toLowerCase();
                                const rutSuffix = rutClean.slice(-usernameSuffix.length);
                                if (rutSuffix === usernameSuffix.toLowerCase()) {
                                  // Verificar también que el primer nombre coincida
                                  if (stuName && gradeStudentName) {
                                    const stuFirst = stuName.split(/\s+/)[0] || '';
                                    const gradeFirst = gradeStudentName.split(/\s+/)[0] || '';
                                    if (stuFirst === gradeFirst) return true;
                                  }
                                }
                              }
                              // 🔥 8. NUEVO: Match directo por primer nombre + segundo nombre/apellido ignorando acentos
                              // Esto es un fallback más permisivo
                              if (stuName && gradeStudentName && stuName.length > 3 && gradeStudentName.length > 3) {
                                // Comparar los primeros 2 "tokens" del nombre
                                const stuTokens = stuName.split(/\s+/).slice(0, 2).join(' ');
                                const gradeTokens = gradeStudentName.split(/\s+/).slice(0, 2).join(' ');
                                if (stuTokens === gradeTokens) return true;
                              }
                              
                              return false;
                            });
                            
                            const nameOf = (g: any) => {
                              const found = subjects.find(su => String(su.id) === String(g.subjectId));
                              const raw = found?.name || (g.subjectId ? String(g.subjectId) : (g as any).subject ? String((g as any).subject) : '');
                              // Limpiar mojibake antes de devolver
                              return fixMojibake(raw);
                            };
                            
                            // 🔍 DEBUG INICIAL: Ver qué hay en listAll para Historia
                            if (subjName?.toLowerCase().includes('historia') && stu.displayName?.includes('Sofía')) {
                              console.log(`\n📋 [DEBUG Historia PRE-FILTRO] Estudiante: ${stu.displayName}`);
                              console.log(`   📋 subjName (tarjeta): "${subjName}"`);
                              console.log(`   📊 listAll.length: ${listAll.length}`);
                              if (listAll.length > 0) {
                                console.log(`   📚 Asignaturas en listAll:`, listAll.map(g => ({
                                  subjectId: g.subjectId,
                                  rawName: nameOf(g),
                                  canonical: canonicalSubject(nameOf(g))
                                })));
                              }
                            }
                            
                            // Filtro por asignatura: lógica diferente según si hay filtro explícito o no
                            let listBySubject = listAll.filter(g => {
                              const rawName = nameOf(g);
                              
                              // Si hay filtro de asignatura explícito: comparar con el filtro, no con subjName
                              if (subjectFilter !== 'all') {
                                const matchFilter = subjectLooseMatch(rawName, subjectFilter);

                                // 🔍 DEBUG ampliado: mostrar formas limpias y canónicas
                                if (subjectFilter.toLowerCase().includes('historia') && stu.displayName?.includes('Sofía')) {
                                  const cleanedRaw = fixMojibake(String(rawName || ''));
                                  const cleanedFilter = fixMojibake(String(subjectFilter || ''));
                                  const rawCanon = canonicalSubject(cleanedRaw);
                                  const filterCanon = canonicalSubject(cleanedFilter);
                                  console.log(`   🔎 [Con Filtro] rawName="${rawName}" cleanedRaw="${cleanedRaw}" rawCanon="${rawCanon}" vs subjectFilter="${subjectFilter}" cleanedFilter="${cleanedFilter}" filterCanon="${filterCanon}" → ${matchFilter ? '✅' : '❌'}`);
                                }

                                return matchFilter;
                              }
                              
                              // Sin filtro explícito: cada tarjeta muestra sus calificaciones
                              const match = subjectLooseMatch(rawName, subjName);
                              
                              // 🔍 DEBUG ampliado: mostrar formas limpias y canónicas
                              if (subjName?.toLowerCase().includes('historia') && stu.displayName?.includes('Sofía')) {
                                const cleanedRaw = fixMojibake(String(rawName || ''));
                                const cleanedCard = fixMojibake(String(subjName || ''));
                                const rawCanon = canonicalSubject(cleanedRaw);
                                const cardCanon = canonicalSubject(cleanedCard);
                                console.log(`   🔎 [Sin Filtro] rawName="${rawName}" cleanedRaw="${cleanedRaw}" rawCanon="${rawCanon}" vs subjName="${subjName}" cleanedCard="${cleanedCard}" cardCanon="${cardCanon}" → ${match ? '✅' : '❌'}`);
                              }
                              
                              return match;
                            });
                            
                            // 🔍 DEBUG POST-FILTRO
                            if (subjName?.toLowerCase().includes('historia') && stu.displayName?.includes('Sofía')) {
                              console.log(`\n📊 [DEBUG Historia POST-FILTRO]`);
                              console.log(`   📊 listBySubject.length: ${listBySubject.length}`);
                              if (listBySubject.length > 0) {
                                console.log(`   ✅ Calificaciones encontradas:`, listBySubject.map(g => ({
                                  score: g.score,
                                  title: g.title
                                })));
                              } else {
                                console.warn(`   ❌ NO se encontraron calificaciones después del filtro`);
                              }
                            }
                            
                            if (subjectFilter === 'all' && listAll.length > 0 && listBySubject.length === 0) {
                              // Fallback REFINADO: solo aplicar si el estudiante tiene notas de UNA sola asignatura
                              // y además esa asignatura coincide con la tarjeta actual (coincidencia flexible)
                              const uniqCanon = new Set(listAll.map(g => canonicalSubject(nameOf(g))));
                              if (uniqCanon.size === 1) {
                                const onlyCanon = Array.from(uniqCanon)[0];
                                const sampleName = nameOf(listAll[0]);
                                const matchesCard = subjectLooseMatch(sampleName, subjName) || canonicalSubject(subjName) === onlyCanon;
                                if (matchesCard) {
                                  console.warn(`⚠️ [SubjectFallback:single] '${subjName}' → usando todas las calificaciones (${listAll.length}) para ${stu.displayName || stu.name}`);
                                  listBySubject = listAll.slice(0, 10);
                                } else {
                                  // No mostrar nada en tarjetas que no correspondan
                                  console.debug(`[DBG SubjectFallback:skip] tarjeta='${subjName}' no coincide con única asignatura '${sampleName}'`);
                                }
                              } else {
                                // Hay varias asignaturas distintas: no hacemos fallback para evitar contaminar tarjetas
                                console.debug(`[DBG SubjectFallback:multiple] ${uniqCanon.size} asignaturas distintas → sin fallback`);
                              }
                            }
                            // ============================================
                            // 🎯 PASO 3: ALINEAR CALIFICACIONES CON ACTIVIDADES
                            // ============================================
                            // Ordenar calificaciones por fecha (gradedAt) antes de alinear
                            listBySubject.sort((a, b) => {
                              const tsA = typeof a.gradedAt === 'number' ? a.gradedAt : normalizeGradedAt(a.gradedAt);
                              const tsB = typeof b.gradedAt === 'number' ? b.gradedAt : normalizeGradedAt(b.gradedAt);
                              return tsA - tsB;
                            });
                            
                            const tasksOrder = courseActivities;
                            const sectionIdForRow = String(assign?.sectionId || '');
                            
                            // � DEBUG: Ver qué actividades están en tasksOrder
                            if (stu.displayName?.includes('Martina') && subjName?.includes('Lenguaje')) {
                              console.log(`\n🔍 [DEBUG Martina] Asignatura: ${subjName}, Sección: ${sectionIdForRow}`);
                              console.log(`   tasksOrder length: ${tasksOrder.length}`);
                              console.log(`   tasksOrder:`, tasksOrder.slice(0, 5).map((t: any) => ({
                                id: t?.id,
                                title: t?.title,
                                createdAt: t?.createdAt,
                                timestamp: t?.timestamp,
                                date: t?.createdAt ? new Date(t.createdAt).toLocaleDateString('es-CL') : 'N/A'
                              })));
                              console.log(`   Calificaciones de Martina (${listBySubject.length}):`, listBySubject.map(g => ({
                                testId: g.testId,
                                score: g.score,
                                gradedAt: g.gradedAt,
                                date: new Date(g.gradedAt).toLocaleDateString('es-CL')
                              })));
                            }
                            
                            // �🔧 FIX: Siempre mostrar calificaciones disponibles, con o sin tareas
                            const list = (() => {
                              // Si NO hay tareas O hay pocas calificaciones para alinear, usar modo simple
                              if (tasksOrder.length === 0 || listBySubject.length === 0) {
                                // Fallback: orden por fecha de nota (FUNCIONA SIEMPRE)
                                return listBySubject.slice(0, 10);
                              }
                              
                              // Modo avanzado: alinear con tareas si es posible
                              const arr: (TestGrade | undefined)[] = Array.from({ length: 10 }, () => undefined);
                              // Mapear por testId para lookup rápido
                              const byTestId = new Map<string, TestGrade[]>();
                              listBySubject.forEach(g => {
                                const k = String(g.testId);
                                if (!byTestId.has(k)) byTestId.set(k, []);
                                byTestId.get(k)!.push(g);
                              });
                              
                              let matchedCount = 0;
                              for (let i = 0; i < Math.min(10, tasksOrder.length); i++) {
                                const t: any = tasksOrder[i];
                                // 🔧 BUSCAR por testId derivado del timestamp de la actividad
                                // El testId en grades tiene formato: "asignatura_tipo_timestamp"
                                // El activity.id también tiene formato: "asignatura-tipo-timestamp"
                                const activityTimestamp = t?.timestamp || 0;
                                
                                // Buscar calificación que coincida con este timestamp
                                let tg: TestGrade | undefined = undefined;
                                for (const [testId, grades] of byTestId.entries()) {
                                  // Extraer timestamp del testId: formato "lenguaje_y_comunicacin_tarea_1710288000000"
                                  const match = testId.match(/(\d{10,})$/);
                                  if (match && grades.length > 0) {
                                    const gradeTs = Number(match[1]);
                                    const gradeTimestamp = gradeTs < 10000000000 ? gradeTs * 1000 : gradeTs;
                                    // Comparar timestamps (con tolerancia de 1 día = 86400000 ms)
                                    if (Math.abs(gradeTimestamp - activityTimestamp) < 86400000) {
                                      tg = grades.shift();
                                      break;
                                    }
                                  }
                                }
                                
                                // Fallback: buscar por ID directo si no se encontró por timestamp
                                if (!tg && t) {
                                  let listForId = byTestId.get(String(t.id));
                                  if ((!listForId || listForId.length === 0) && t?.originalId) {
                                    listForId = byTestId.get(String(t.originalId));
                                  }
                                  tg = listForId && listForId.length > 0 ? listForId.shift() : undefined;
                                }
                                
                                // Fallback: generar TestGrade sintético desde evaluationResults si no existe
                                if (!tg && t && t.taskType === 'evaluacion' && t.evaluationResults) {
                                  const studentKey = stu.username || String(stu.id);
                                  const result = t.evaluationResults[studentKey];
                                  if (result && result.score !== undefined && result.score !== null) {
                                    const total = Number(result.totalQuestions) || 10;
                                    const rawScore = Number(result.score);
                                    let pct = total > 0 ? (rawScore / total) * 100 : Number(result.completionPercentage) || 0;
                                    if (!isFinite(pct)) pct = 0;
                                    pct = Math.max(0, Math.min(100, pct));
                                    
                                    // Crear TestGrade sintético
                                    tg = {
                                      id: `synthetic-${t.id}-${stu.id}`,
                                      testId: String(t.id),
                                      studentId: String(stu.id),
                                      studentName: stu.displayName || stu.name || stu.username || '',
                                      score: Math.round(pct * 100) / 100,
                                      courseId: String(assign?.courseId || ''),
                                      sectionId: String(assign?.sectionId || ''),
                                      subjectId: String(t.subjectId || ''),
                                      title: String(t.title || ''),
                                      gradedAt: new Date(result.completedAt || t.createdAt || Date.now()).getTime(),
                                    };
                                    console.log(`🟣 Generando TestGrade sintético para evaluación: ${t.title}, estudiante: ${stu.username}, score: ${tg.score}%`);
                                  }
                                }
                                
                                if (tg) {
                                  arr[i] = tg;
                                  matchedCount++;
                                }
                              }
                              
                              // 🔧 FIX CRÍTICO: Si NO se encontraron coincidencias, usar modo fallback
                              if (matchedCount === 0 && listBySubject.length > 0) {
                                console.warn(`⚠️ [Calificaciones] No hubo coincidencias de testId para ${stu.displayName || stu.name}. Usando fallback.`);
                                console.log(`   Calificaciones disponibles: ${listBySubject.length}`);
                                console.log(`   Tareas: ${tasksOrder.length}`);
                                console.log(`   testIds de calificaciones:`, listBySubject.slice(0, 3).map(g => g.testId));
                                console.log(`   ids de tareas:`, tasksOrder.slice(0, 3).map((t: any) => t.id));
                                // Usar directamente las calificaciones sin alinear
                                return listBySubject.slice(0, 10);
                              }
                              
                              // Si sobran notas huérfanas (sin tarea encontrada), colocarlas al final
                              const used = new Set(arr.filter(Boolean).map(g => String((g as TestGrade).testId)));
                              const leftovers = listBySubject.filter(g => !used.has(String(g.testId)));
                              
                              // Llenar espacios vacíos con calificaciones disponibles
                              for (let i = 0; i < arr.length && leftovers.length > 0; i++) {
                                if (!arr[i]) arr[i] = leftovers.shift();
                              }
                              
                              // Log de diagnóstico
                              const filled = arr.filter(Boolean).length;
                              if (filled > 0) {
                                console.log(`✅ [Calificaciones] ${stu.displayName || stu.name}: ${filled}/10 columnas con datos (${matchedCount} alineadas, ${filled - matchedCount} fallback)`);
                              }
                              
                              return arr as TestGrade[];
                            })();
                            // ⚠️ NO COMPRIMIR: Mantener indices originales del array (undefined en posiciones sin nota)
                            const listDefined = list as TestGrade[];
                            // Calcular promedio solo con valores definidos
                            const definedGrades = listDefined.filter(g => g && g.score != null) as TestGrade[];
                            const rowAvg = definedGrades.length ? Math.round((definedGrades.reduce((acc, g) => acc + (Number(g.score) || 0), 0) / definedGrades.length) * 10) / 10 : null;
                            if (rowAvg !== null) runtimeRowAverages.push(rowAvg);
                            const subjectName = subjName || (subjectFilter !== 'all' ? subjectFilter : '');
                            const courseSectionLabel = `${course?.name || ''} ${section?.name || ''}`.trim() || '—';
                            
                            // 🔍 DEBUG: Mostrar primer estudiante con calificaciones
                            if (stu === studentsInView?.[0] && subjName === 'Ciencias Naturales') {
                              console.log(`🔍 [DEBUG NOTAS] Estudiante: ${stu.displayName}, Asignatura: ${subjName}`);
                              console.log(`   Total notas en listBySubject: ${listBySubject.length}`);
                              console.log(`   Notas en array (con undefined): ${listDefined.length}`);
                              console.log(`   Notas definidas: ${definedGrades.length}`);
                              console.log(`   Array completo [N1-N10]:`, listDefined.map((g, i) => g ? `N${i+1}:${g.score}` : `N${i+1}:—`).join(', '));
                              if (listBySubject.length > 0) {
                                console.log(`   Detalles primeras 3 notas:`, listBySubject.slice(0, 3).map((g: any) => ({
                                  testId: g.testId,
                                  score: g.score,
                                  title: g.title,
                                  courseId: g.courseId,
                                  sectionId: g.sectionId,
                                  type: g.taskType || 'unknown'
                                })));
                              }
                              if (tasksOrder.length > 0) {
                                console.log(`   Tareas para alineación:`, tasksOrder.slice(0, 3).map((t: any) => ({ id: t.id, title: t.title })));
                              }
                            }
                            // Insertar ítems
                            if (courseSectionLabel !== prevGroup) {
                              pushGroup(courseSectionLabel, section?.id, courseActivities);
                              prevGroup = courseSectionLabel;
                            }
                            pushRow({ label: courseSectionLabel, stu, subjectName, list: listDefined, rowAvg, sectionId: section?.id });
                          });
                          const SHOULD_VIRTUALIZE = Array.isArray(studentsInView) && studentsInView.length > 150 && !!FixedSizeList;
                          if (!SHOULD_VIRTUALIZE) {
                            // Render clásico con TRs
                            return items.map((it) => {
                              if (it.kind === 'group') {
                                const sectionId = it.sectionId ? String(it.sectionId) : undefined;
                                return (
                                  <tr key={it.key} className="border-t">
                                    <td className={`py-${studentFilter !== 'all' ? '2.5' : '1'} px-2 ${studentFilter !== 'all' ? 'text-base' : 'text-xs'} font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200`} colSpan={3}>
                                      {it.courseSectionLabel}
                                    </td>
                                    {Array.from({ length: 10 }).map((_, i) => {
                                      const activity = it.activities?.[i];
                                      const bubble = activity ? (activity.taskType === 'evaluacion'
                                        ? { bg: 'bg-purple-600', text: 'text-white', title: 'Evaluación', emoji: '📊' }
                                        : activity.taskType === 'prueba'
                                          ? { bg: 'bg-indigo-600', text: 'text-white', title: 'Prueba', emoji: '🧪' }
                                          : { bg: 'bg-orange-600', text: 'text-white', title: 'Tarea', emoji: '📝' }) : null;
                                      
                                      const formatDate = (ts: number) => {
                                        const d = new Date(ts);
                                        const dd = String(d.getDate()).padStart(2, '0');
                                        const mm = String(d.getMonth() + 1).padStart(2, '0');
                                        const yyyy = d.getFullYear();
                                        return `${dd}-${mm}-${yyyy}`;
                                      };
                                      
                                      return (
                                        <td key={`grp-n-${i}`} className={`py-${studentFilter !== 'all' ? '2' : '1'} ${studentFilter !== 'all' ? 'px-3' : 'px-2'} text-center ${studentFilter !== 'all' ? 'text-sm' : 'text-xs'} bg-indigo-50 dark:bg-indigo-900/30`}>
                                          <div className="relative inline-block group">
                                            {activity ? (
                                              <span className={`inline-flex items-center justify-center rounded-full ${studentFilter !== 'all' ? 'px-2 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[11px]'} font-semibold ${bubble?.bg} ${bubble?.text}`}>
                                                {bubble?.emoji}
                                              </span>
                                            ) : (
                                              <span className={`text-indigo-700 dark:text-indigo-200 ${studentFilter !== 'all' ? 'text-[12px]' : 'text-[11px]'}`}>{`N${i + 1}`}</span>
                                            )}
                                            {activity && (
                                              <div className="absolute left-1/2 top-full transform -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-[9999] pointer-events-none">
                                                <div className={`${studentFilter !== 'all' ? 'text-[11px] px-3 py-2 max-w-[300px]' : 'text-[10px] px-2.5 py-1.5 max-w-[260px]'} bg-white dark:bg-gray-900 text-gray-900 dark:text-white rounded-lg shadow-2xl border-2 border-gray-300 dark:border-gray-600 min-w-[220px]`}>
                                                  <div className="text-gray-700 dark:text-gray-200 space-y-1">
                                                    <div className="flex items-start gap-2 pb-1 border-b-2 border-gray-300 dark:border-gray-700">
                                                      <span className="text-sm">{bubble?.emoji}</span>
                                                      <span className={`font-bold ${studentFilter !== 'all' ? 'text-[12px]' : 'text-[11px]'}`}>{bubble?.title}</span>
                                                    </div>
                                                    <div className="flex items-start gap-1.5">
                                                      <span className={`text-gray-600 dark:text-gray-400 font-semibold min-w-[50px] ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'}`}>Tema:</span>
                                                      <span className={`flex-1 text-gray-800 dark:text-gray-100 ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'} leading-tight break-words whitespace-normal`}>{fixMojibake(activity.topic) || fixMojibake(activity.title) || 'Sin tema'}</span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5">
                                                      <span className={`text-gray-600 dark:text-gray-400 font-semibold min-w-[50px] ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'}`}>Fecha:</span>
                                                      <span className={`text-gray-800 dark:text-gray-100 font-medium ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'}`}>{formatDate(activity.timestamp)}</span>
                                                    </div>
                                                  </div>
                                                </div>
                                                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2">
                                                  <div className="w-0 h-0 border-l-[8px] border-r-[8px] border-b-[8px] border-transparent border-b-white dark:border-b-gray-900"></div>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        </td>
                                      );
                                    })}
                                    {/* Celda vacía para Promedio */}
                                    <td className={`py-1 ${studentFilter !== 'all' ? 'px-3' : 'px-2'} bg-indigo-50 dark:bg-indigo-900/30`}></td>
                                  </tr>
                                );
                              }
                              // row
                              const r = it;
                              return (
                                <tr key={r.key} className="border-b">
                                  <td className={`py-${studentFilter !== 'all' ? '2' : '2'} px-2 text-sm`} title={r.courseSectionLabel}></td>
                                  <td className={`py-${studentFilter !== 'all' ? '2' : '2'} px-2 pr-6 whitespace-nowrap text-sm`}>{r.student.displayName || r.student.name || r.student.username || '—'}</td>
                                  <td className={`py-${studentFilter !== 'all' ? '2' : '2'} px-2 pl-6 ${String(r.subjectName || '').toLowerCase().includes('historia') ? 'whitespace-nowrap' : 'whitespace-normal break-words leading-snug'} text-sm`} title={r.subjectName || '—'}>{r.subjectName || '—'}</td>
                                  {Array.from({ length: 10 }).map((_, idx) => {
                                    const g = r.gradesList[idx];
                                    return (
                                      <td key={idx} className={`py-${studentFilter !== 'all' ? '2.5' : '1'} ${studentFilter !== 'all' ? 'px-3' : 'px-2'} text-center ${studentFilter !== 'all' ? 'text-base' : 'text-xs'} ${studentFilter !== 'all' ? 'min-w-[4.5rem]' : ''}`}>
                                        {g ? <span className={`${scoreBadgeClass(g.score)} ${studentFilter !== 'all' ? 'px-1.5 py-0.5 text-xs min-w-[2rem]' : ''}`}>{g.score}</span> : <span className={`text-muted-foreground ${studentFilter !== 'all' ? 'text-base' : 'text-xs'}`}>—</span>}
                                      </td>
                                    );
                                  })}
                                  <td className={`py-${studentFilter !== 'all' ? '2' : '2'} ${studentFilter !== 'all' ? 'px-3' : 'px-2'} text-center font-semibold whitespace-nowrap text-sm ${studentFilter !== 'all' ? 'min-w-[4.5rem]' : ''}`}>
                                    {r.rowAvg === null ? '—' : <span className={`${scoreBadgeClass(r.rowAvg)} ${studentFilter !== 'all' ? 'px-1.5 py-0.5 text-xs min-w-[2rem]' : ''}`}>{r.rowAvg}</span>}
                                  </td>
                                </tr>
                              );
                            });
                          }
                          // Virtualizado: una sola fila con un contenedor y lista fija
                          const rowHeight = studentFilter !== 'all' ? 66 : 44; // px (aún mayor en vista estudiante único)
                          const height = Math.min(560, Math.max(200, items.length * rowHeight));
                          const gridTemplate = studentFilter === 'all'
                            ? `18% 14% 20% ${Array.from({ length: 10 }).map(() => '3.8%').join(' ')} 10%`
                            : `22% 18% 24% ${Array.from({ length: 10 }).map(() => '3.2%').join(' ')} 11%`;
                          return (
                            <tr>
                              <td colSpan={14} className="p-0">
                                <div style={{ height, overflow: 'auto' }}>
                                  {FixedSizeList && (
                                    <FixedSizeList
                                      height={height}
                                      itemCount={items.length}
                                      itemSize={rowHeight}
                                      width={'100%'}
                                      className="virtual-rows"
                                    >
                                      {({ index, style }: any) => {
                                        const it = items[index];
                                        if (it.kind === 'group') {
                                          const sectionId = it.sectionId ? String(it.sectionId) : undefined;
                                          return (
                                            <div style={style} className="border-t" role="row">
                                              <div className={`px-2 ${studentFilter !== 'all' ? 'py-2 text-base' : 'py-1 text-xs'} font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200`} style={{ display: 'grid', gridTemplateColumns: gridTemplate, alignItems: 'center' }}>
                                                <div style={{ gridColumn: '1 / span 3' }} className={studentFilter !== 'all' ? 'text-base' : 'text-xs'}>{it.courseSectionLabel}</div>
                                                {Array.from({ length: 10 }).map((_, i) => {
                                                  const role = String(user?.role || '').toLowerCase();
                                                  const hasSectionContext = Boolean(sectionId);
                                                  const levelSelected = levelFilter !== 'all';
                                                  const showBubbles = (role === 'admin' || role === 'teacher') ? (levelSelected && hasSectionContext) : hasSectionContext;
                                                  const pendingTask = showBubbles ? getPendingTaskForColumn(i, subjName || '', sectionId) : null;
                                                  const bubble = pendingTask?.taskType === 'evaluacion'
                                                    ? { bg: 'bg-purple-600', text: 'text-white', title: 'Evaluación', emoji: '📊' }
                                                    : pendingTask?.taskType === 'prueba'
                                                      ? { bg: 'bg-indigo-600', text: 'text-white', title: 'Prueba', emoji: '🧪' }
                                                      : { bg: 'bg-orange-600', text: 'text-white', title: 'Tarea', emoji: '📝' };
                                                  const sanitizedTopic = pendingTask ? (fixMojibake(pendingTask.topic) || fixMojibake(pendingTask.title) || 'Sin tema') : '';
                                                  return (
                                                    <div key={`grp-n-v-${i}`} className="text-center relative group">
                                                      {pendingTask ? (
                                                        <span className={`inline-flex items-center justify-center rounded-full ${studentFilter !== 'all' ? 'px-2 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[11px]'} font-semibold ${bubble.bg} ${bubble.text}`}>
                                                          {bubble.emoji}
                                                        </span>
                                                      ) : (
                                                        <span className={`text-indigo-700 dark:text-indigo-200 ${studentFilter !== 'all' ? 'text-[12px]' : ''}`}>{`N${i + 1}`}</span>
                                                      )}
                                                      {pendingTask && (
                                                        <div className="absolute left-1/2 top-full transform -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-[9999] pointer-events-none">
                                                          <div className={`${studentFilter !== 'all' ? 'text-[11px] px-3 py-2 max-w-[300px]' : 'text-[10px] px-2.5 py-1.5 max-w-[260px]'} bg-white dark:bg-gray-900 text-gray-900 dark:text-white rounded-lg shadow-2xl border-2 border-gray-300 dark:border-gray-600 min-w-[220px]`}>
                                                            <div className="text-gray-700 dark:text-gray-200 space-y-1">
                                                              <div className="flex items-start gap-2 pb-1 border-b-2 border-gray-300 dark:border-gray-700">
                                                                <span className="text-sm">{bubble.emoji}</span>
                                                                <span className={`font-bold ${studentFilter !== 'all' ? 'text-[12px]' : 'text-[11px]'}`}>{bubble.title}</span>
                                                              </div>
                                                              <div className="flex items-start gap-1.5">
                                                                <span className={`text-gray-600 dark:text-gray-400 font-semibold min-w-[50px] ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'}`}>Tema:</span>
                                                                <span className={`flex-1 text-gray-800 dark:text-gray-100 ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'} leading-tight break-words whitespace-normal`}>{sanitizedTopic}</span>
                                                              </div>
                                                              <div className="flex items-center gap-1.5">
                                                                <span className={`text-gray-600 dark:text-gray-400 font-semibold min-w-[50px] ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'}`}>Fecha:</span>
                                                                {(() => {
                                                                  const anyTask: any = pendingTask;
                                                                  const ts = anyTask?.openAt || anyTask?.startAt || anyTask?.createdAt || anyTask?.dueDate || null;
                                                                  return <span className={`text-gray-800 dark:text-gray-100 font-medium ${studentFilter !== 'all' ? 'text-[11px]' : 'text-[10px]'}`}>{ts ? new Date(ts).toLocaleDateString('es-CL') : '—'}</span>;
                                                                })()}
                                                              </div>
                                                            </div>
                                                          </div>
                                                          <div className="absolute bottom-full left-1/2 transform -translate-x-1/2">
                                                            <div className="w-0 h-0 border-l-[8px] border-r-[8px] border-b-[8px] border-transparent border-b-white dark:border-b-gray-900"></div>
                                                          </div>
                                                        </div>
                                                      )}
                                                    </div>
                                                  );
                                                })}
                                                {/* Columna de Promedio vacía */}
                                                <div></div>
                                              </div>
                                            </div>
                                          );
                                        }
                                        const r = it;
                                        return (
                                          <div style={style} className="border-b" role="row">
                                            <div className={`px-2 py-2 text-sm`} style={{ display: 'grid', gridTemplateColumns: gridTemplate, alignItems: 'center' }}>
                                              <div title={r.courseSectionLabel} className="text-sm"></div>
                                              <div className="whitespace-nowrap text-sm pr-6">{r.student.displayName || r.student.name || r.student.username || '—'}</div>
                                              <div className={`${String(r.subjectName || '').toLowerCase().includes('historia') ? 'whitespace-nowrap' : 'whitespace-normal break-words leading-snug'} text-sm pl-6`} title={r.subjectName || '—'}>{r.subjectName || '—'}</div>
                                              {Array.from({ length: 10 }).map((_, idx) => {
                                                const g = r.gradesList[idx];
                                                return (
                                                  <div key={`cell-${idx}`} className={`text-center ${studentFilter !== 'all' ? 'px-2' : 'px-1'}`}>
                                                    {g ? <span className={`${scoreBadgeClass(g.score)} ${studentFilter !== 'all' ? 'px-1.5 py-0.5 text-xs min-w-[2rem]' : ''}`}>{g.score}</span> : <span className={`text-muted-foreground ${studentFilter !== 'all' ? 'text-base' : 'text-xs'}`}>—</span>}
                                                  </div>
                                                );
                                              })}
                                              <div className={`text-center font-semibold whitespace-nowrap ${studentFilter !== 'all' ? 'px-2' : ''}`}>
                                                {r.rowAvg === null ? '—' : <span className={`${scoreBadgeClass(r.rowAvg)} ${studentFilter !== 'all' ? 'px-1.5 py-0.5 text-xs min-w-[2rem]' : ''}`}>{r.rowAvg}</span>}
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      }}
                                    </FixedSizeList>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })()}
                        {/* Fila de Promedio General por tabla eliminada: se muestra un resumen único al final */}
                      </tbody>
                    </table>
                    {/* Si hay demasiados estudiantes visibles y la librería está disponible, aplicamos virtualización a todo el tbody en futuros refactors.
                        Por ahora dejamos el wiring preparado para consolidarlo en un patch específico (para no romper estilos del grupo). */}
                  </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            );
          })()
          );
        })()}
        </div>

  {(() => { avg = computeGeneralAverage(); return null; })()}
  {/* Resumen final: Promedio General según filtros activos (mostrar solo si filtros completos) */}
        {(() => {
          const hasLevel = levelFilter !== 'all';
          const hasComboSection = Boolean(comboSectionId && comboSectionId !== 'all');
          const hasCascadeSection = Boolean(cascadeCourseId && cascadeSectionId);
          const hasSectionContext = hasComboSection || hasCascadeSection;
          const hasSemester = semester !== 'all';
          // Mostrar siempre para apoderados cuando han seleccionado un estudiante
          const show = (user?.role === 'guardian' && selectedGuardianStudent) || (hasSemester && hasSectionContext && (hasLevel || hasComboSection) && studentsInView.length > 0);
          if (!show) return null;
          return (
          <Card className="mt-2">
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-sm border-collapse">
                  <colgroup>
                    <col style={{ width: '90%' }} />
                    <col style={{ width: '10%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="py-2 px-2 text-left whitespace-nowrap text-sm">{tr('summary', 'Resumen')}</th>
                      <th className="py-2 px-2 text-center whitespace-nowrap text-sm">{tr('average', 'Promedio')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t">
                      <td className="py-2 px-2 whitespace-nowrap text-sm">{tr('semesterAverage', 'Promedio Semestre')}</td>
                      <td className="py-2 px-2 text-center font-semibold whitespace-nowrap">
                        {avg === null ? '—' : <span className={scoreBadgeClass(avg)}>{avg}</span>}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          );
        })()}

        {/* Tarjeta flotante con Promedio General */}
        {(() => {
          // 🎯 CONDICIÓN: Solo mostrar cuando hay filtros suficientes seleccionados
          // Reglas para Admin/Teacher: Debe tener Semestre + Nivel + Curso (mínimo)
          // Reglas para Student/Guardian: Siempre mostrar si hay calificaciones
          // Combinaciones válidas para Admin/Teacher:
          //   - Semestre + Nivel + Curso
          //   - Semestre + Nivel + Curso + Sección
          //   - Semestre + Nivel + Curso + Sección + Asignatura
          //   - Semestre + Nivel + Curso + Sección + Asignatura + Estudiante
          //   - Semestre + Nivel + Curso + Sección + Estudiante
          const hasSemesterFilter = semester !== 'all';
          const hasLevelFilter = levelFilter !== 'all';
          const hasCourseFilter = Boolean(cascadeCourseId) || (comboSectionId !== 'all');
          
          // Para estudiantes y apoderados: siempre permitir mostrar las tarjetas
          const isStudentOrGuardian = user?.role === 'student' || user?.role === 'guardian';
          
          // Si es Admin/Teacher y no cumple los filtros mínimos, no mostrar la tarjeta
          if (!isStudentOrGuardian && (!hasSemesterFilter || !hasLevelFilter || !hasCourseFilter)) {
            return null;
          }

          // Calcular promedio general replicando la lógica de Monito
          // (match flexible por rut/id/username/nombre/email y por año si existe)
          let displayedGrades: TestGrade[] = [];
          const normalize = (s?: string) => String(s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[^a-z0-9\s]/g, '')
            .trim();

          if (user?.role === 'student') {
            const userFirstName = normalize((user?.displayName || '').split(' ')[0]);
            const yearStr = String(selectedYear || '');

            displayedGrades = (grades as any[]).filter((g: any) => {
              const sid = String(g.studentId ?? '');
              const sname = String(g.studentName || g.student || '');
              const semail = String(g.studentEmail || g.email || '');
              // Si el registro posee año, exigir que coincida con el seleccionado
              if (g.year && String(g.year) !== yearStr) return false;

              const matchByRut = user?.rut && sid === String(user.rut);
              const matchById = sid === String(user?.id) || sid === String(user?.username);
              const matchByName = sname === user?.displayName;
              const matchByPartialName = user?.displayName && sname
                ? normalize(sname).includes(normalize(user.displayName))
                : false;
              const matchByFirstName = userFirstName && sname
                ? normalize(sname).startsWith(userFirstName)
                : false;
              const matchByEmail = user?.email && semail
                ? normalize(semail) === normalize(user.email)
                : false;

              return matchByRut || matchById || matchByName || matchByPartialName || matchByFirstName || matchByEmail;
            });
          } else if (user?.role === 'guardian' && selectedGuardianStudent) {
            // Para apoderados: mostrar las calificaciones del estudiante seleccionado
            const selectedStudent = guardianStudents.find(s => String(s.id) === String(selectedGuardianStudent));
            const studentIds = selectedStudent ? [selectedStudent.id, selectedStudent.rut, selectedStudent.username].filter(Boolean) : [selectedGuardianStudent];

            displayedGrades = (grades as any[]).filter((g: any) => {
              const sid = String(g.studentId || '');
              const suser = String(g.studentUsername || '');
              const sname = String(g.studentName || g.student || '').toLowerCase();
              const matchId = studentIds.includes(sid);
              const matchUsername = selectedStudent?.username && suser === selectedStudent.username;
              const matchName = selectedStudent?.displayName && sname.includes((selectedStudent.displayName || '').toLowerCase());
              return matchId || matchUsername || matchName;
            });
          } else if (user?.role === 'teacher' || user?.role === 'admin') {
            // Para admin/teacher: promedio de estudiantes visibles con filtros actuales
            const visibleStudentIds = new Set(studentsInView.map(s => String(s.id)));
            displayedGrades = filteredGrades.filter(g => visibleStudentIds.has(String(g.studentId)));
          }
          
          const currentAverage = displayedGrades.length > 0
            ? Math.round((displayedGrades.reduce((sum, g) => sum + (Number(g.score) || 0), 0) / displayedGrades.length) * 10) / 10
            : null;
          
          // 🆕 Calcular promedios por asignatura para profesor/admin
          // Reglas:
          //  - Solo mostrar asignaturas asignadas al profesor (según teacherAssignments)
          //  - Calcular promedio anual (1er + 2do semestre) para el contexto actual (alumnos visibles)
          //  - Fuente: usar "grades" del año seleccionado, filtrado por alumnos visibles
          const averagesBySubject = new Map<string, { avg: number; count: number }>();
          if (user?.role === 'teacher' || user?.role === 'admin') {
            // Seleccionar calificaciones del AÑO para los estudiantes visibles (match flexible id/username/rut/nombre)
            const visibleIds = new Set(studentsInView.map((s: any) => String(s.id)));
            const visibleUsernames = new Set(studentsInView.map((s: any) => String(s.username)));
            const visibleRuts = new Set(studentsInView.map((s: any) => String(s.rut || '')));
            const visibleNames = new Set(studentsInView.map((s: any) => String(s.displayName || s.name || '').toLowerCase()));
            const norm = (x?: string) => String(x || '').toLowerCase();
            const source = (grades as any[]).filter((g: any) => {
              const sid = String(g.studentId || '');
              const suser = String(g.studentUsername || '');
              const sname = norm(String(g.studentName || ''));
              return (
                visibleIds.has(sid) ||
                visibleUsernames.has(sid) ||
                (suser && (visibleUsernames.has(suser) || visibleIds.has(suser))) ||
                (sid && visibleRuts.has(sid)) ||
                (sname && Array.from(visibleNames).some(n => n && sname.includes(n)))
              );
            });

            // Materias asignadas al profesor (canónicas)
            const teacherAssignedCanon = new Set<string>();
            if (user?.role === 'teacher') {
              try {
                const mine = teacherAssignments.filter(a => String(a.teacherId) === String((user as any).id) || String(a.teacherUsername) === String(user.username));
                mine.forEach(a => {
                  const list: string[] = Array.isArray(a.subjects) ? a.subjects : (a.subjectName ? [a.subjectName] : []);
                  list.forEach(n => { const c = canonicalSubject(String(n)); if (c) teacherAssignedCanon.add(c); });
                });
              } catch {}
            }

            source.forEach((g: any) => {
              const subjectName = (() => {
                // Intentar obtener el nombre de varias fuentes posibles
                // 1. Buscar por subjectId en el listado de subjects
                const found = subjects.find(su => String(su.id) === String(g.subjectId));
                if (found?.name) return found.name;
                // 2. Si el registro tiene subjectName directamente (común en cargas CSV)
                if (g.subjectName) return String(g.subjectName);
                // 3. Si el registro tiene subject directamente (otro formato de CSV)
                if (g.subject) return String(g.subject);
                // 4. Si subjectId parece ser un nombre (no un ID numérico)
                if (g.subjectId && isNaN(Number(g.subjectId))) {
                  return String(g.subjectId).replace(/_/g, ' ');
                }
                return 'General';
              })();
              const canonName = canonicalSubject(subjectName);
              // Solo materias asignadas (en modo teacher). Admin ve todas.
              if (user?.role === 'teacher' && teacherAssignedCanon.size > 0 && !teacherAssignedCanon.has(canonName)) return;

              if (!averagesBySubject.has(canonName)) {
                averagesBySubject.set(canonName, { avg: 0, count: 0 });
              }
              const entry = averagesBySubject.get(canonName)!;
              entry.avg += Number(g.score) || 0;
              entry.count += 1;
            });

            // Calcular promedios finales
            averagesBySubject.forEach((entry) => {
              entry.avg = entry.count > 0 ? Math.round((entry.avg / entry.count) * 10) / 10 : 0;
            });
          }
          
          // Mensaje motivacional basado en el promedio
          const getMotivationalMessage = (avg: number | null) => {
            if (avg === null) return tr('avgNoGradesShort','Sin calificaciones');
            if (avg >= 90) return tr('avgMsgExcellent','¡Excelente! 🌟');
            if (avg >= 80) return tr('avgMsgVeryGood','¡Muy bien! 💪');
            if (avg >= 70) return tr('avgMsgGood','¡Buen trabajo! 📚');
            if (avg >= 60) return tr('avgMsgPass','Puede mejorar 💡');
            return tr('avgMsgKeepGoing','Sigue esforzándote 🚀');
          };
          
          return (
            <div className="fixed top-20 right-6 z-50 flex flex-col gap-4">
              <Card className="w-[12rem] shadow-lg border-2 border-indigo-300 dark:border-indigo-600 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm">
                <CardContent className="p-2.5">
                  <div className="flex flex-col items-center gap-2">
                    <h3 className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                      {tr('generalAverage','Promedio General')}
                    </h3>
                    
                    {currentAverage !== null ? (
                      <>
                        {/* Burbuja con el promedio */}
                        <div className="relative">
                          <div className={`w-12 h-12 rounded-full flex items-center justify-center shadow-lg ${
                            currentAverage >= 60 
                              ? 'bg-gradient-to-br from-emerald-500 to-green-600' 
                              : 'bg-gradient-to-br from-red-500 to-orange-600'
                          }`}>
                            <span className="text-lg font-bold text-white">
                              {currentAverage}
                            </span>
                          </div>
                        </div>
                        
                        {/* Mensaje motivacional */}
                        <div className="text-[10px] text-center font-medium text-indigo-600 dark:text-indigo-300 px-1.5 leading-tight">
                          {getMotivationalMessage(currentAverage)}
                        </div>
                        
                        {/* Información adicional */}
                        <div className="text-[9px] text-gray-600 dark:text-gray-400 text-center leading-tight space-y-0.5">
                          <div className="font-semibold">{displayedGrades.length} {tr('grades','calificaciones').toLowerCase()}</div>
                          {(user?.role === 'admin' || user?.role === 'teacher') && (
                            <div>{studentsInView.length} {tr('students','estudiantes').toLowerCase()}</div>
                          )}
                          {semester !== 'all' && (
                            <div className="text-indigo-500 dark:text-indigo-400">
                              {semester === '1' ? tr('firstSemester','1er Sem') : tr('secondSemester','2do Sem')}
                            </div>
                          )}
                        </div>
                        
                      </>
                    ) : null}

                    {/* 🆕 Promedios por asignatura (si existen) */}
                    {(user?.role === 'teacher' || user?.role === 'admin') && averagesBySubject.size > 0 && (
                      <div className="w-full border-t border-indigo-200 dark:border-indigo-700 pt-2 mt-1">
                        <div className="text-[9px] font-semibold text-indigo-700 dark:text-indigo-300 mb-1.5 text-center">
                          Por Asignatura
                        </div>
                        <div className="flex flex-col gap-1">
                          {Array.from(averagesBySubject.entries())
                            .sort((a, b) => a[0].localeCompare(b[0]))
                            .map(([subjectName, data]) => {
                              // subjectName ya viene canonizado (minúsculas, sin tildes)
                              const canon = subjectName; // ya es canónico
                              const shortName = (() => {
                                // Usar el canon para matchear (minúsculas sin tildes)
                                if (canon.includes('matematic')) return 'Matemáticas';
                                if (canon.includes('lenguaj') || canon.includes('comunic')) return 'Lenguaje';
                                if (canon.includes('historia') || canon.includes('geografia')) return 'Historia';
                                if (canon.includes('ingles')) return 'Inglés';
                                if (canon.includes('musica')) return 'Música';
                                if (canon.includes('arte')) return 'Artes';
                                if (canon.includes('tecnolog')) return 'Tecnología';
                                // Asignaturas de Educación Media
                                if (canon.includes('biolog')) return 'Biología';
                                if (canon.includes('quimic')) return 'Química';
                                if (canon.includes('filosof')) return 'Filosofía';
                                if (canon.includes('educacion ciudadana') || canon.includes('ciudadan')) return 'Ed. Ciudadana';
                                // Distinguir Física de Ed. Física
                                if (canon.includes('educacion fisica') || canon.includes('ed fisica')) return 'Ed. Física';
                                if (canon.includes('fisica')) return 'Física';
                                // Asignaturas de Educación Básica
                                if (canon.includes('ciencia') && canon.includes('natural')) return 'Ciencias Nat.';
                                if (canon.includes('ciencia')) return 'Ciencias';
                                // Fallback: capitalizar primera letra
                                return subjectName.charAt(0).toUpperCase() + subjectName.slice(1);
                              })();
                              const subjectBadgeClass = (() => {
                                // Asignaturas comunes
                                if (canon.includes('matematic')) return 'bg-blue-500';
                                if (canon.includes('lenguaj') || canon.includes('comunic')) return 'bg-red-500';
                                if (canon.includes('historia') || canon.includes('geografia')) return 'bg-amber-600';
                                if (canon.includes('ingles')) return 'bg-indigo-500';
                                if (canon.includes('musica')) return 'bg-purple-600';
                                if (canon.includes('arte')) return 'bg-rose-600';
                                if (canon.includes('tecnolog')) return 'bg-yellow-600';
                                // Asignaturas de Educación Media
                                if (canon.includes('biolog')) return 'bg-green-600';
                                if (canon.includes('quimic')) return 'bg-pink-500';
                                if (canon.includes('filosof')) return 'bg-gray-500';
                                if (canon.includes('educacion ciudadana') || canon.includes('ciudadan')) return 'bg-indigo-600';
                                // Distinguir Física (ciencia) de Educación Física (deporte)
                                if (canon.includes('educacion fisica') || canon.includes('ed fisica')) return 'bg-teal-600';
                                if (canon.includes('fisica')) return 'bg-purple-500'; // Física (ciencia)
                                // Asignaturas de Educación Básica
                                if (canon.includes('ciencia') && canon.includes('natural')) return 'bg-green-500';
                                if (canon.includes('ciencia')) return 'bg-green-600';
                                return 'bg-slate-500';
                              })();
                              const subjectCode = (() => {
                                // Asignaturas comunes
                                if (canon.includes('matematic')) return 'MAT';
                                if (canon.includes('lenguaj') || canon.includes('comunic')) return 'LEN';
                                if (canon.includes('historia')) return 'HIS';
                                if (canon.includes('geografia')) return 'HGC';
                                if (canon.includes('ingles')) return 'ING';
                                if (canon.includes('musica')) return 'MUS';
                                if (canon.includes('arte')) return 'ART';
                                if (canon.includes('tecnolog')) return 'TEC';
                                // Asignaturas de Educación Media
                                if (canon.includes('biolog')) return 'BIO';
                                if (canon.includes('quimic')) return 'QUI';
                                if (canon.includes('filosof')) return 'FIL';
                                if (canon.includes('educacion ciudadana') || canon.includes('ciudadan')) return 'EDC';
                                // Distinguir Física (ciencia) de Educación Física (deporte)
                                if (canon.includes('educacion fisica') || canon.includes('ed fisica')) return 'EFI';
                                if (canon.includes('fisica')) return 'FIS'; // Física (ciencia)
                                // Asignaturas de Educación Básica
                                if (canon.includes('ciencia') && canon.includes('natural')) return 'CNT';
                                if (canon.includes('ciencia')) return 'CIE';
                                return 'ASG';
                              })();

                              return (
                                <div key={subjectName} className="flex items-center justify-between gap-1.5 bg-indigo-50 dark:bg-indigo-900/30 rounded px-1.5 py-1">
                                  <span className="flex items-center gap-1.5 min-w-0 flex-1" title={fixMojibake(subjectName)}>
                                    <span className={`inline-flex items-center justify-center h-4 px-1.5 rounded-full text-[9px] font-bold text-white ${subjectBadgeClass}`}>{subjectCode}</span>
                                  </span>
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${scoreBadgeClass(data.avg)}`}>
                                    {data.avg}
                                  </span>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* 🆕 Tarjeta de Promedio Asistencia (Estudiantes, Apoderados, Admin y Profesores) */}
              {(() => {
                const isStudent = user?.role === 'student';
                const isGuardian = user?.role === 'guardian';
                const isStaff = user?.role === 'admin' || user?.role === 'teacher';
                const hasSectionContext = Boolean(cascadeSectionId || (comboSectionId && comboSectionId !== 'all'));
                const hasSemester = semester !== 'all';

                // Estudiante: mostrar siempre (mientras carga puede aparecer como '—')
                if (isStudent) return true;

                // Apoderado: mostrar si hay estudiante seleccionado (mientras carga puede aparecer como '—')
                if (isGuardian && selectedGuardianStudent) return true;

                // Admin / Profesor: mostrar siempre que haya curso/sección seleccionados (semestre opcional)
                if (isStaff && hasSectionContext) return true;

                return false;
              })() && (
                <Card className="w-[12rem] shadow-lg border-2 border-indigo-300 dark:border-indigo-600 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm">
                  <CardContent className="p-2.5">
                    <div className="flex flex-col items-center gap-2">
                      <h3 className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                        {tr('attendanceAverage', 'Promedio Asistencia')}
                      </h3>
                      <div className="relative">
                        <div className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg ${
                          !studentAttendanceStats 
                            ? 'bg-gray-400 dark:bg-gray-600'
                            : (studentAttendanceStats.avg ?? 0) >= 85 
                              ? 'bg-gradient-to-br from-emerald-500 to-green-600' 
                              : (studentAttendanceStats.avg ?? 0) >= 70
                                ? 'bg-gradient-to-br from-yellow-500 to-orange-600'
                                : 'bg-gradient-to-br from-red-500 to-red-600'
                        }`}>
                          <span className="text-sm font-bold text-white">
                            {studentAttendanceStats ? `${studentAttendanceStats.avg}%` : '—'}
                          </span>
                        </div>
                      </div>
                      
                      {/* Detalle de asistencia */}
                      <div className="flex gap-2 text-[9px] font-medium text-gray-600 dark:text-gray-400">
                        <span title={tr('present', 'Presente')} className="text-green-600 dark:text-green-400">P={studentAttendanceStats?.present ?? 0}</span>
                        <span title={tr('absent', 'Ausente')} className="text-red-600 dark:text-red-400">A={studentAttendanceStats?.absent ?? 0}</span>
                        <span title={tr('late', 'Tarde')} className="text-yellow-600 dark:text-yellow-400">T={studentAttendanceStats?.late ?? 0}</span>
                        <span title={tr('excused', 'Justificado')} className="text-blue-600 dark:text-blue-400">J={studentAttendanceStats?.excused ?? 0}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          );
        })()}

        {/* Monito (versión independiente para Calificaciones) */}
        <div className="fixed bottom-24 right-6 z-50">
          <MonitoCalificaciones />
        </div>
      </div>
    </div>
  );
}
