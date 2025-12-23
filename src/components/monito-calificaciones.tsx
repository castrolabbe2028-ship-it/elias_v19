"use client";

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Brain, TrendingUp, BookOpen, Award, Heart, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { useLanguage } from '@/contexts/language-context';
import { useGradesSQL } from '@/hooks/useGradesSQL';

interface Sugerencia {
  texto: string;
  tipo: 'motivacion' | 'estudio' | 'mejora' | 'plan';
  icono: any;
  plan?: string[];
  prioridades?: string[];
  tips?: string[];
}

// Versión independiente para pestaña Calificaciones
export default function MonitoCalificaciones() {
  const { user } = useAuth();
  const { language } = useLanguage();
  const { getGradesByYear } = useGradesSQL();

  const [sugerenciaActual, setSugerenciaActual] = useState<Sugerencia | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [lastFetchTime, setLastFetchTime] = useState<number>(0);
  const [cachedGrades, setCachedGrades] = useState<any[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [extraTips, setExtraTips] = useState<string[]>([]);
  const [tipIndex, setTipIndex] = useState(0);
  const [bounce, setBounce] = useState(0);
  const [isFetchingAi, setIsFetchingAi] = useState(false);
  const [aiMessages, setAiMessages] = useState<string[]>([]);
  const [clickCount, setClickCount] = useState(0); // # de clics en esta sesión de pestaña
  const [aiMainIndex, setAiMainIndex] = useState(0); // índice para mostrar mensajes IA como principales
  // Cache alterno para modo profesor (todas las calificaciones del año)
  const [cachedAllGrades, setCachedAllGrades] = useState<any[] | null>(null);
  const [lastFetchAllTime, setLastFetchAllTime] = useState<number>(0);
  const [analysisYear, setAnalysisYear] = useState<number | null>(null);
  
  // === ESTADOS PARA APODERADO CON MÚLTIPLES HIJOS ===
  const [guardianStudents, setGuardianStudents] = useState<any[]>([]); // Lista de estudiantes asignados
  const [showStudentSelector, setShowStudentSelector] = useState(false); // Mostrar selector
  const [selectedStudentForAnalysis, setSelectedStudentForAnalysis] = useState<any>(null); // Estudiante seleccionado

  useEffect(() => setMounted(true), []);
  
  // Cerrar al hacer click fuera
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setSugerenciaActual(null);
        setIsLoading(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Animación de rebote sutil
  useEffect(() => {
    const id = setInterval(() => setBounce(b => (b + 1) % 2), 1000);
    return () => clearInterval(id);
  }, []);

  const obtenerCalificacionesUsuario = async (forceRefresh = false) => {
    try {
      const now = Date.now();
      const cacheValid = cachedGrades && !forceRefresh && (now - lastFetchTime < 60000);
      if (cacheValid) return cachedGrades;

      // Usar el mismo año seleccionado por la app (fallback: año actual)
      const selectedYear = Number(localStorage.getItem('admin-selected-year') || new Date().getFullYear());
      const grades = await getGradesByYear(selectedYear);
      console.log(`🐵 [Monito] Cargando ${grades?.length || 0} calificaciones vía useGradesSQL (año ${selectedYear})`);

      if (!grades || grades.length === 0) {
        console.warn('🐵 [Monito] No se encontraron calificaciones en ninguna fuente');
        setCachedGrades([]);
        setLastFetchTime(now);
        return [];
      }

      // Normalizadores robustos
      const normalizar = (t?: string) => (t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/�/g,'').replace(/[^a-z0-9\s]/g,'').trim();
      const normRut = (r?: string) => (r||'').replace(/\./g,'').replace(/-/g,'').toLowerCase().trim();
      const extractFirst = (n?: string) => (n||'').split(' ')[0].toLowerCase();
      
      const userId = String(user?.id || '').toLowerCase().trim();
      const userUsername = String(user?.username || '').toLowerCase().trim();
      const userRut = normRut(user?.rut);
      const userNameNorm = normalizar(user?.displayName);
      const userFirstNorm = normalizar(extractFirst(user?.displayName));
      const userEmailNorm = normalizar(user?.email);

      console.log(`🐵 [Monito] Buscando calificaciones para: id=${userId}, username=${userUsername}, rut=${userRut}, name=${userNameNorm}`);

      const userGrades = grades.filter((g: any) => {
        const gStudentId = String(g.studentId || '').toLowerCase().trim();
        const gStudentUsername = String(g.studentUsername || g.username || '').toLowerCase().trim();
        const gStudentRut = normRut(g.studentRut || g.rut);
        const gStudentName = normalizar(g.studentName || g.student || g.nombre);
        const gStudentEmail = normalizar(g.studentEmail || g.email);

        // Match por ID, username o RUT
        const matchById = userId && (gStudentId === userId || gStudentUsername === userId);
        const matchByUsername = userUsername && (gStudentId === userUsername || gStudentUsername === userUsername);
        const matchByRut = userRut && (gStudentId === userRut || gStudentRut === userRut);
        
        // Match por nombre (parcial)
        const matchByName = userNameNorm && gStudentName && (
          gStudentName.includes(userNameNorm) || 
          userNameNorm.includes(gStudentName) ||
          gStudentName.startsWith(userFirstNorm)
        );
        
        // Match por email
        const matchByEmail = userEmailNorm && gStudentEmail && gStudentEmail === userEmailNorm;

        return matchById || matchByUsername || matchByRut || matchByName || matchByEmail;
      });

      console.log(`🐵 [Monito] Encontradas ${userGrades.length} calificaciones para el usuario`);

      setCachedGrades(userGrades);
      setLastFetchTime(now);
      return userGrades;
    } catch (e) {
      console.error('🐵 [Monito] Error general obteniendo calificaciones:', e);
      return [];
    }
  };

  // === HELPER: Obtener lista de estudiantes asignados al apoderado con sus datos completos ===
  const obtenerEstudiantesApoderado = async (): Promise<any[]> => {
    try {
      const selectedYear = Number(localStorage.getItem('admin-selected-year') || new Date().getFullYear());
      let assignedStudentIds: string[] = [];

      const { LocalStorageManager } = await import('@/lib/education-utils');
      
      // Buscar en guardians del año
      const guardiansForYear = LocalStorageManager.getGuardiansForYear(selectedYear) || [];
      const guardianFromYear = guardiansForYear.find((g: any) => 
        String(g.id) === String(user?.id) || 
        String(g.username || '').toLowerCase() === String(user?.username || '').toLowerCase()
      );
      if (guardianFromYear?.studentIds?.length) {
        assignedStudentIds = guardianFromYear.studentIds.map((id: any) => String(id));
      }

      // Buscar en relaciones guardian-student
      if (assignedStudentIds.length === 0) {
        const relations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear) || [];
        assignedStudentIds = relations
          .filter((rel: any) => 
            String(rel.guardianId) === String(user?.id) || 
            String(rel.guardianUsername || '').toLowerCase() === String(user?.username || '').toLowerCase()
          )
          .map((rel: any) => String(rel.studentId));
      }

      // Buscar en smart-student-users
      if (assignedStudentIds.length === 0) {
        const loadJson = <T,>(key: string, def: T): T => {
          try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
        };
        const usersData = loadJson<any[]>('smart-student-users', []);
        const fullUserData = usersData.find((u: any) => 
          String(u.username || '').toLowerCase() === String(user?.username || '').toLowerCase()
        );
        if (fullUserData?.studentIds?.length) {
          assignedStudentIds = fullUserData.studentIds.map((id: any) => String(id));
        }
      }

      if (assignedStudentIds.length === 0) {
        console.warn('🐵 [Monito] No se encontraron estudiantes asignados al apoderado');
        return [];
      }

      // Obtener datos completos de los estudiantes
      const allStudents = LocalStorageManager.getStudentsForYear(selectedYear) || [];
      const loadJson = <T,>(key: string, def: T): T => {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
      };
      const legacyUsers = loadJson<any[]>('smart-student-users', []).filter((u: any) => u.role === 'student' || u.role === 'estudiante');
      const combinedUsers = [...allStudents, ...legacyUsers];

      const normRut = (r?: string) => (r||'').replace(/\./g,'').replace(/-/g,'').toLowerCase().trim();
      const assignedSet = new Set(assignedStudentIds.map(id => id.toLowerCase().trim()));
      const assignedRutSet = new Set(assignedStudentIds.map(id => normRut(id)));

      const students = combinedUsers.filter((u: any) => {
        if (u.role !== 'student' && u.role !== 'estudiante') return false;
        const uId = String(u.id || '').toLowerCase().trim();
        const uUsername = String(u.username || '').toLowerCase().trim();
        const uRut = normRut(u.rut);
        return assignedSet.has(uId) || assignedSet.has(uUsername) || assignedRutSet.has(uId) || assignedRutSet.has(uRut);
      });

      // Eliminar duplicados por id
      const uniqueStudents = Array.from(new Map(students.map(s => [String(s.id), s])).values());
      
      console.log(`🐵 [Monito] Estudiantes del apoderado:`, uniqueStudents.map(s => s.displayName || s.name || s.username));
      return uniqueStudents;
    } catch (e) {
      console.error('🐵 [Monito] Error obteniendo estudiantes del apoderado:', e);
      return [];
    }
  };

  // === HELPER: Obtener calificaciones de un estudiante específico ===
  const obtenerCalificacionesDeEstudiante = async (student: any): Promise<any[]> => {
    try {
      const selectedYear = Number(localStorage.getItem('admin-selected-year') || new Date().getFullYear());
      const grades = await getGradesByYear(selectedYear);
      
      if (!grades || grades.length === 0) return [];

      const normRut = (r?: string) => (r||'').replace(/\./g,'').replace(/-/g,'').toLowerCase().trim();
      const studentId = String(student.id || '').toLowerCase().trim();
      const studentUsername = String(student.username || '').toLowerCase().trim();
      const studentRut = normRut(student.rut);
      const studentName = String(student.displayName || student.name || '').toLowerCase().trim();

      const studentGrades = grades.filter((g: any) => {
        const gStudentId = String(g.studentId || '').toLowerCase().trim();
        const gStudentUsername = String(g.studentUsername || g.username || '').toLowerCase().trim();
        const gStudentRut = normRut(g.studentRut || g.rut);
        const gStudentName = String(g.studentName || g.student || '').toLowerCase().trim();

        return gStudentId === studentId || 
               gStudentId === studentUsername ||
               gStudentUsername === studentUsername ||
               gStudentRut === studentRut ||
               (studentName && gStudentName.includes(studentName));
      });

      console.log(`🐵 [Monito] Calificaciones de ${student.displayName || student.name}: ${studentGrades.length}`);
      return studentGrades;
    } catch (e) {
      console.error('🐵 [Monito] Error obteniendo calificaciones del estudiante:', e);
      return [];
    }
  };

  // === NUEVO: Obtener calificaciones para APODERADO (hijos asignados) ===
  const obtenerCalificacionesApoderado = async (forceRefresh = false) => {
    try {
      const now = Date.now();
      const cacheValid = cachedGrades && !forceRefresh && (now - lastFetchTime < 60000);
      if (cacheValid) return cachedGrades;

      const selectedYear = Number(localStorage.getItem('admin-selected-year') || new Date().getFullYear());
      let grades: any[] = [];
      let assignedStudentIds: string[] = [];

      // 1) Obtener estudiantes asignados al apoderado
      try {
        const { LocalStorageManager } = await import('@/lib/education-utils');
        
        // Buscar en guardians del año
        const guardiansForYear = LocalStorageManager.getGuardiansForYear(selectedYear) || [];
        const guardianFromYear = guardiansForYear.find((g: any) => 
          String(g.id) === String(user?.id) || 
          String(g.username || '').toLowerCase() === String(user?.username || '').toLowerCase()
        );
        if (guardianFromYear?.studentIds?.length) {
          assignedStudentIds = guardianFromYear.studentIds.map((id: any) => String(id));
        }

        // Buscar en relaciones guardian-student
        if (assignedStudentIds.length === 0) {
          const relations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear) || [];
          assignedStudentIds = relations
            .filter((rel: any) => 
              String(rel.guardianId) === String(user?.id) || 
              String(rel.guardianUsername || '').toLowerCase() === String(user?.username || '').toLowerCase()
            )
            .map((rel: any) => String(rel.studentId));
        }

        // Buscar en smart-student-users
        if (assignedStudentIds.length === 0) {
          const loadJson = <T,>(key: string, def: T): T => {
            try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
          };
          const usersData = loadJson<any[]>('smart-student-users', []);
          const fullUserData = usersData.find((u: any) => 
            String(u.username || '').toLowerCase() === String(user?.username || '').toLowerCase()
          );
          if (fullUserData?.studentIds?.length) {
            assignedStudentIds = fullUserData.studentIds.map((id: any) => String(id));
          }
        }

        console.log(`🐵 [Monito Apoderado] Estudiantes asignados: ${assignedStudentIds.length}`, assignedStudentIds);
      } catch (e) {
        console.warn('🐵 [Monito Apoderado] Error buscando estudiantes asignados:', e);
      }

      if (assignedStudentIds.length === 0) {
        console.warn('🐵 [Monito Apoderado] No se encontraron estudiantes asignados');
        setCachedGrades([]);
        setLastFetchTime(now);
        return [];
      }

      // 2) Cargar calificaciones desde el backend dinámico (IndexedDB/Firebase)
      grades = await getGradesByYear(selectedYear);
      console.log(`🐵 [Monito Apoderado] ${grades?.length || 0} calificaciones vía useGradesSQL (año ${selectedYear})`);

      if (!grades || grades.length === 0) {
        console.warn('🐵 [Monito Apoderado] No hay calificaciones en ninguna fuente');
        setCachedGrades([]);
        setLastFetchTime(now);
        return [];
      }

      // 4) Filtrar calificaciones de los hijos
      const normRut = (r?: string) => (r||'').replace(/\./g,'').replace(/-/g,'').toLowerCase().trim();
      const assignedSet = new Set(assignedStudentIds.map(id => id.toLowerCase().trim()));
      const assignedRutSet = new Set(assignedStudentIds.map(id => normRut(id)));

      const childGrades = grades.filter((g: any) => {
        const gStudentId = String(g.studentId || '').toLowerCase().trim();
        const gStudentUsername = String(g.studentUsername || g.username || '').toLowerCase().trim();
        const gStudentRut = normRut(g.studentRut || g.rut);

        return assignedSet.has(gStudentId) || 
               assignedSet.has(gStudentUsername) || 
               assignedRutSet.has(gStudentId) ||
               assignedRutSet.has(gStudentRut);
      });

      console.log(`🐵 [Monito Apoderado] Encontradas ${childGrades.length} calificaciones para los hijos`);

      setCachedGrades(childGrades);
      setLastFetchTime(now);
      return childGrades;
    } catch (e) {
      console.error('🐵 [Monito Apoderado] Error general:', e);
      return [];
    }
  };

  // === NUEVO: Obtener calificaciones para modo Profesor (todo el año) ===
  const obtenerCalificacionesDocente = async (forceRefresh = false) => {
    try {
      const now = Date.now();
      const cacheValid = cachedAllGrades && !forceRefresh && (now - lastFetchAllTime < 60000);
      if (cacheValid) return cachedAllGrades;

      // Año seleccionado por la app (fallback: año actual)
      const selectedYear = Number(localStorage.getItem('admin-selected-year') || new Date().getFullYear());
      const arr = await getGradesByYear(selectedYear);
      setCachedAllGrades(Array.isArray(arr) ? arr : []);
      setLastFetchAllTime(now);
      setAnalysisYear(selectedYear);
      return Array.isArray(arr) ? arr : [];

      setCachedAllGrades([]);
      setLastFetchAllTime(now);
      return [];
    } catch {
      return [];
    }
  };

  const analizarCalificaciones = async (calificaciones: any[]): Promise<Sugerencia> => {
    if (!calificaciones?.length) {
      return {
        texto: language === 'es' ? 'Aún no hay calificaciones registradas.' : 'No grades yet.',
        tipo: 'motivacion',
        icono: TrendingUp,
        plan: []
      };
    }

    interface CalificacionDetalle { materia: string; score: number; actividades: string[]; }
  const detalle: CalificacionDetalle[] = [];
  const map = new Map<string, number[]>();
    let sum = 0, count = 0;

    calificaciones.forEach((c: any) => {
      const materiaRaw = c.subjectId || 'general';
      // Construir nombre legible desde subjectId y luego embellecer con acentos comunes
      const baseMateria = materiaRaw
        .toString()
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map((w:string)=> w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const prettySubject = (name: string) => {
        const key = name
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g,' ')
          .trim();
        const mapPretty: Record<string,string> = {
          'matematica': 'Matemáticas',
          'matematicas': 'Matemáticas',
          'lenguaje y comunicacion': 'Lenguaje y Comunicación',
          'educacion fisica': 'Educación Física',
          'musica': 'Música',
          'tecnologia': 'Tecnología',
          'orientacion': 'Orientación',
          'ingles': 'Inglés',
          'artes visuales': 'Artes Visuales',
          'ciencias naturales': 'Ciencias Naturales',
          'historia geografia y ciencias sociales': 'Historia, Geografía y Ciencias Sociales',
          'historia y geografia': 'Historia, Geografía y Ciencias Sociales'
        };
        return mapPretty[key] || name;
      };
      const materia = prettySubject(baseMateria);
      const score = Number(c.score || 0);
      const tema = c.topic || c.title || '';
      if (score > 0) {
        detalle.push({ materia, score, actividades: tema ? [tema] : [] });
        if (!map.has(materia)) map.set(materia, []);
        map.get(materia)!.push(score);
        sum += score; count++;
      }
    });

    const promedio = count ? sum / count : 0;
    const materiasOrdenadas = Array.from(map.entries())
      .map(([materia, arr]) => ({ materia, promedio: arr.reduce((a,b)=>a+b,0)/arr.length }))
      .filter(m => m.materia !== 'General')
      .sort((a,b)=>a.promedio - b.promedio);

    const peores = materiasOrdenadas.slice(0,2);
    // Reparación ligera de palabras comunes sin tildes o con vocal eliminada
    const repairDisplay = (txt?: string) => {
      let s = String(txt || '');
      s = s
        .replace(/\bhbitat\b/gi, 'hábitat')
        .replace(/\bnmeros\b/gi, 'números')
        .replace(/\bnumeros\b/gi, 'números')
        .replace(/\bmatemticas\b/gi, 'matemáticas')
        .replace(/\bqumica\b/gi, 'química')
        .replace(/\bfisica\b/gi, 'física')
        .replace(/\bbiologa\b/gi, 'biología')
        .replace(/\bcomparacin\b/gi, 'comparación')
        .replace(/s\uFFFDmbolo(s)?/gi, (m, p1) => `símbolo${p1 ? 's' : ''}`)
        .replace(/\bsmbolo(s)?\b/gi, (m, p1) => `símbolo${p1 ? 's' : ''}`)
        .replace(/\bsimbolo(s)?\b/gi, (m, p1) => `símbolo${p1 ? 's' : ''}`)
        .replace(/n\uFFFDmeric(a|o|as|os)/gi, (m, p1) => `numéric${p1}`)
        .replace(/\bnmeric(a|o|as|os)\b/gi, (m, p1) => `numéric${p1}`)
        .replace(/\bnumeric(a|o|as|os)\b/gi, (m, p1) => `numéric${p1}`);
      return s;
    };

    const obtenerTemasBajos = (m: string) => {
      const low = detalle.filter(d=>d.materia===m).sort((a,b)=>a.score-b.score).slice(0,3);
      const set = new Set<string>(); low.forEach(d=>d.actividades.forEach(t=>t&&set.add(repairDisplay(t.trim()))));
      const res = Array.from(set).slice(0,3).join(', ').slice(0,80);
      return res || (language==='es'?'conceptos básicos':'basic concepts');
    };

    // Sanitización suave SOLO para visualización: mantener tildes y caracteres Unicode, quitar controles/zero-width.
    const limpiar = (t:string)=> String(t || '')
      .replace(/\uFFFD/g, '') // carácter de reemplazo
      .replace(/[\u0000-\u001F\u007F]/g, '') // controles ASCII
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width
      .replace(/\s+/g, ' ')
      .trim();

    // 🎯 PRIORIDADES: Top 3 materias a reforzar
    const prioridades = materiasOrdenadas.slice(0,3).map((m, i) =>
      language === 'es' ? `📚 Prioridad ${i+1}: ${m.materia} (${m.promedio.toFixed(1)})` : `📚 Priority ${i+1}: ${m.materia} (${m.promedio.toFixed(1)})`
    );
    
    // 🌟 TIPS MOTIVACIONALES Y DE BIENESTAR (rotarán después del análisis principal)
    const tipsVariados = language === 'es' ? [
      '💡 Técnica Pomodoro: 25 min estudio, 5 min descanso',
      '🎯 Divide tareas grandes en pasos pequeños',
      '🏃 20-30 min de ejercicio mejora la memoria',
      '😴 Duerme 7-9 horas para consolidar aprendizaje',
      '💧 Hidrátate: el cerebro necesita agua para funcionar',
      '🥗 Come balanceado: frutas, verduras, proteínas',
      '🧘 5 min de respiración profunda reduce el estrés',
      '📝 Repasa lo aprendido antes de dormir',
      '🎵 Música tranquila puede ayudar a concentrarte',
      '🌳 Sal a caminar: la naturaleza recarga tu mente',
      '👥 Estudia en grupo para compartir ideas',
      '🎨 Usa colores y diagramas para memorizar mejor',
    ] : [
      '💡 Pomodoro: 25 min study, 5 min break',
      '🎯 Break big tasks into small steps',
      '🏃 20-30 min exercise boosts memory',
      '😴 Sleep 7-9 hours to consolidate learning',
      '💧 Hydrate: brain needs water to function',
      '🥗 Eat balanced: fruits, veggies, proteins',
      '🧘 5 min deep breathing reduces stress',
      '📝 Review what you learned before sleep',
      '🎵 Calm music can help you focus',
      '🌳 Go for a walk: nature recharges your mind',
      '👥 Study groups help share ideas',
      '🎨 Use colors and diagrams to memorize better',
    ];

    if (peores.length>=2) {
      const [m1,m2] = peores;
      const t1 = limpiar(obtenerTemasBajos(m1.materia));
      const t2 = limpiar(obtenerTemasBajos(m2.materia));
      const tiempo = (p:number)=> p<40?30 : p<55?20 : p<70?15 : 10;
      const msgEs = `📊 Promedio General: ${promedio.toFixed(1)}\n\n💡 ¡Cada día es una oportunidad para aprender!\n\n📖 Refuerza:\n• ${m1.materia} (${t1}) - ${tiempo(m1.promedio)} min/día\n• ${m2.materia} (${t2}) - ${tiempo(m2.promedio)} min/día`;
      const msgEn = `📊 Overall Average: ${promedio.toFixed(1)}\n\n💡 Every day is an opportunity to learn!\n\n📖 Reinforce:\n• ${m1.materia} (${t1}) - ${tiempo(m1.promedio)} min/day\n• ${m2.materia} (${t2}) - ${tiempo(m2.promedio)} min/day`;
      return { texto: language==='es'?msgEs:msgEn, tipo:'plan', icono: BookOpen, plan: [], prioridades, tips: tipsVariados };
    }

    if (peores.length===1) {
      const [m] = peores; const t = limpiar(obtenerTemasBajos(m.materia));
      const tiempo = (p:number)=> p<40?30 : p<55?20 : p<70?15 : 10;
      const msgEs = `📊 Promedio General: ${promedio.toFixed(1)}\n\n💡 ¡Cada día es una oportunidad para aprender!\n\n📖 Refuerza:\n• ${m.materia} (${t}) - ${tiempo(m.promedio)} min/día`;
      const msgEn = `📊 Overall Average: ${promedio.toFixed(1)}\n\n💡 Every day is an opportunity to learn!\n\n📖 Reinforce:\n• ${m.materia} (${t}) - ${tiempo(m.promedio)} min/day`;
      return { texto: language==='es'?msgEs:msgEn, tipo:'plan', icono: BookOpen, plan: [], prioridades, tips: tipsVariados };
    }

    return { 
      texto: language==='es'? `📊 Promedio General: ${promedio.toFixed(1)}\n\n✨ ¡Excelente trabajo! Sigue así 🚀` : `📊 Overall Average: ${promedio.toFixed(1)}\n\n✨ Great work! Keep it up 🚀`, 
      tipo:'plan', 
      icono: Sparkles, 
      plan: [], 
      prioridades, 
      tips: tipsVariados 
    };
  };

  // === VERSIÓN CON NOMBRE DEL ESTUDIANTE (para apoderados) ===
  const analizarCalificacionesConNombre = async (calificaciones: any[], student: any): Promise<Sugerencia> => {
    const nombre = student.displayName || student.name || student.username || 'tu hijo/a';
    
    if (!calificaciones?.length) {
      return {
        texto: language === 'es' 
          ? `📚 Aún no hay calificaciones registradas para ${nombre}.` 
          : `📚 No grades yet for ${nombre}.`,
        tipo: 'motivacion',
        icono: TrendingUp,
        plan: []
      };
    }

    interface CalificacionDetalle { materia: string; score: number; actividades: string[]; }
    const detalle: CalificacionDetalle[] = [];
    const map = new Map<string, number[]>();
    let sum = 0, count = 0;

    calificaciones.forEach((c: any) => {
      const materiaRaw = c.subjectId || c.subjectName || c.subject || 'general';
      const baseMateria = materiaRaw
        .toString()
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map((w:string)=> w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const prettySubject = (name: string) => {
        const key = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g,' ').trim();
        const mapPretty: Record<string,string> = {
          'matematica': 'Matemáticas', 'matematicas': 'Matemáticas',
          'lenguaje y comunicacion': 'Lenguaje y Comunicación',
          'educacion fisica': 'Educación Física', 'musica': 'Música',
          'tecnologia': 'Tecnología', 'orientacion': 'Orientación',
          'ingles': 'Inglés', 'artes visuales': 'Artes Visuales',
          'ciencias naturales': 'Ciencias Naturales',
          'historia geografia y ciencias sociales': 'Historia, Geografía y Ciencias Sociales',
          'biologia': 'Biología', 'quimica': 'Química', 'fisica': 'Física',
          'filosofia': 'Filosofía', 'educacion ciudadana': 'Educación Ciudadana'
        };
        return mapPretty[key] || name;
      };
      const materia = prettySubject(baseMateria);
      const score = Number(c.score || 0);
      const tema = c.topic || c.title || '';
      if (score > 0) {
        detalle.push({ materia, score, actividades: tema ? [tema] : [] });
        if (!map.has(materia)) map.set(materia, []);
        map.get(materia)!.push(score);
        sum += score; count++;
      }
    });

    const promedio = count ? sum / count : 0;
    const materiasOrdenadas = Array.from(map.entries())
      .map(([materia, arr]) => ({ materia, promedio: arr.reduce((a,b)=>a+b,0)/arr.length }))
      .filter(m => m.materia !== 'General')
      .sort((a,b)=>a.promedio - b.promedio);

    const peores = materiasOrdenadas.slice(0,2);

    // Tips para padres
    const tipsParaPadres = language === 'es' ? [
      '💡 Pregunta: "¿Qué aprendiste hoy?" en lugar de "¿Cómo te fue?"',
      '🏠 Crea un espacio tranquilo para estudiar sin distracciones',
      '⏰ Establece horarios fijos de estudio (20-30 min)',
      '🎯 Celebra los pequeños logros, no solo las notas',
      '📱 Limita el tiempo de pantallas antes de estudiar',
      '😴 Asegura 8-10 horas de sueño para su edad',
      '🥗 Un buen desayuno mejora la concentración',
      '👥 Conoce a sus compañeros y profesores',
      '📖 Lee junto a él/ella 15 min al día',
      '💪 Refuerza el esfuerzo, no solo el resultado',
    ] : [
      '💡 Ask "What did you learn today?" instead of "How was school?"',
      '🏠 Create a quiet study space without distractions',
      '⏰ Set fixed study schedules (20-30 min)',
      '🎯 Celebrate small achievements, not just grades',
      '📱 Limit screen time before studying',
      '😴 Ensure 8-10 hours of sleep for their age',
      '🥗 A good breakfast improves concentration',
      '👥 Get to know their classmates and teachers',
      '📖 Read together for 15 min daily',
      '💪 Reinforce effort, not just results',
    ];

    // Prioridades de refuerzo
    const prioridades = materiasOrdenadas.slice(0,3).map((m, i) =>
      language === 'es' ? `📚 Prioridad ${i+1}: ${m.materia} (${m.promedio.toFixed(1)})` : `📚 Priority ${i+1}: ${m.materia} (${m.promedio.toFixed(1)})`
    );

    const tiempo = (p:number)=> p<40?30 : p<55?20 : p<70?15 : 10;

    if (peores.length >= 2) {
      const [m1, m2] = peores;
      const msgEs = `👤 ${nombre}\n📊 Promedio General: ${promedio.toFixed(1)}\n\n💡 ¡Con tu apoyo puede mejorar!\n\n📖 Sugerencias de refuerzo:\n• ${m1.materia} - ${tiempo(m1.promedio)} min/día\n• ${m2.materia} - ${tiempo(m2.promedio)} min/día`;
      const msgEn = `👤 ${nombre}\n📊 Overall Average: ${promedio.toFixed(1)}\n\n💡 With your support they can improve!\n\n📖 Suggested reinforcement:\n• ${m1.materia} - ${tiempo(m1.promedio)} min/day\n• ${m2.materia} - ${tiempo(m2.promedio)} min/day`;
      return { texto: language==='es'?msgEs:msgEn, tipo:'plan', icono: BookOpen, plan: [], prioridades, tips: tipsParaPadres };
    }

    if (peores.length === 1) {
      const [m] = peores;
      const msgEs = `👤 ${nombre}\n📊 Promedio General: ${promedio.toFixed(1)}\n\n💡 ¡Va muy bien!\n\n📖 Puede reforzar:\n• ${m.materia} - ${tiempo(m.promedio)} min/día`;
      const msgEn = `👤 ${nombre}\n📊 Overall Average: ${promedio.toFixed(1)}\n\n💡 Doing great!\n\n📖 Can reinforce:\n• ${m.materia} - ${tiempo(m.promedio)} min/day`;
      return { texto: language==='es'?msgEs:msgEn, tipo:'plan', icono: BookOpen, plan: [], prioridades, tips: tipsParaPadres };
    }

    return { 
      texto: language==='es'
        ? `👤 ${nombre}\n📊 Promedio General: ${promedio.toFixed(1)}\n\n✨ ¡Excelente trabajo! Sigue apoyándolo/a 🚀` 
        : `👤 ${nombre}\n📊 Overall Average: ${promedio.toFixed(1)}\n\n✨ Great work! Keep supporting them 🚀`, 
      tipo:'plan', 
      icono: Sparkles, 
      plan: [], 
      prioridades, 
      tips: tipsParaPadres 
    };
  };

  // === NUEVO: Análisis para PROFESOR — % de aprobación por asignatura y sugerencias ===
  const analizarCalificacionesDocente = async (todas: any[]): Promise<Sugerencia> => {
    // Helpers de asignaturas (alineados al dashboard)
    const normSubj = (s?: string) => String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const canonicalSubject = (s?: string) => {
      const n = normSubj(s);
      let v = n
        .replace(/\bgeografa\b/g, 'geografia')
        .replace(/\beducacin\b/g, 'educacion')
        .replace(/\bfsica\b/g, 'fisica')
        .replace(/\bcomunicacin\b/g, 'comunicacion')
        .replace(/\bmatemticas\b/g, 'matematicas');
      if (v.startsWith('lenguaje y comunic')) return 'lenguaje y comunicacion';
      if (v.startsWith('matemat')) return 'matematicas';
      if (v.startsWith('ciencias naturales')) return 'ciencias naturales';
      if (
        v.startsWith('historia y geografia') ||
        v.startsWith('historia geografia y ciencias sociales') ||
        v.startsWith('historia y geografia y ciencias sociales') ||
        v === 'historia geografia' ||
        v === 'historia geografia y ciencias sociales' ||
        v.startsWith('historia geografa y ciencias sociales') ||
        v.startsWith('historia geografa') ||
        v === 'historia geografa'
      ) return 'historia y geografia';
      if (/^historia\s+geograf[ia](\b|\s)/.test(v)) return 'historia y geografia';
      if (v.startsWith('educacion fisica')) return 'educacion fisica';
      if (v.startsWith('artes visuales')) return 'artes visuales';
      if (v.startsWith('musica')) return 'musica';
      if (v.startsWith('tecnologia')) return 'tecnologia';
      if (v.startsWith('orientacion')) return 'orientacion';
      return v;
    };
    const codeFor = (s?: string): string => {
      const c = canonicalSubject(s);
      if (/matematic/.test(c)) return 'MAT';
      if (/lenguaj|comunicacion|lengua/.test(c)) return 'LEN';
      if (/histori|geografi/.test(c)) return 'HIS';
      if (/ciencia|biolog|fisic|quimic|naturales?/.test(c)) return 'CIE';
      if (/ingles|english/.test(c)) return 'ING';
      if (/educacion fisic|fisica|ef$|ef\b/.test(c)) return 'EFI';
      if (/tecnolog/.test(c)) return 'TEC';
      if (/musica/.test(c)) return 'MUS';
      if (/arte|artes visual/.test(c)) return 'ART';
      if (/orientacion/.test(c)) return 'ORI';
      return (s||'GEN').toUpperCase().slice(0,3);
    };

    // Cargar asignaciones del profesor (secciones + asignaturas) para el año
    const year = Number(localStorage.getItem('admin-selected-year') || new Date().getFullYear());
    let teacherAssignments: any[] = [];
    let sections: any[] = [];
    let sectionsById = new Map<string,string>();
    let courseBySection = new Map<string,string>();
    try {
      const { LocalStorageManager } = await import('@/lib/education-utils');
      teacherAssignments = LocalStorageManager.getTeacherAssignmentsForYear(year) || [];
      sections = LocalStorageManager.getSectionsForYear(year) || [];
      for (const s of sections) {
        sectionsById.set(String(s.id), String(s.name || ''));
        if (s?.id && s?.courseId) courseBySection.set(String(s.id), String(s.courseId));
      }
    } catch {}

    const teacherId = String(user?.id || user?.username || '').toLowerCase();
    const myAssigns = (teacherAssignments || []).filter(a => {
      const t = String(a.teacherId || a.teacherUsername || '').toLowerCase();
      return t && teacherId && t === teacherId;
    });

  const assignedSubjectsCanon = new Set<string>(myAssigns.map(a => canonicalSubject(a.subjectName || a.subject || '')));
    const allowedSections = new Set<string>(myAssigns.map(a => String(a.sectionId || '')));
    const allowedCourses = new Set<string>(Array.from(allowedSections).map(sec => courseBySection.get(sec)!).filter(Boolean) as string[]);

    // Filtrar calificaciones relevantes al profesor
    const relevant = (todas || []).filter((g: any) => {
      const score = Number(g.score || 0);
      if (!(score > 0)) return false;
      const subjCanon = canonicalSubject(g.subjectId || g.subject || g.subjectName || '');
      const sec = g.sectionId ? String(g.sectionId) : '';
      const course = g.courseId ? String(g.courseId) : '';

      // Solo asignaturas asignadas al profesor
      const subjectOk = assignedSubjectsCanon.size === 0 ? true : assignedSubjectsCanon.has(subjCanon);

      // Si no hay restricciones por sección/curso, basta con subjectOk
      const sectionOk = allowedSections.size === 0 || (sec && allowedSections.has(sec));
      const courseOk = allowedCourses.size === 0 || (course && allowedCourses.has(course));
      if (allowedSections.size === 0 && allowedCourses.size === 0) return subjectOk;

      // Con restricciones por sección/curso: requerir subjectOk y (sección o curso válidos)
      return subjectOk && (sectionOk || courseOk);
    });

    if (!relevant.length) {
      const fallbackEs = 'Aún no hay calificaciones registradas para tus asignaturas/curso.';
      const fallbackEn = 'No grades yet for your subjects/courses.';
      return { texto: language==='es'? fallbackEs : fallbackEn, tipo: 'motivacion', icono: Award, plan: [] };
    }

    // Agregar por asignatura — total vs aprobados (>=60) y promedio
    const agg = new Map<string, { code: string; total: number; ok: number; sum: number }>();
    const subjAvg = new Map<string, { code: string; avg: number; n: number }>();
    // Por actividad (topic/título preferido) dentro de cada asignatura
    const bySubjectActivity = new Map<string, Map<string, { sum: number; n: number; last: number; label: string }>>();
    // Limpieza visual de topics (mojibake y espacios)
    const cleanTopic = (txt?: string) => {
      let s = String(txt || '').trim();
      if (!s) return '';
      s = s
        .replace(/\uFFFD/g, '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      // Reparaciones comunes
      s = s
        .replace(/\bhbitat\b/gi, 'hábitat')
        .replace(/\bnmeros\b/gi, 'números')
        .replace(/\bnumeros\b/gi, 'números')
        .replace(/\bmatemticas\b/gi, 'matemáticas')
        .replace(/\bqumica\b/gi, 'química')
        .replace(/\bfisica\b/gi, 'física')
        .replace(/\bbiologa\b/gi, 'biología')
        .replace(/\bcomparacin\b/gi, 'comparación')
        .replace(/smbolo(s)?/gi, (m,p1)=>`símbolo${p1?'s':''}`)
        .replace(/simbolo(s)?/gi, (m,p1)=>`símbolo${p1?'s':''}`)
      ;
      return s;
    };
    for (const g of relevant) {
  const subj = g.subjectId || g.subject || g.subjectName || 'General';
  const key = canonicalSubject(subj);
      const code = codeFor(subj);
      const score = Number(g.score || 0);
      if (!agg.has(key)) agg.set(key, { code, total: 0, ok: 0, sum: 0 });
      const it = agg.get(key)!;
      it.total += 1; it.sum += score;
      if (score >= 60) it.ok += 1;

      // Actividad (usar topic/título de Firebase; fallback testId)
      const topicLabel = cleanTopic(g.topic || g.title);
      const actLabel = topicLabel || String(g.testId || '').toUpperCase();
      if (actLabel) {
        if (!bySubjectActivity.has(key)) bySubjectActivity.set(key, new Map());
        const map = bySubjectActivity.get(key)!;
        const actKey = actLabel.toLowerCase();
        if (!map.has(actKey)) map.set(actKey, { sum: 0, n: 0, last: 0, label: actLabel });
        const st = map.get(actKey)!;
        st.sum += score; st.n += 1; st.last = Math.max(st.last, Number(g.gradedAt || 0));
      }
    }
    // Promedio por asignatura
    for (const [k, v] of agg.entries()) {
      const avg = v.total ? v.sum / v.total : 0;
      subjAvg.set(k, { code: v.code, avg, n: v.total });
    }

    const list = Array.from(agg.entries())
      .map(([k,v]) => ({ key: k, code: v.code, total: v.total, ok: v.ok, rate: v.total ? (v.ok / v.total) * 100 : 0 }))
      .filter(x => x.total >= 5) // umbral mínimo para evitar ruido
      .sort((a,b) => a.rate - b.rate);

    if (list.length === 0) {
      // Si no alcanza el umbral, considerar todo
      const list2 = Array.from(agg.entries()).map(([k,v]) => ({ key: k, code: v.code, total: v.total, ok: v.ok, rate: v.total ? (v.ok / v.total) * 100 : 0 }))
        .sort((a,b) => a.rate - b.rate);
      if (list2.length === 0) {
        const noDataEs = 'Aún no hay datos suficientes para análisis por asignatura.';
        const noDataEn = 'Not enough data yet for per-subject analysis.';
        return { texto: language==='es'? noDataEs : noDataEn, tipo: 'motivacion', icono: Award, plan: [] };
      }
      // usar list2
  const worst = list2[0];
  const best = list2[list2.length - 1];
      // Top 3 actividades más bajas en la asignatura prioritaria
      const actMap = bySubjectActivity.get(worst.key) || new Map();
      const worstActs = Array.from(actMap.entries())
        .map(([k, s]) => ({ label: s.label || k.toUpperCase(), avg: s.n ? s.sum / s.n : 0, n: s.n, last: s.last }))
        .sort((a,b) => a.avg - b.avg)
        .slice(0,3);
      // Función para extraer tipo de actividad y formatear nombre corto
      const extractActType = (label: string): string => {
        const upper = (label || '').toUpperCase();
        if (upper.includes('TAREA')) return 'Tarea';
        if (upper.includes('PRUEBA')) return 'Prueba';
        if (upper.includes('EVALUACION') || upper.includes('EVALUACIÓN')) return 'Evaluación';
        if (upper.includes('EXAMEN')) return 'Examen';
        if (upper.includes('QUIZ')) return 'Quiz';
        if (upper.includes('TRABAJO')) return 'Trabajo';
        // Si no encuentra tipo, usar primeras 15 chars
        return (label || 'Act').slice(0, 15);
      };
      const fmtAct = (a: any, idx: number) => `  ${idx+1}. ${extractActType(a.label)}: ${a.avg.toFixed(1)} (n=${a.n})`;
      const yearTxt = analysisYear ? ` ${analysisYear}` : '';
  // Cadena de promedios por asignatura (compacta)
  const avgList = Array.from(subjAvg.entries())
    .map(([k,v]) => ({ code: v.code, avg: v.avg, n: v.n }))
    .sort((a,b) => a.avg - b.avg);
  const avgLineEs = avgList.map(x => `${x.code} ${x.avg.toFixed(1)}`).join(' · ');
  const avgLineEn = avgList.map(x => `${x.code} ${x.avg.toFixed(1)}`).join(' · ');
  const worstActsFormatted = worstActs.length > 0 ? worstActs.map((a, i) => fmtAct(a, i)).join('\n') : '—';
  const msgEs = `📊 Promedio por asignatura${yearTxt}
${avgLineEs}

✏️ Actividades a mejorar (${worst.code}):
${worstActsFormatted}

💡 Acciones: evaluaciones cortas, rúbricas claras, práctica guiada y feedback inmediato.`;
  const msgEn = `📊 Average by subject${yearTxt}
${avgLineEn}

✏️ Activities to improve (${worst.code}):
${worstActsFormatted}

💡 Actions: short assessments, clear rubrics, guided practice, immediate feedback.`;
      const tips = language==='es'
        ? [
            '🎯 Evalúa por evidencias breves (exit tickets, mini-quizzes).',
            '🧭 Publica rúbricas simples: criterio + ejemplo + escala.',
            '🔁 Repite conceptos clave con variaciones (bajo costo).',
            '🤝 Estrategias de motivación: metas cortas + refuerzo positivo.',
            '⏱️ Gestión del tiempo: bloques de 12–15 min + 2 min de mini-descanso.',
            '🍎 Bienestar: acuerda colaciones ligeras y pausas de hidratación.'
          ]
        : [
            '🎯 Use brief evidence checks (exit tickets, mini-quizzes).',
            '🧭 Publish simple rubrics: criterion + example + scale.',
            '🔁 Spiral key concepts with small variations.',
            '🤝 Motivation: short goals + positive reinforcement.',
            '⏱️ Time: 12–15 min blocks + 2-min micro breaks.',
            '🍎 Wellbeing: light snacks and hydration pauses.'
          ];
      return { texto: language==='es'? msgEs : msgEn, tipo: 'plan', icono: BookOpen, plan: [], tips };
    }

    const worst = list[0];
    const best = list[list.length - 1];
    // Top 3 actividades más bajas en la asignatura prioritaria
    const actMap = bySubjectActivity.get(worst.key) || new Map();
    const worstActs2 = Array.from(actMap.entries())
      .map(([k, s]) => ({ label: s.label || k.toUpperCase(), avg: s.n ? s.sum / s.n : 0, n: s.n, last: s.last }))
      .sort((a,b) => a.avg - b.avg)
      .slice(0,3);
    // Función para extraer tipo de actividad y formatear nombre corto
    const extractActType2 = (label: string): string => {
      const upper = (label || '').toUpperCase();
      if (upper.includes('TAREA')) return 'Tarea';
      if (upper.includes('PRUEBA')) return 'Prueba';
      if (upper.includes('EVALUACION') || upper.includes('EVALUACIÓN')) return 'Evaluación';
      if (upper.includes('EXAMEN')) return 'Examen';
      if (upper.includes('QUIZ')) return 'Quiz';
      if (upper.includes('TRABAJO')) return 'Trabajo';
      return (label || 'Act').slice(0, 15);
    };
    const fmtAct2 = (a: any, idx: number) => `  ${idx+1}. ${extractActType2(a.label)}: ${a.avg.toFixed(1)} (n=${a.n})`;
    const yearTxt = analysisYear ? ` ${analysisYear}` : '';
    const avgList2 = Array.from(subjAvg.entries())
      .map(([k,v]) => ({ code: v.code, avg: v.avg, n: v.n }))
      .sort((a,b) => a.avg - b.avg);
    const avgLineEs2 = avgList2.map(x => `${x.code} ${x.avg.toFixed(1)}`).join(' · ');
    const avgLineEn2 = avgList2.map(x => `${x.code} ${x.avg.toFixed(1)}`).join(' · ');
    const worstActsFormatted2 = worstActs2.length > 0 ? worstActs2.map((a, i) => fmtAct2(a, i)).join('\n') : '—';
    const msgEs2 = `📊 Promedio por asignatura${yearTxt}
${avgLineEs2}

✏️ Actividades a mejorar (${worst.code}):
${worstActsFormatted2}

💡 Acciones: evaluaciones cortas, rúbricas claras, práctica guiada y feedback inmediato.`;
    const msgEn2 = `📊 Average by subject${yearTxt}
${avgLineEn2}

✏️ Activities to improve (${worst.code}):
${worstActsFormatted2}

💡 Actions: short assessments, clear rubrics, guided practice, immediate feedback.`;

    const tips = language==='es'
      ? [
          '🧪 Idea de evaluación: 3 preguntas esenciales al cierre.',
          '📊 Retro inmediata: corrige en vivo 2 ejemplos típicos.',
          '👥 Parejas tutor–tutorado por 6–8 min.',
          '🎯 Metas micro: “hoy logramos X, mañana Y”.',
          '🗂️ Eficiencia: banca bancos de ítems para reusar.',
          '🍎 Bienestar y foco: pausas de agua y estiramientos breves.'
        ]
      : [
          '🧪 Assessment idea: 3 essential questions to close.',
          '📊 Immediate feedback: solve 2 typical examples live.',
          '👥 Peer tutoring for 6–8 minutes.',
          '🎯 Micro goals: “today X, tomorrow Y”.',
          '🗂️ Efficiency: maintain reusable item banks.',
          '🍎 Wellbeing and focus: quick hydration/stretch breaks.'
        ];

    return { texto: language==='es'? msgEs2 : msgEn2, tipo: 'plan', icono: BookOpen, plan: [], tips };
  };

  // Placeholder local que simula una consulta a la IA.
  // Toma las calificaciones y la sugerencia base y devuelve mensajes adicionales
  // (motivación, buenas prácticas, alimentación, dormir bien, etc).
  // Reemplazar por llamada a un endpoint real cuando esté disponible.
  const fetchAiSuggestions = async (calificaciones: any[], baseSugerencia: Sugerencia): Promise<string[]> => {
    try {
  const isTeacher = (user?.role === 'teacher' || user?.role === 'admin');
      if (isTeacher) {
        // Mensajes IA centrados en docente: evaluación, motivación, bienestar, tiempo y eficiencia
        const es = [
          '🧪 Evaluación: usa mini-rúbricas con 3 niveles y ejemplos claros.',
          '🎯 Motivación: fija metas semanales visibles y celebra avances.',
          '🍎 Bienestar: coordina colaciones livianas y pausas activas breves.',
          '⏱️ Tiempo: bloques de 12–15 min + 2 min de micro-descanso.',
          '🗂️ Eficiencia: reutiliza bancos de ítems y plantillas de feedback.',
          '🤝 Inclusión: ofrece alternativas de demostración (oral, gráfica, práctica).'
        ];
        const en = [
          '🧪 Assessment: use mini-rubrics with 3 levels and examples.',
          '🎯 Motivation: set weekly visible goals and celebrate progress.',
          '🍎 Wellbeing: coordinate light snacks and short active breaks.',
          '⏱️ Time: 12–15 min blocks + 2-min micro breaks.',
          '🗂️ Efficiency: reuse item banks and feedback templates.',
          '🤝 Inclusion: allow alternative demonstrations (oral, graphic, practical).'
        ];
        return language==='es' ? es : en;
      }
      // Extraer promedio para contexto
      const scores = calificaciones.map((c: any) => Number(c.score || 0)).filter((s: number) => s > 0);
      const promedio = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length) : 0;

      // Generar mensajes por categorías
      const motivacion = language === 'es'
        ? `✨ Motivación: "Cada paso cuenta — hoy das un paso más hacia tu meta."`
        : `✨ Motivation: "Every step counts — today you make one more step towards your goal."`;

      const buenasPracticas = language === 'es'
        ? '🧭 Buenas prácticas: Establece sesiones cortas (25-40min), repasa errores y usa resúmenes visuales.'
        : '🧭 Good practices: Use short sessions (25-40min), review mistakes and use visual summaries.';

      const alimentacion = language === 'es'
        ? '🍎 Alimentación: Prioriza frutas, proteínas y snacks ligeros antes de estudiar.'
        : '🍎 Nutrition: Favor fruits, proteins and light snacks before studying.';

      const dormir = language === 'es'
        ? '😴 Sueño: Mantén horario regular; 7-9 horas ayudan a consolidar lo aprendido.'
        : '😴 Sleep: Keep a regular schedule; 7-9 hours help consolidate learning.';

      const ejercicio = language === 'es'
        ? '🏃 Movimiento: 20-30 min de actividad física al día mejora la atención.'
        : '🏃 Movement: 20-30 min of activity per day improves attention.';

      // También incluir un consejo basado en el promedio (personalizado)
      const consejoPromedio = language === 'es'
        ? (promedio < 60 ? '🔔 Consejo: Comienza por 20-30 min diarios en lo que más te cuesta.' : '👏 Consejo: Mantén el ritmo y añade metas pequeñas cada semana.')
        : (promedio < 60 ? '🔔 Tip: Start with 20-30 min daily on the subjects you struggle most.' : '👏 Tip: Keep the pace and add small goals each week.');

      // Orden: motivación -> buenas prácticas -> alimentación -> dormir -> ejercicio -> consejoPromedio
      return [motivacion, buenasPracticas, alimentacion, dormir, ejercicio, consejoPromedio];
    } catch (e) {
      return [];
    }
  };

  // === HANDLER: Seleccionar un estudiante (para apoderados con múltiples hijos) ===
  const handleSelectStudent = async (student: any) => {
    setIsLoading(true);
    setShowStudentSelector(false);
    setSelectedStudentForAnalysis(student);
    setClickCount(1); // Reiniciar contador

    const cal = await obtenerCalificacionesDeEstudiante(student);
    
    if (cal.length > 0) {
      const sug = await analizarCalificacionesConNombre(cal, student);
      setSugerenciaActual(sug);
      const list = [...(sug.prioridades || []), ...(sug.tips || [])];
      setExtraTips(list);
      setTipIndex(0);
    } else {
      const nombre = student.displayName || student.name || student.username;
      setSugerenciaActual({
        texto: language === 'es'
          ? `📚 Aún no hay calificaciones registradas para ${nombre}.`
          : `📚 No grades yet for ${nombre}.`,
        tipo: 'motivacion',
        icono: Award,
        plan: []
      });
    }
    setIsLoading(false);
  };

  // === HANDLER: Volver al selector de estudiantes (para apoderados) ===
  const handleBackToSelector = () => {
    setSelectedStudentForAnalysis(null);
    setShowStudentSelector(true);
    setClickCount(0);
    setSugerenciaActual({
      texto: language === 'es'
        ? '👨‍👩‍👧‍👦 ¿De cuál estudiante quieres ver el promedio?'
        : '👨‍👩‍👧‍👦 Which student\'s grades would you like to see?',
      tipo: 'motivacion',
      icono: BookOpen,
      plan: []
    });
  };

  const handleClick = async () => {
    const nextCount = clickCount + 1;
    setClickCount(nextCount);
    setIsLoading(true);

    // Determinar rol
    const isTeacher = (user?.role === 'teacher' || user?.role === 'admin');
    const isGuardian = user?.role === 'guardian';

    // Función helper para obtener calificaciones según rol
    const obtenerCalificaciones = async (forceRefresh: boolean) => {
      if (isTeacher) return await obtenerCalificacionesDocente(forceRefresh);
      if (isGuardian) return await obtenerCalificacionesApoderado(forceRefresh);
      return await obtenerCalificacionesUsuario(forceRefresh);
    };

    // === FLUJO ESPECIAL PARA APODERADO ===
    if (isGuardian) {
      // Si estamos en modo selector, ignorar clics (los botones manejan la selección)
      if (showStudentSelector) {
        setIsLoading(false);
        return;
      }

      // Primer clic: verificar cuántos hijos tiene
      if (nextCount === 1 || guardianStudents.length === 0) {
        const students = await obtenerEstudiantesApoderado();
        setGuardianStudents(students);

        if (students.length === 0) {
          // No hay estudiantes asignados
          setSugerenciaActual({
            texto: language === 'es' 
              ? '📚 No tienes estudiantes asignados. Contacta al administrador para vincular a tus hijos.'
              : '📚 No students assigned. Contact admin to link your children.',
            tipo: 'motivacion',
            icono: Award,
            plan: []
          });
          setIsLoading(false);
          return;
        }

        if (students.length === 1) {
          // Solo un hijo: mostrar directamente su análisis
          const student = students[0];
          setSelectedStudentForAnalysis(student);
          const cal = await obtenerCalificacionesDeEstudiante(student);
          
          if (cal.length > 0) {
            const sug = await analizarCalificacionesConNombre(cal, student);
            setSugerenciaActual(sug);
            const list = [...(sug.prioridades || []), ...(sug.tips || [])];
            setExtraTips(list);
            setTipIndex(0);
          } else {
            const nombre = student.displayName || student.name || student.username;
            setSugerenciaActual({
              texto: language === 'es'
                ? `📚 Aún no hay calificaciones registradas para ${nombre}.`
                : `📚 No grades yet for ${nombre}.`,
              tipo: 'motivacion',
              icono: Award,
              plan: []
            });
          }
          setIsLoading(false);
          return;
        }

        // Múltiples hijos: mostrar selector
        setShowStudentSelector(true);
        setSugerenciaActual({
          texto: language === 'es'
            ? '👨‍👩‍👧‍👦 ¿De cuál estudiante quieres ver el promedio?'
            : '👨‍👩‍👧‍👦 Which student\'s grades would you like to see?',
          tipo: 'motivacion',
          icono: BookOpen,
          plan: []
        });
        setIsLoading(false);
        return;
      }

      // Si ya hay un estudiante seleccionado, continuar con el ciclo normal
      if (selectedStudentForAnalysis) {
        // Clics subsecuentes: rotar tips/sugerencias
        if (nextCount >= 2 && nextCount <= 7 && extraTips.length > 0) {
          setTipIndex(i => (i + 1) % extraTips.length);
          const tip = extraTips[tipIndex % extraTips.length];
          setSugerenciaActual({ texto: tip, tipo: 'motivacion', icono: Sparkles, plan: [] });
          setIsLoading(false);
          return;
        }

        // Clic 8+: volver al análisis principal
        if (nextCount >= 8) {
          setClickCount(0);
          const cal = await obtenerCalificacionesDeEstudiante(selectedStudentForAnalysis);
          if (cal.length > 0) {
            const sug = await analizarCalificacionesConNombre(cal, selectedStudentForAnalysis);
            setSugerenciaActual(sug);
          }
          setIsLoading(false);
          return;
        }
      }

      setIsLoading(false);
      return;
    }

    // === FLUJO NORMAL PARA ESTUDIANTE/PROFESOR/ADMIN ===

    // 1) Primer clic: mensaje principal (promedio + refuerzos)
    if (nextCount === 1) {
      // Reiniciar visual de burbujas para un arranque limpio
      setSugerenciaActual(null);
      setExtraTips([]);
      setTipIndex(0);
      const cal = await obtenerCalificaciones(true);
      if (cal.length) {
        const sug = isTeacher ? await analizarCalificacionesDocente(cal) : await analizarCalificaciones(cal);
        setSugerenciaActual(sug);
        const list = [...(sug.prioridades || []), ...(sug.tips || [])];
        setExtraTips(list);
        setTipIndex(0);
        // Prefetch IA en segundo plano
        setIsFetchingAi(true);
        try {
          const aiMsgs = await fetchAiSuggestions(cal, sug);
          if (aiMsgs && aiMsgs.length) {
            setAiMessages(aiMsgs);
            setExtraTips(prev => [...prev, ...aiMsgs]);
            setAiMainIndex(0);
          }
        } catch (e) {
          console.error('AI suggestions failed', e);
        } finally {
          setIsFetchingAi(false);
        }
      } else {
        const fallback = isTeacher
          ? (language==='es' ? 'Aún no hay calificaciones para tus asignaturas.' : 'No grades yet for your subjects.')
          : isGuardian
            ? (language==='es' ? 'Aún no hay calificaciones para tus hijos.' : 'No grades yet for your children.')
            : (language==='es' ? 'No se encontraron calificaciones.' : 'No grades found.');
        setSugerenciaActual({ texto: fallback, tipo:'motivacion', icono: Award, plan: [] });
      }
      setIsLoading(false);
      return;
    }

    // 2) Clics 2..7: mostrar mensajes IA dentro del globo principal
    if (nextCount >= 2 && nextCount <= 7) {
      // Asegurar que existan mensajes IA; si no, intentar obtenerlos rápido usando caché
      let msgs = aiMessages;
      if ((!msgs || msgs.length === 0) && !isFetchingAi) {
        try {
          setIsFetchingAi(true);
          const cal = cachedGrades ?? await obtenerCalificaciones(false);
          const base = sugerenciaActual ?? (cal && cal.length ? await analizarCalificaciones(cal) : null);
          msgs = cal && base ? await fetchAiSuggestions(cal, base) : [];
          if (msgs && msgs.length) {
            setAiMessages(msgs);
            setExtraTips(prev => [...prev, ...msgs]);
          }
        } catch (e) {
          console.error('AI suggestions quick-fetch failed', e);
        } finally {
          setIsFetchingAi(false);
        }
      }

      if (msgs && msgs.length) {
        const msg = msgs[aiMainIndex % msgs.length];
        setSugerenciaActual({ texto: msg, tipo: 'motivacion', icono: Sparkles, plan: [] });
        setAiMainIndex(i => (i + 1) % msgs!.length);
      } else {
        // Fallback temporal si aún no están las IA
        const fallback = language === 'es' ? '⌛ Buscando sugerencias motivacionales…' : '⌛ Fetching motivational suggestions…';
        setSugerenciaActual({ texto: fallback, tipo: 'motivacion', icono: Sparkles, plan: [] });
      }
      setIsLoading(false);
      return;
    }

    // 3) Desde el 8º clic, volver al mensaje principal y reiniciar ciclo
    setClickCount(0);
    try {
      const cal = isTeacher 
        ? (cachedAllGrades ?? await obtenerCalificacionesDocente(false)) 
        : isGuardian
          ? (cachedGrades ?? await obtenerCalificacionesApoderado(false))
          : (cachedGrades ?? await obtenerCalificacionesUsuario(false));
      if (cal && cal.length) {
        const sug = isTeacher ? await analizarCalificacionesDocente(cal) : await analizarCalificaciones(cal);
        setSugerenciaActual(sug);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Rotador de tips (activo siempre que existan tips, independientemente del globo principal)
  useEffect(() => {
    if (extraTips.length === 0) return;
    const id = setInterval(() => setTipIndex(i => (i + 1) % extraTips.length), 5000);
    return () => clearInterval(id);
  }, [extraTips]);

  if (!mounted) return null;

  return (
    <div ref={containerRef} className="relative -translate-y-8">
      <motion.div
        className="relative cursor-pointer"
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
      >
        {/* 🤖 NUEVO DISEÑO: Robot Kawaii Amigable */}
        <motion.div
          className="relative w-20 h-24 flex items-center justify-center"
          animate={{ y: bounce === 0 ? [0, -8, 0] : 0 }}
          transition={{ duration: 1.2, ease: 'easeInOut' }}
        >
          <div className="relative w-16 h-20">
            {/* Cuerpo principal - Cápsula redondeada */}
            <motion.div
              className="absolute inset-0 bg-gradient-to-br from-blue-400 via-purple-500 to-pink-500 rounded-3xl shadow-2xl"
              animate={{ 
                boxShadow: isHovered 
                  ? ['0 10px 40px rgba(139, 92, 246, 0.4)', '0 10px 60px rgba(236, 72, 153, 0.5)', '0 10px 40px rgba(139, 92, 246, 0.4)']
                  : '0 10px 40px rgba(139, 92, 246, 0.3)'
              }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            
            {/* Borde brillante */}
            <div className="absolute inset-0 rounded-3xl ring-2 ring-white/30" />
            
            {/* Pantalla/Cara */}
            <div className="absolute top-6 left-1/2 -translate-x-1/2 w-12 h-10 bg-gradient-to-b from-cyan-100 to-blue-50 rounded-2xl shadow-inner flex flex-col items-center justify-center gap-1.5 border-2 border-white/40">
              {/* Ojos */}
              <div className="flex gap-2.5 items-center">
                <motion.div 
                  className="w-2 h-2 bg-slate-800 rounded-full"
                  animate={isHovered ? { scaleY: [1, 0.2, 1] } : {}}
                  transition={{ duration: 0.3 }}
                />
                <motion.div 
                  className="w-2 h-2 bg-slate-800 rounded-full"
                  animate={isHovered ? { scaleY: [1, 0.2, 1] } : {}}
                  transition={{ duration: 0.3 }}
                />
              </div>
              
              {/* Boca sonriente */}
              <motion.div 
                className="w-6 h-2 border-b-2 border-slate-700 rounded-full"
                animate={isHovered ? { scaleX: [1, 1.3, 1] } : {}}
                transition={{ duration: 0.5 }}
              />
              
              {/* Mini luces decorativas */}
              <div className="absolute top-1 right-1 w-1 h-1 bg-green-400 rounded-full" />
              <div className="absolute top-1 left-1 w-1 h-1 bg-blue-400 rounded-full" />
            </div>
            
            {/* Antena superior */}
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-0.5 h-3 bg-gradient-to-t from-purple-400 to-pink-300" />
            <motion.div 
              className="absolute -top-4 left-1/2 -translate-x-1/2 w-2 h-2 bg-pink-400 rounded-full shadow-lg"
              animate={{ 
                boxShadow: ['0 0 10px rgba(244, 114, 182, 0.8)', '0 0 20px rgba(236, 72, 153, 0.9)', '0 0 10px rgba(244, 114, 182, 0.8)'],
                scale: [1, 1.2, 1]
              }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
            
            {/* Brazos */}
            <motion.div 
              className="absolute -left-1 top-10 w-1.5 h-5 bg-purple-400 rounded-full shadow-md"
              animate={{ 
                rotate: isHovered ? [-20, 20, -20] : [-10, 10, -10]
              }}
              transition={{ duration: 1, repeat: Infinity }}
            />
            <motion.div 
              className="absolute -right-1 top-10 w-1.5 h-5 bg-pink-400 rounded-full shadow-md"
              animate={{ 
                rotate: isHovered ? [20, -20, 20] : [10, -10, 10]
              }}
              transition={{ duration: 1, repeat: Infinity }}
            />
            
            {/* Botones decorativos en el pecho */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
              <motion.div 
                className="w-1.5 h-1.5 bg-yellow-300 rounded-full"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
              />
              <motion.div 
                className="w-1.5 h-1.5 bg-green-300 rounded-full"
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1, repeat: Infinity, delay: 0.5 }}
              />
            </div>
            
            {/* Icono flotante según estado */}
            <AnimatePresence>
              {isHovered && (
                <motion.div
                  initial={{ opacity: 0, y: 0, scale: 0.5 }}
                  animate={{ opacity: 1, y: -10, scale: 1 }}
                  exit={{ opacity: 0, y: 0, scale: 0.5 }}
                  className="absolute -top-8 left-1/2 -translate-x-1/2"
                >
                  <Sparkles className="w-4 h-4 text-yellow-300 drop-shadow-lg" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Burbuja PRINCIPAL a la IZQUIERDA (mensaje de análisis o resultado) */}
          <AnimatePresence mode="wait">
            {(isLoading || sugerenciaActual) && (
              <motion.div
                initial={{ opacity: 0, x: 12, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 12, scale: 0.95 }}
                transition={{ duration: 0.25 }}
                className={`absolute ${isLoading ? '-top-6 w-40' : showStudentSelector ? '-top-10 w-64' : '-top-10 w-56'} right-full mr-4 z-50`}
              >
                <div className="relative">
                  <div className="bg-white dark:bg-gray-800 rounded-2xl p-3 shadow-2xl border-2 border-purple-300 dark:border-purple-600">
                    {isLoading ? (
                      <div className="flex flex-col items-center justify-center gap-1.5">
                        <div className="flex gap-1">
                          <motion.div className="w-2 h-2 bg-blue-500 rounded-full" animate={{ scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }} transition={{ duration: 0.8, repeat: Infinity }} />
                          <motion.div className="w-2 h-2 bg-purple-500 rounded-full" animate={{ scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }} transition={{ duration: 0.8, repeat: Infinity, delay: 0.2 }} />
                          <motion.div className="w-2 h-2 bg-pink-500 rounded-full" animate={{ scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }} transition={{ duration: 0.8, repeat: Infinity, delay: 0.4 }} />
                        </div>
                        <span className="text-[10px] font-medium text-gray-700 dark:text-gray-200 text-center">
                          {language === 'es' ? 'Analizando tus calificaciones...' : 'Analyzing your grades...'}
                        </span>
                      </div>
                    ) : showStudentSelector && guardianStudents.length > 1 ? (
                      /* === SELECTOR DE ESTUDIANTES PARA APODERADO === */
                      <div className="flex flex-col gap-2">
                        <div className="text-[11px] font-medium text-gray-800 dark:text-gray-100 text-center leading-relaxed">
                          {sugerenciaActual?.texto}
                        </div>
                        <div className="flex flex-col gap-1.5 mt-1">
                          {guardianStudents.map((student, idx) => {
                            const nombre = student.displayName || student.name || student.username || `Estudiante ${idx + 1}`;
                            const shortName = nombre.split(' ').slice(0, 2).join(' '); // Solo primeros 2 nombres
                            return (
                              <motion.button
                                key={student.id || idx}
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSelectStudent(student);
                                }}
                                className="w-full px-3 py-2 text-[11px] font-semibold rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-md hover:from-indigo-600 hover:to-purple-600 transition-all"
                              >
                                👤 {shortName}
                              </motion.button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      /* === MENSAJE NORMAL === */
                      <div className="flex flex-col gap-2">
                        <div className="text-[11px] font-medium text-gray-800 dark:text-gray-100 text-left leading-relaxed whitespace-pre-line">
                          {sugerenciaActual?.texto}
                        </div>
                        {/* Botón para volver al selector si hay múltiples hijos */}
                        {user?.role === 'guardian' && guardianStudents.length > 1 && selectedStudentForAnalysis && (
                          <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleBackToSelector();
                            }}
                            className="w-full mt-1 px-2 py-1.5 text-[10px] font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 transition-all"
                          >
                            ← {language === 'es' ? 'Ver otro estudiante' : 'View another student'}
                          </motion.button>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Cola apuntando hacia la DERECHA (hacia el robot) */}
                  <div className="absolute top-4 -right-2 w-0 h-0 border-t-[10px] border-b-[10px] border-l-[10px] border-t-transparent border-b-transparent border-l-purple-300 dark:border-l-purple-600" />
                  <div className="absolute top-4 -right-1.5 w-0 h-0 border-t-[8px] border-b-[8px] border-l-[8px] border-t-transparent border-b-transparent border-l-white dark:border-l-gray-800" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Micro-burbuja SECUNDARIA (tips rotativos)
             Mostrar SOLO cuando NO está visible el globo principal para evitar "doble mensaje". */}
          <AnimatePresence>
            {!isLoading && !sugerenciaActual && extraTips.length > 0 && (
              <motion.div
                key={tipIndex}
                initial={{ opacity: 0, x: 10, y: 5 }}
                animate={{ opacity: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, x: 10, y: 5 }}
                transition={{ duration: 0.3 }}
                className="absolute top-2 right-full mr-4 w-48 z-40"
              >
                <div className="relative">
                  <div className="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/30 dark:to-pink-900/30 text-purple-800 dark:text-purple-200 border-2 border-purple-300/70 dark:border-purple-500 rounded-2xl px-3 py-1.5 text-[10px] font-medium shadow-lg flex items-center gap-2">
                    {extraTips[tipIndex].startsWith('📚') ? (
                      <Brain className="w-3 h-3 flex-shrink-0" />
                    ) : extraTips[tipIndex].startsWith('💡') || extraTips[tipIndex].startsWith('🎯') ? (
                      <Zap className="w-3 h-3 flex-shrink-0" />
                    ) : (
                      <Heart className="w-3 h-3 flex-shrink-0" />
                    )}
                    <span className="flex-1">{extraTips[tipIndex]}</span>
                  </div>
                  <div className="absolute top-1/2 -translate-y-1/2 -right-1.5 w-0 h-0 border-t-[6px] border-b-[6px] border-l-[6px] border-t-transparent border-b-transparent border-l-purple-300 dark:border-l-purple-500" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Partículas flotantes decorativas */}
          {[...Array(4)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute w-1 h-1 rounded-full bg-purple-300 opacity-50"
              style={{ top: `${20 + Math.random() * 50}%`, left: `${15 + Math.random() * 70}%` }}
              animate={{ y: [0, -12, 0], opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 2.5 + Math.random() * 1, repeat: Infinity, delay: Math.random() * 2 }}
            />
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
