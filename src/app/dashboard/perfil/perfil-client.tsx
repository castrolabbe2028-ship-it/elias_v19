"use client";

import { useLanguage } from '@/contexts/language-context';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UserCircle, UserCircle2, BarChart3, History as HistoryIcon, Download, Trash2, Edit3, Award, Percent, Newspaper, Network, FileQuestion, Upload, Camera, Shield, Crown, GraduationCap, CheckCircle, AlertTriangle, Users, BookOpen, Layers, School, Bell } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import type { UserProfile, SubjectProgress, EvaluationHistoryItem } from '@/lib/types';
import { useEffect, useState, useMemo } from 'react';
import { LocalStorageManager } from '@/lib/education-utils';
import { useRouter } from 'next/navigation';
import { useToast } from "@/hooks/use-toast";
import { cn } from '@/lib/utils';
import { userService, UserService } from '@/services/user.service';
import type { UserProfile as BackendUserProfile, Course, Subject } from '@/services/user.service';
import { getAllAvailableSubjects } from '@/lib/subjects-colors';
import { getSubjectsForCourse as getBooksSubjectsForCourse, getAllCourses as getAllBooksCourses } from '@/lib/books-data';
import { contentDB } from '@/lib/sql-content';
import MonitoCalificaciones from '@/components/monito-calificaciones';

// Interface para información académica del estudiante
interface StudentCourseInfo {
  courseName: string;
  sectionName: string;
  subjects: string[];
  hasAssignment: boolean;
}

// Mock Data - UserProfile actualizado para nueva estructura
const userProfileData: UserProfile = {
  name: "Felipe",
  roleKey: "profileRoleStudent",
  activeCourses: [], 
  subjects: [
    { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
    { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
    { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" }, 
    { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" }, 
  ],
  evaluationsCompleted: 0, // This will be updated by history length
};

// Template for learning stats structure with specific subject colors (now gradients)
const learningStatsTemplate: SubjectProgress[] = [
  { nameKey: "subjectMath", progress: 0, colorClass: "bg-gradient-to-r from-blue-300 via-blue-400 to-blue-600" },
  { nameKey: "subjectScience", progress: 0, colorClass: "bg-gradient-to-r from-green-300 via-green-400 to-green-600" },
  { nameKey: "subjectHistory", progress: 0, colorClass: "bg-gradient-to-r from-amber-300 via-amber-400 to-amber-600" }, 
  { nameKey: "subjectLanguage", progress: 0, colorClass: "bg-gradient-to-r from-red-300 via-red-400 to-red-600" },
  { nameKey: "subjectPhysics", progress: 0, colorClass: "bg-gradient-to-r from-purple-300 via-purple-400 to-purple-600" },
  { nameKey: "subjectChemistry", progress: 0, colorClass: "bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-600" },
  { nameKey: "subjectBiology", progress: 0, colorClass: "bg-gradient-to-r from-teal-300 via-teal-400 to-teal-600" },
  { nameKey: "subjectEnglish", progress: 0, colorClass: "bg-gradient-to-r from-indigo-300 via-indigo-400 to-indigo-600" },
];

// Template for profile stats cards
const profileStatsCardsTemplate = [
    { value: "0", labelKey: "statEvals", colorClass: "bg-gradient-to-r from-purple-500 to-purple-600", bgClass: "from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20", icon: Award }, 
    { value: "0%", labelKey: "statAvgScore", colorClass: "bg-gradient-to-r from-emerald-500 to-emerald-600", bgClass: "from-emerald-50 to-emerald-100 dark:from-emerald-900/20 dark:to-emerald-800/20", icon: Percent }, 
    { value: "0", labelKey: "statSummaries", colorClass: "bg-gradient-to-r from-blue-500 to-blue-600", bgClass: "from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20", icon: Newspaper },
    { value: "0", labelKey: "statMaps", colorClass: "bg-gradient-to-r from-amber-500 to-amber-600", bgClass: "from-amber-50 to-amber-100 dark:from-amber-900/20 dark:to-amber-800/20", icon: Network },
    { value: "0", labelKey: "statQuizzes", colorClass: "bg-gradient-to-r from-cyan-500 to-cyan-600", bgClass: "from-cyan-50 to-cyan-100 dark:from-cyan-900/20 dark:to-cyan-800/20", icon: FileQuestion },
];

export default function PerfilClient() {
  const { translate, language } = useLanguage();
  const { user, refreshUser } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [evaluationHistory, setEvaluationHistory] = useState<EvaluationHistoryItem[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);

  const [dynamicLearningStats, setDynamicLearningStats] = useState<SubjectProgress[]>(learningStatsTemplate);
  const [dynamicProfileCards, setDynamicProfileCards] = useState(profileStatsCardsTemplate);
  
  // Crear perfil dinámico basado en el usuario autenticado
  const [dynamicUserProfileData, setDynamicUserProfileData] = useState<UserProfile>(userProfileData);

  // Estado para imagen de perfil
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);

  // Estados para edición de perfil
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [editingEmail, setEditingEmail] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  
  // 🔄 Estado para forzar actualización cuando cambien los datos de gestión
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // 📧 Estado para notificaciones por email
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(false);
  const [isSavingNotificationPref, setIsSavingNotificationPref] = useState(false);

  // Cargar preferencia de notificaciones al montar
  useEffect(() => {
    if (user?.id) {
      const savedPref = localStorage.getItem(`emailNotifications_${user.id}`);
      setEmailNotificationsEnabled(savedPref === 'true');
    }
  }, [user?.id]);

  // Función para manejar el cambio de preferencia de notificaciones
  const handleEmailNotificationToggle = async (enabled: boolean) => {
    if (!user?.id) return;
    
    setIsSavingNotificationPref(true);
    try {
      // Guardar en localStorage
      localStorage.setItem(`emailNotifications_${user.id}`, String(enabled));
      
      // Guardar en el backend/Firebase (si existe el servicio)
      try {
        await userService.updateUserEmailNotificationPreference(user.id, enabled, user.email || '');
      } catch (backendError) {
        console.log('Backend update optional:', backendError);
      }
      
      setEmailNotificationsEnabled(enabled);
      toast({
        title: enabled ? translate('profileEmailNotificationsEnabled') : translate('profileEmailNotificationsDisabled'),
        description: enabled 
          ? translate('profileEmailNotificationsEnabledDesc') 
          : translate('profileEmailNotificationsDisabledDesc'),
        variant: 'default',
      });
    } catch (error) {
      console.error('Error saving notification preference:', error);
      toast({
        title: translate('profileSaveError'),
        description: translate('profileSaveErrorDesc'),
        variant: 'destructive',
      });
    } finally {
      setIsSavingNotificationPref(false);
    }
  };

  // Fallback: si en producción no existen datos de gestión en localStorage, intentar poblar desde la API mock
  useEffect(() => {
    if (!user) return;
    try {
      const storedUsersRaw = localStorage.getItem('smart-student-users');
      let users: any[] = [];
      try { users = storedUsersRaw ? JSON.parse(storedUsersRaw) : []; } catch {}
      const exists = Array.isArray(users) && users.some(u => u?.username === user.username);
      const needsSubjects = (() => {
        if (!exists) return true;
        const u = users.find(u => u.username === user.username);
        return !(u?.teachingSubjects?.length || u?.courseSubjectAssignments?.length || u?.teachingAssignments?.length);
      })();
      if (!exists || needsSubjects) {
        // Obtener del backend mock para enriquecer (solo lectura)
        fetch(`/api/users/${encodeURIComponent(user.username)}/profile`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then((apiUser) => {
            if (!apiUser) return;
            // Encontrar usuario existente para preservar displayName y email editados
            const existingUser = users.find(u => u.username === user.username);
            // Merge preservando displayName y email del usuario existente si fueron editados
            const merged = { 
              ...apiUser,
              // Preservar displayName y email editados por el usuario
              displayName: existingUser?.displayName || apiUser.displayName,
              email: existingUser?.email || apiUser.email
            };
            const next = exists
              ? users.map(u => u.username === user.username ? { ...u, ...merged, displayName: u.displayName || merged.displayName, email: u.email || merged.email } : u)
              : [...users, merged];
            try { localStorage.setItem('smart-student-users', JSON.stringify(next)); } catch {}
            setRefreshTrigger(t => t + 1);
          })
          .catch(() => { /* noop */ });
      }
    } catch { /* noop */ }
  }, [user?.username]);

  // Función para renderizar el badge del rol (idéntico al UserRoleBadge)
  const renderRoleBadge = () => {
    if (!user) return null;

    const roleConfig = {
      admin: {
        labelKey: 'adminRole',
        variant: 'outline' as const,
        className: 'bg-red-100 text-red-800 border-red-200 hover:bg-red-100 hover:text-red-800',
        icon: Crown,
        iconClassName: 'text-red-700'
      },
      teacher: {
        labelKey: 'teacherRole',
        variant: 'outline' as const,
        className: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100 hover:text-blue-800',
        icon: Shield,
        iconClassName: 'text-blue-700'
      },
      student: {
        labelKey: 'studentRole',
        variant: 'outline' as const,
        className: 'bg-green-100 text-green-800 border-green-200 hover:bg-green-100 hover:text-green-800',
        icon: GraduationCap,
        iconClassName: 'text-green-700'
      },
      guardian: {
        labelKey: 'guardianRole',
        variant: 'outline' as const,
        className: 'bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-100 hover:text-purple-800',
        icon: Users,
        iconClassName: 'text-purple-700'
      }
    };

    // Normalizar clave de rol al conjunto esperado
    const roleKey: 'admin' | 'teacher' | 'student' | 'guardian' =
      user.role === 'admin' ? 'admin' : user.role === 'teacher' ? 'teacher' : user.role === 'guardian' ? 'guardian' : 'student';
    const config = roleConfig[roleKey];
    if (!config) return null;

    const IconComponent = config.icon;

    return (
      <Badge 
        variant={config.variant}
        className={`${config.className} text-xs font-medium px-2 py-1 inline-flex items-center gap-1.5`}
      >
        <IconComponent className={`w-3 h-3 flex-shrink-0 ${config.iconClassName}`} />
        {translate(config.labelKey)}
      </Badge>
    );
  };

  // Function to translate book titles based on current language
  const translateBookTitle = (bookTitle: string): string => {
    try {
      if (!bookTitle || typeof bookTitle !== 'string') {
        return bookTitle || '';
      }

      if (language === 'en') {
        // Map of Spanish book titles to English translations
        const bookTranslations: Record<string, string> = {
          'Ciencias Naturales': 'Natural Sciences',
          'Historia, Geografía y Ciencias Sociales': 'History, Geography and Social Sciences',
          'Lenguaje y Comunicación': 'Language and Communication',
          'Matemáticas': 'Mathematics',
          'Ciencias para la Ciudadanía': 'Science for Citizenship',
          'Biología': 'Biology',
          'Física': 'Physics',
          'Química': 'Chemistry',
          'Historia': 'History',
          'Inglés': 'English',
          'Educación Física': 'Physical Education',
          'Artes Visuales': 'Visual Arts',
          'Música': 'Music',
          'Tecnología': 'Technology',
          'Religión': 'Religion',
          'Orientación': 'Guidance'
        };

        // Try to find exact match first
        if (bookTranslations[bookTitle]) {
          return bookTranslations[bookTitle];
        }

        // For composite titles like "Ciencias Naturales 1ro Básico"
        for (const [spanish, english] of Object.entries(bookTranslations)) {
          if (bookTitle.includes(spanish)) {
            return bookTitle.replace(spanish, english);
          }
        }
      }
      
      return bookTitle; // Return original if no translation found or if in Spanish
    } catch (error) {
      console.error("Error translating book title:", error);
      return bookTitle || '';
    }
  };

  // Función auxiliar para obtener las estadísticas filtradas por curso
  const getFilteredLearningStats = () => {
    // Resolver nombre de curso contra catálogo de libros (tolerante a acentos/secciones)
    const resolveCourseNameForBooks = (input: string): string | null => {
      if (!input || typeof input !== 'string') return null;
      const stripSection = (s: string) => s.split(' - ')[0];
      const norm = (s: string) => s
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const target = norm(stripSection(input));
      try {
        const all = getAllBooksCourses() as string[];
        // Prefer exact first, luego normalizado
        if (all.includes(stripSection(input))) return stripSection(input);
        const found = all.find(c => norm(c) === target);
        return found || null;
      } catch {
        return stripSection(input);
      }
    };
    if (!user) return [];
    
    // Obtener datos actualizados del usuario desde localStorage
    let updatedUserData = user;
    let fullUserData: any = null;
    try {
      const storedUsers = localStorage.getItem('smart-student-users');
      if (storedUsers) {
        const usersData = JSON.parse(storedUsers);
        const currentUserData = usersData.find((u: any) => u.username === user.username);
        if (currentUserData) {
          fullUserData = currentUserData;
          updatedUserData = {
            ...user,
            activeCourses: currentUserData.activeCourses || [],
            ...(currentUserData.activeCourseNames && { activeCourseNames: currentUserData.activeCourseNames })
          } as any;
        }
      }
    } catch (error) {
      console.error("Error loading updated user data:", error);
    }

    // Mapeo común de nombres de asignaturas (del sistema de libros) a keys de locales
    const mapNameToKey: Record<string, string> = {
      'Matemáticas': 'subjectMath',
      'Ciencias Naturales': 'subjectScience',
      'Historia, Geografía y Ciencias Sociales': 'subjectHistory',
      'Lenguaje y Comunicación': 'subjectLanguage',
      'Física': 'subjectPhysics',
      'Química': 'subjectChemistry',
      'Biología': 'subjectBiology',
      'Inglés': 'subjectEnglish',
      'Ciencias para la Ciudadanía': 'subjectScience', // se agrupa bajo Ciencia
      'Educación Ciudadana': 'subjectHistory', // se agrupa bajo Historia/CIENCIAS SOCIALES
      'Filosofía': 'subjectHistory' // agrupación por sociales
    };

    // Si es profesor: usar sus asignaturas reales para filtrar el template
    try {
      if ((updatedUserData as any).role === 'teacher') {
        // 1) Intentar desde smart-student-teacher-assignments
        const assignments = JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]');
        const teacherId = fullUserData?.id || (updatedUserData as any).id;
        const teacherAssigns = Array.isArray(assignments) ? assignments.filter((a: any) => a.teacherId === teacherId) : [];
        const subjectsFromAssignments = new Set<string>();
        teacherAssigns.forEach((a: any) => { if (a?.subjectName) subjectsFromAssignments.add(String(a.subjectName)); });

        // 2) Fallback: teachingSubjects, courseSubjectAssignments o teachingAssignments
        if (subjectsFromAssignments.size === 0 && fullUserData) {
          if (Array.isArray(fullUserData.teachingSubjects)) {
            fullUserData.teachingSubjects.forEach((s: string) => subjectsFromAssignments.add(String(s)));
          }
          if (Array.isArray(fullUserData.courseSubjectAssignments)) {
            fullUserData.courseSubjectAssignments.forEach((csa: any) => {
              (csa?.subjects || []).forEach((s: string) => subjectsFromAssignments.add(String(s)));
            });
          }
          if (Array.isArray(fullUserData.teachingAssignments)) {
            fullUserData.teachingAssignments.forEach((ta: any) => {
              if (ta?.subject) subjectsFromAssignments.add(String(ta.subject));
            });
          }
        }

        const subjectsArray = Array.from(subjectsFromAssignments);
        const subjectKeys = subjectsArray.map((name) => mapNameToKey[name]).filter(Boolean);

        if (subjectKeys.length > 0) {
          const selected = learningStatsTemplate.filter((t) => subjectKeys.includes(t.nameKey));
          // adjuntar nombres reales como label para renderizar
          const withLabels = selected.map((t) => {
            const idx = subjectKeys.indexOf(t.nameKey);
            const realName = subjectsArray[idx] || undefined;
            return { ...t, label: realName };
          });
          return withLabels;
        }
        // si no hay asignaturas detectadas, continuar con lógica por curso
      }
    } catch (err) {
      console.warn('No se pudo determinar asignaturas del profesor para Aprendizaje, usando fallback por curso.', err);
    }

    // Obtener el curso actual (priorizar nombres reales)
    let currentCourse = '';
    if ((updatedUserData as any).role === 'student') {
      // Preferir curso/sección reales desde gestión
      try {
        const info = getStudentCourseInfo(fullUserData || updatedUserData);
        if (info?.courseName) currentCourse = info.courseName;
      } catch {}
      // Fallback: convertir id a nombre si es necesario
      if (!currentCourse) {
        const ac = (fullUserData?.activeCourses || (updatedUserData as any)?.activeCourses || []) as string[];
        if (ac.length > 0) {
          currentCourse = getCourseNameById(ac[0]);
        }
      }
    } else {
      currentCourse = (updatedUserData as any).activeCourseNames && (updatedUserData as any).activeCourseNames.length > 0 
        ? (updatedUserData as any).activeCourseNames[0]
        : updatedUserData.activeCourses && updatedUserData.activeCourses.length > 0 
          ? updatedUserData.activeCourses[0] 
        : '';
    }

    // Función para obtener asignaturas según el curso
    const getSubjectsForCourse = (course: string) => {
      // Asignaturas para cursos básicos (1ro a 8vo Básico)
      if (!course || course.includes('Básico')) {
        return [
          { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
          { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
          { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" }, 
          { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" }, 
        ];
      }
      
      // Asignaturas para cursos medios (1ro a 4to Medio)
      if (course.includes('Medio')) {
        return [
          { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
          { tag: "FIS", nameKey: "subjectPhysics", colorClass: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300" },
          { tag: "QUI", nameKey: "subjectChemistry", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
          { tag: "BIO", nameKey: "subjectBiology", colorClass: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300" },
          { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" }, 
          { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
          { tag: "ING", nameKey: "subjectEnglish", colorClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300" },
        ];
      }
      
      // Si no se reconoce el tipo de curso, devolver asignaturas por defecto
      return [
        { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
        { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
        { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" }, 
        { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" }, 
      ];
    };

    // Estudiante: intentar derivar asignaturas REALES desde libros para el curso actual
    try {
  const resolvedCourse = resolveCourseNameForBooks(currentCourse) || currentCourse;
  const subjectsFromBooks = getBooksSubjectsForCourse(resolvedCourse) as string[];
      const subjectKeys = Array.isArray(subjectsFromBooks) ? subjectsFromBooks.map((n) => mapNameToKey[n]).filter(Boolean) : [];
      if (subjectKeys.length > 0) {
        const selected = learningStatsTemplate.filter((t) => subjectKeys.includes(t.nameKey));
        const withLabels = selected.map((t) => {
          const idx = subjectKeys.indexOf(t.nameKey);
          const realName = subjectsFromBooks[idx] || undefined;
          return { ...t, label: realName };
        });
        return withLabels;
      }
    } catch (e) {
      console.warn('No se pudieron obtener asignaturas desde libros para el curso', currentCourse, e);
    }

    // Fallback: usar conjuntos genéricos por nivel si no se pudo mapear por libros
    const userSubjects = getSubjectsForCourse(currentCourse);
    const userSubjectKeys = userSubjects.map(subject => subject.nameKey);
    return learningStatsTemplate.filter(statTemplate => userSubjectKeys.includes(statTemplate.nameKey));
  };

  // ✨ FUNCIÓN PARA CONVERTIR IDS A NOMBRES DE CURSO ✨
  const convertCourseIdToName = (courseId: string): string => {
    if (!courseId) return courseId;
    
    // Si ya es un nombre legible (no contiene guiones ni números largos), devolverlo tal como está
    if (!courseId.includes('-') && !courseId.match(/\d{10,}/)) {
      return courseId;
    }
    
    console.log('🔄 [CONVERSIÓN] Convirtiendo ID:', courseId);
    
    // Mapeo de patrones comunes de IDs a nombres de curso
    const courseMapping: Record<string, string> = {
      // Patrones para identificar cursos básicos
      '1ro-basico': '1ro Básico',
      '2do-basico': '2do Básico', 
      '3ro-basico': '3ro Básico',
      '4to-basico': '4to Básico',
      '5to-basico': '5to Básico',
      '6to-basico': '6to Básico',
      '7mo-basico': '7mo Básico',
      '8vo-basico': '8vo Básico',
      // Patrones para identificar cursos medios
      '1ro-medio': '1ro Medio',
      '2do-medio': '2do Medio',
      '3ro-medio': '3ro Medio', 
      '4to-medio': '4to Medio',
    };

    // Buscar patrones en el ID
    const lowerCourseId = courseId.toLowerCase();
    for (const [pattern, name] of Object.entries(courseMapping)) {
      if (lowerCourseId.includes(pattern)) {
        console.log('✅ [CONVERSIÓN] Encontrado patrón:', pattern, '->', name);
        return name;
      }
    }

    // Si contiene números, intentar extraer el nivel
    const basicMatch = courseId.match(/(\d+).*b[aá]sico/i);
    if (basicMatch) {
      const num = parseInt(basicMatch[1]);
      const ordinals = ['', '1ro', '2do', '3ro', '4to', '5to', '6to', '7mo', '8vo'];
      const result = `${ordinals[num] || num + 'to'} Básico`;
      console.log('✅ [CONVERSIÓN] Extraído de número básico:', result);
      return result;
    }

    const medioMatch = courseId.match(/(\d+).*medio/i);
    if (medioMatch) {
      const num = parseInt(medioMatch[1]);
      const ordinals = ['', '1ro', '2do', '3ro', '4to'];
      const result = `${ordinals[num] || num + 'to'} Medio`;
      console.log('✅ [CONVERSIÓN] Extraído de número medio:', result);
      return result;
    }

    // Casos especiales para IDs largos como 'id-1753226643520-0g1a322hy'
    if (courseId.length > 15 && courseId.includes('-')) {
      const parts = courseId.split('-');
      const lastPart = parts[parts.length - 1];
      
      console.log('🔍 [CONVERSIÓN] Analizando ID largo. Última parte:', lastPart);
      
      // Intentar deducir de patrones en la última parte
      if (lastPart.includes('1') && lastPart.includes('a')) {
        console.log('✅ [CONVERSIÓN] Deducido como 1ro Básico por patrón 1a');
        return '1ro Básico';
      }
      if (lastPart.includes('2') && lastPart.includes('a')) {
        return '2do Básico';
      }
      if (lastPart.includes('3') && lastPart.includes('a')) {
        return '3ro Básico';
      }
      
      // Si no se puede deducir específicamente, usar un nombre genérico pero descriptivo
      console.log('⚠️ [CONVERSIÓN] No se pudo deducir nivel específico, usando genérico');
      return translate('profileCourseAssigned');
    }

    console.log('❌ [CONVERSIÓN] No se pudo convertir, manteniendo original');
    return courseId; // Devolver el original si no se puede convertir
  };

  // ✨ FUNCIÓN PARA OBTENER NOMBRES DE CURSOS POR ID ✨
  const getCourseNameById = (courseId: string): string => {
    try {
      const storedCourses = localStorage.getItem('smart-student-courses');
      if (!storedCourses) return courseId; // Devuelve el ID si no hay cursos

      const coursesData = JSON.parse(storedCourses);
      const course = coursesData.find((c: any) => c.id === courseId);

      return course ? course.name : courseId; // Devuelve el nombre si lo encuentra
    } catch {
      return courseId; // En caso de error, devuelve el ID
    }
  };

  // ✨ FUNCIÓN PARA CONTAR ESTUDIANTES POR CURSO Y PROFESOR - VERSIÓN CORREGIDA ✨
  const getStudentCountForCourse = (courseName: string): number => {
    try {
      const storedUsers = localStorage.getItem('smart-student-users');
      const storedCourses = localStorage.getItem('smart-student-courses');
      if (!storedUsers || !storedCourses || !user) return 0;

      const usersData = JSON.parse(storedUsers);
      const coursesData = JSON.parse(storedCourses);

      // 1. Busca el curso en la lista para obtener su ID
      const course = coursesData.find((c: any) => c.name === courseName);
      const courseId = course ? course.id : null;

      if (!courseId) {
        console.warn(`[Contador] No se encontró un ID para el curso "${courseName}". El conteo podría ser 0.`);
      }

      // 2. Filtra los estudiantes que coincidan por NOMBRE o por ID Y que estén asignados a ESTE profesor
      const studentCount = usersData.filter((userData: any) => {
        if (userData.role !== 'student' || !Array.isArray(userData.activeCourses)) {
          return false;
        }
        
        // Verificar si el estudiante está en este curso
        const isInCourse = userData.activeCourses.includes(courseName) || (courseId && userData.activeCourses.includes(courseId));
        
        // Verificar si el estudiante está asignado a ESTE profesor específico
        const isAssignedToThisTeacher = userData.assignedTeacherId === user.id;
        
        return isInCourse && isAssignedToThisTeacher;
      }).length;

      console.log(`[Contador] Estudiantes encontrados para "${courseName}" (ID: ${courseId}) asignados al profesor ${user.displayName} (ID: ${user.id}): ${studentCount}`);
      return studentCount;

    } catch (error) {
      console.error(`Error al contar estudiantes para el curso ${courseName}:`, error);
      return 0;
    }
  };

  // Ensure this only runs on client-side
  useEffect(() => {
    setMounted(true);
    setLoading(false);
  }, []);

  // Initialize learning stats with filtered template when component mounts
  useEffect(() => {
    if (!mounted || !user) return;
    
    // Set initial learning stats filtered by user's course
    const filteredTemplate = getFilteredLearningStats();
    if (filteredTemplate.length > 0) {
      setDynamicLearningStats(filteredTemplate);
    }
  }, [mounted, user]);

  useEffect(() => {
    if (!mounted) return;
    
    try {
      // Preferir historial por usuario; fallback a historial global si existe
      const userHistoryKey = user?.username ? `evaluationHistory_${user.username}` : null;
      const storedUserHistoryString = userHistoryKey ? localStorage.getItem(userHistoryKey) : null;
      const storedGlobalHistoryString = localStorage.getItem('evaluationHistory');

      const source = storedUserHistoryString ?? storedGlobalHistoryString;

      if (source) {
        try {
          const storedHistory: EvaluationHistoryItem[] = JSON.parse(source);
          setEvaluationHistory(Array.isArray(storedHistory) ? storedHistory : []);
        } catch (error) {
          console.error("Failed to parse evaluation history from localStorage:", error);
          setEvaluationHistory([]); 
        }
      }

      // Cargar contadores desde la BD (Supabase o IndexedDB); fallback a LocalStorage si falla
      (async () => {
        try {
          const uname = user?.username || null;
          const counts = await contentDB.countByUsername(uname);
          setDynamicProfileCards(prevCards => prevCards.map(card => {
            if (card.labelKey === 'statSummaries') return { ...card, value: String(counts.summaries) };
            if (card.labelKey === 'statMaps') return { ...card, value: String(counts.maps) };
            if (card.labelKey === 'statQuizzes') return { ...card, value: String(counts.quizzes) };
            return card;
          }));
        } catch (e) {
          const summariesCount = localStorage.getItem('summariesCreatedCount') || '0';
          const mapsCount = localStorage.getItem('mapsCreatedCount') || '0';
          const quizzesCount = localStorage.getItem('quizzesCreatedCount') || '0';
          setDynamicProfileCards(prevCards => prevCards.map(card => {
            if (card.labelKey === 'statSummaries') return { ...card, value: summariesCount };
            if (card.labelKey === 'statMaps') return { ...card, value: mapsCount };
            if (card.labelKey === 'statQuizzes') return { ...card, value: quizzesCount };
            return card;
          }));
        }
      })();
    } catch (error) {
      console.error("Error accessing localStorage:", error);
    }

  }, [mounted, user?.username, refreshTrigger]);

  useEffect(() => {
    if (!mounted || !user) return;
    
    const subjectMappings: Record<string, { es: string[], en: string[] }> = {
      subjectScience: {
        es: ["Ciencias", "Ciencias Naturales", "Ciencias para la Ciudadanía"],
        en: ["Science", "Natural Sciences", "Science for Citizenship"]
      },
      subjectHistory: {
        es: ["Historia", "Historia, Geografía y Ciencias Sociales", "Educación Ciudadana", "Filosofía"],
        en: ["History", "History, Geography and Social Sciences", "Civic Education", "Philosophy"]
      },
      subjectLanguage: {
        es: ["Lenguaje", "Lenguaje y Comunicación", "Lengua y Literatura"],
        en: ["Language", "Language and Communication", "Language and Literature"]
      },
      subjectMath: {
        es: ["Matemáticas"],
        en: ["Mathematics"]
      },
      subjectPhysics: {
        es: ["Física"],
        en: ["Physics"]
      },
      subjectChemistry: {
        es: ["Química"],
        en: ["Chemistry"]
      },
      subjectBiology: {
        es: ["Biología"],
        en: ["Biology"]
      },
      subjectEnglish: {
        es: ["Inglés"],
        en: ["English"]
      }
    };

    // Obtener el template filtrado según el curso del usuario
    const filteredTemplate = getFilteredLearningStats();

    const newLearningStats = filteredTemplate.map(statTemplate => {
      const categoryKey = statTemplate.nameKey;
      let subjectEvaluations: EvaluationHistoryItem[] = [];

      if (subjectMappings[categoryKey]) {
        const currentLangSubjectNames = subjectMappings[categoryKey][language] || [];
        const otherLang = language === 'es' ? 'en' : 'es';
        const otherLangSubjectNames = subjectMappings[categoryKey][otherLang] || [];
        
        const titlesToMatch = [
          ...currentLangSubjectNames,
          ...otherLangSubjectNames
        ].map(title => title.toLowerCase());

        subjectEvaluations = evaluationHistory.filter(histItem => 
          titlesToMatch.includes(histItem.bookTitle.toLowerCase())
        );
      }
      
      let maxPercentage = 0;
      if (subjectEvaluations.length > 0) {
        subjectEvaluations.forEach(ev => {
          const percentage = ev.totalQuestions > 0 ? (ev.score / ev.totalQuestions) * 100 : 0;
          if (percentage > maxPercentage) {
            maxPercentage = percentage;
          }
        });
      }
      // Si el template tiene label (nombre real) úsalo; si no, mantener nameKey
      return {
        ...statTemplate,
        progress: Math.round(maxPercentage),
      };
    });
    setDynamicLearningStats(newLearningStats);

    // KPIs: diferentes para estudiante vs profesor
    if (user.role === 'teacher') {
      try {
        const tasks: any[] = JSON.parse(localStorage.getItem('smart-student-evaluations') || '[]');
        const results: any[] = JSON.parse(localStorage.getItem('smart-student-evaluation-results') || '[]');
        const uid = String((user as any).id || '').toLowerCase();
        const uname = String((user as any).username || '').toLowerCase();
        // Obtener IDs de evaluaciones asignadas por el profesor
        const taskIds = new Set(
          tasks
            .filter((t: any) => {
              const aid = String(t.assignedById || t.teacherId || t.ownerId || '').toLowerCase();
              const aname = String(t.assignedByName || t.teacherName || t.ownerUsername || '').toLowerCase();
              return aid === uid || aid === uname || aname === uname;
            })
            .map((t: any) => t.id)
        );

        // Filtrar resultados que correspondan a esas tareas
        const teacherResults = Array.isArray(results)
          ? results.filter((r: any) => taskIds.has(r.taskId))
          : [];

        const evalsCount = teacherResults.length;
        const avgPct = evalsCount > 0
          ? Math.round(
              teacherResults.reduce((acc: number, r: any) => acc + (Number(r.percentage) || 0), 0) / evalsCount
            )
          : 0;

        setDynamicProfileCards(prev => prev.map(card => {
          if (card.labelKey === 'statEvals') return { ...card, value: String(evalsCount) };
          if (card.labelKey === 'statAvgScore') return { ...card, value: `${avgPct}%` };
          return card;
        }));
      } catch (err) {
        console.warn('No se pudieron calcular KPIs de profesor, usando 0 por defecto.', err);
        setDynamicProfileCards(prev => prev.map(card => {
          if (card.labelKey === 'statEvals') return { ...card, value: '0' };
          if (card.labelKey === 'statAvgScore') return { ...card, value: '0%' };
          return card;
        }));
      }
    } else {
      // Estudiante: usar su propio historial
      let totalScoreSum = 0;
      let totalPossibleScoreSum = 0;
      evaluationHistory.forEach(item => {
        totalScoreSum += item.score;
        totalPossibleScoreSum += item.totalQuestions;
      });
      const averageScorePercentage = totalPossibleScoreSum > 0 
        ? Math.round((totalScoreSum / totalPossibleScoreSum) * 100) 
        : 0;

      setDynamicProfileCards(prev => prev.map(card => {
        if (card.labelKey === 'statEvals') {
          return { ...card, value: evaluationHistory.length.toString() };
        }
        if (card.labelKey === 'statAvgScore') {
          return { ...card, value: `${averageScorePercentage}%` };
        }
        return card; 
      }));
    }

  }, [evaluationHistory, language, translate, mounted, user]);

  // 🔄 LISTENER PARA CAMBIOS EN GESTIÓN DE USUARIOS - ACTUALIZACIÓN DINÁMICA
  useEffect(() => {
    if (!mounted || !user) return;

    const handleStorageChange = (e: StorageEvent) => {
      // Solo reaccionar a cambios en datos relevantes
      if (e.key && [
        'smart-student-users',
        'smart-student-student-assignments', 
        'smart-student-teacher-assignments',
        'smart-student-courses',
        'smart-student-sections',
        // 🔔 También escuchar cambios de contadores de herramientas
        'summariesCreatedCount',
        'mapsCreatedCount',
        'quizzesCreatedCount',
        // Historial de evaluaciones por usuario (para KPIs y conteo)
        user?.username ? `evaluationHistory_${user.username}` : 'evaluationHistory'
      ].includes(e.key)) {
        console.log('🔄 Detectado cambio en gestión de usuarios:', e.key);
        setRefreshTrigger(prev => prev + 1);
      }
    };

    // También escuchar cambios manuales (mismo origen)
    const handleCustomStorageChange = () => {
      setRefreshTrigger(prev => prev + 1);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageUpdate', handleCustomStorageChange);
    // Escuchar un evento personalizado emitido por herramientas (resumen/mapa/cuestionario)
    const handleToolCountersUpdated = () => setRefreshTrigger(prev => prev + 1);
    window.addEventListener('toolCountersUpdated', handleToolCountersUpdated as any);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageUpdate', handleCustomStorageChange);
      window.removeEventListener('toolCountersUpdated', handleToolCountersUpdated as any);
    };
  }, [mounted, user]);

  // ✨ FUNCIÓN PARA OBTENER INFORMACIÓN COMPLETA DEL PROFESOR COMO EN GESTIÓN DE USUARIOS ✨
  const getTeacherAssignmentsInfo = (fullUserData: any) => {
    if (!fullUserData || fullUserData.role !== 'teacher') return null;

    try {
      console.log('🔍 Analizando datos del profesor:', fullUserData.username);

      // Buscar asignaciones en el sistema de gestión de usuarios (teacher-assignments) del año actual
      const year = new Date().getFullYear();
      const assignments = LocalStorageManager.getTeacherAssignmentsForYear(year) || [];
      const courses = LocalStorageManager.getCoursesForYear(year) || [];
      const sections = LocalStorageManager.getSectionsForYear(year) || [];

      console.log('📊 Datos del sistema:', { 
        assignments: assignments.length, 
        courses: courses.length, 
        sections: sections.length,
        teacherId: fullUserData.id 
      });

      // Buscar asignaciones por ID del profesor
      const teacherAssignments = assignments.filter((assignment: any) => 
        assignment.teacherId === fullUserData.id
      );

      console.log('📋 Asignaciones encontradas:', teacherAssignments);

      if (teacherAssignments.length > 0) {
        // Agrupar asignaciones por sección
        const sectionGroups: any = {};
        const allSubjects = new Set<string>();

        teacherAssignments.forEach((assignment: any) => {
          const section = sections.find((s: any) => s.id === assignment.sectionId);
          
          console.log('🔍 Procesando asignación:', { 
            sectionId: assignment.sectionId,
            section: section?.name,
            subject: assignment.subjectName
          });
          
          if (section) {
            // Buscar el curso de esta sección
            const course = courses.find((c: any) => c.id === section.courseId);
            
            const sectionKey = assignment.sectionId;
            
            if (!sectionGroups[sectionKey]) {
              sectionGroups[sectionKey] = {
                courseName: course?.name || 'Curso no encontrado',
                sectionName: section.name,
                subjects: []
              };
            }
            
            // Agregar la asignatura si no está ya en la lista
            if (!sectionGroups[sectionKey].subjects.includes(assignment.subjectName)) {
              sectionGroups[sectionKey].subjects.push(assignment.subjectName);
            }
            
            allSubjects.add(assignment.subjectName);
          }
        });

        console.log('✅ Asignaciones agrupadas:', sectionGroups);
        console.log('📚 Todas las asignaturas:', Array.from(allSubjects));

        return {
          hasAssignments: true,
          assignments: sectionGroups,
          subjects: Array.from(allSubjects)
        };
      }

      // Si no hay asignaciones en el sistema, usar teachingAssignments del usuario como fallback
      console.log('⚠️ No se encontraron asignaciones en el sistema, usando fallback');
      
      if (fullUserData.teachingAssignments && Array.isArray(fullUserData.teachingAssignments) && fullUserData.teachingAssignments.length > 0) {
        console.log('✅ Usando teachingAssignments del usuario como fallback');
        
        const assignmentsInfo: any = {};
        const allSubjects = new Set<string>();

        fullUserData.teachingAssignments.forEach((assignment: any, index: number) => {
          const courseName = assignment.courses && assignment.courses.length > 0 ? assignment.courses[0] : '4to Básico';
          const subjectName = assignment.subject || 'Matemáticas';
          
          const key = `fallback-${index}`;
          assignmentsInfo[key] = {
            courseName: courseName,
            sectionName: 'A',
            subjects: [subjectName]
          };

          allSubjects.add(subjectName);
        });

        return {
          hasAssignments: true,
          assignments: assignmentsInfo,
          subjects: Array.from(allSubjects)
        };
      }

      // Último fallback: crear asignación por defecto
      console.log('⚠️ Creando asignación por defecto');
      return {
        hasAssignments: true,
        assignments: {
          'default-assignment': {
            courseName: '4to Básico',
            sectionName: 'A',
            subjects: ['Matemáticas']
          }
        },
        subjects: ['Matemáticas']
      };

    } catch (error) {
      console.error('Error al obtener asignaciones del profesor:', error);
      
      // Retornar asignación por defecto en caso de error
      return {
        hasAssignments: true,
        assignments: {
          'error-fallback': {
            courseName: '4to Básico',
            sectionName: 'A',
            subjects: ['Matemáticas']
          }
        },
        subjects: ['Matemáticas']
      };
    }
  };

  // ✨ FUNCIÓN AUXILIAR PARA OBTENER COLORES DE ASIGNATURAS ✨
  const getSubjectInfo = (subjectName: string) => {
    const subjects = getAllAvailableSubjects();
    const subject = subjects.find(s => s.name === subjectName);
    return {
      abbreviation: subject?.abbreviation || subjectName.substring(0, 3).toUpperCase(),
      bgColor: subject?.bgColor || '#e5e7eb',
      textColor: subject?.textColor || '#374151'
    };
  };

  // ✨ FUNCIÓN PARA OBTENER INFORMACIÓN DEL ESTUDIANTE (CURSO, SECCIÓN Y ASIGNATURAS) ✨
  // FUENTE DE VERDAD: Gestión de Usuarios (courseId, sectionId) y Cursos y Secciones (subjects por courseId)
  const getStudentCourseInfo = (fullUserData: any) => {
    if (!fullUserData || fullUserData.role !== 'student') return null;

    // Helper: obtener datasets considerando año actual (clave con sufijo -YYYY si existe)
    const getYearAwareData = (baseKey: string) => {
      const year = new Date().getFullYear();
      const withYear = localStorage.getItem(`${baseKey}-${year}`);
      const raw = withYear || localStorage.getItem(baseKey);
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    };

    // Cargar datasets principales (preferir año actual)
    const courses = getYearAwareData('smart-student-courses');
    const sections = getYearAwareData('smart-student-sections');
    const subjectsData = getYearAwareData('smart-student-subjects');
    const studentAssignments = getYearAwareData('smart-student-student-assignments');

    // Orden deseado para mostrar badges (si existen en el curso)
    const preferredOrder = [
      'Ciencias Naturales',
      'Historia, Geografía y Ciencias Sociales',
      'Lenguaje y Comunicación',
      'Matemáticas'
    ];

    // Obtener asignaturas desde estructura "Cursos y Secciones" (subjectsData) para un courseId
    const getSubjectsForCourseId = (courseId: string, courseName: string): string[] => {
      if (!courseId) return [];
      // subjectsData: array de objetos Subject con courseId
      const filtered = subjectsData.filter((s: any) => s.courseId === courseId);
  let names: string[] = filtered.map((s: any) => String(s.name)).filter(Boolean) as string[];
      // Si no hay subjects configurados, intentar fallback a libros
      if (names.length === 0 && courseName) {
        names = (getBooksSubjectsForCourse(courseName) || []);
      }
      // Reordenar según preferredOrder manteniendo el resto al final
  const ordered: string[] = [];
  preferredOrder.forEach((p: string) => { if (names.includes(p)) ordered.push(p); });
  names.forEach((n: string) => { if (!ordered.includes(n)) ordered.push(n); });
      return ordered;
    };

    try {
      console.log('[Perfil][Student] Analizando datos académico-estudiante:', {
        username: fullUserData.username,
        courseId: fullUserData.courseId,
        sectionId: fullUserData.sectionId
      });

      // 1. PRIORIDAD: courseId y sectionId directamente en el usuario (Gestión de Usuarios)
      if (fullUserData.courseId && fullUserData.sectionId) {
        const course = courses.find((c: any) => c.id === fullUserData.courseId);
        const section = sections.find((s: any) => s.id === fullUserData.sectionId);
        if (course && section) {
          const subjects = getSubjectsForCourseId(course.id, course.name);
          console.log('[Perfil][Student] Datos obtenidos por courseId/sectionId directos:', { course: course.name, section: section.name, subjects });
          return {
            courseName: course.name,
            sectionName: section.name,
            subjects,
            hasAssignment: true
          };
        }
      }

      // 2. PRIORIDAD: Buscar una asignación en studentAssignments
      const assignment = studentAssignments.find((a: any) => a.studentId === fullUserData.id);
      if (assignment) {
        const course = courses.find((c: any) => c.id === assignment.courseId);
        const section = sections.find((s: any) => s.id === assignment.sectionId);
        if (course && section) {
          const subjects = getSubjectsForCourseId(course.id, course.name);
          console.log('[Perfil][Student] Datos obtenidos por asignación:', { course: course.name, section: section.name, subjects });
          return {
            courseName: course.name,
            sectionName: section.name,
            subjects,
            hasAssignment: true
          };
        }
      }

      // 3. Fallback: parsear activeCourses estilo "1ro Básico - Sección A"
      if (Array.isArray(fullUserData.activeCourses) && fullUserData.activeCourses.length > 0) {
        let raw = fullUserData.activeCourses[0];
        if (typeof raw === 'string') {
          let courseName = raw;
          let sectionName = 'A';
          const m = raw.match(/^(.+?)\s*-\s*Sección\s*([A-Z])$/i);
          if (m) { courseName = m[1].trim(); sectionName = m[2].toUpperCase(); }
          const course = courses.find((c: any) => c.name === courseName);
          const section = course ? sections.find((s: any) => s.courseId === course.id && s.name === sectionName) : null;
          const subjects = course ? getSubjectsForCourseId(course.id, course.name) : [];
          console.log('[Perfil][Student] Fallback activeCourses:', { courseName, sectionName, subjects });
          return {
            courseName: courseName,
            sectionName: sectionName,
            subjects,
            hasAssignment: false
          };
        }
      }

      // 4. Último fallback: primer curso disponible del sistema
      if (courses.length > 0) {
        const fallbackCourse = courses[0];
        const fallbackSection = sections.find((s: any) => s.courseId === fallbackCourse.id) || { name: 'A' };
        const subjects = getSubjectsForCourseId(fallbackCourse.id, fallbackCourse.name);
        console.log('[Perfil][Student] Fallback primer curso del sistema:', { course: fallbackCourse.name, section: fallbackSection?.name, subjects });
        return {
          courseName: fallbackCourse.name,
          sectionName: fallbackSection.name,
          subjects,
          hasAssignment: false
        };
      }

      console.warn('[Perfil][Student] No se pudo determinar curso/sección/asignaturas');
      return null;
    } catch (e) {
      console.error('[Perfil][Student] Error en getStudentCourseInfo:', e);
      return null;
    }
  };

  // (Fin getStudentCourseInfo) — se eliminó lógica antigua basada sólo en nombres genéricos

  // ✨ ACTUALIZAR PERFIL CON CONVERSIÓN DE IDS A NOMBRES - VERSIÓN DEFINITIVA ✨

  useEffect(() => {
    if (!user || !mounted) return;

    const loadProfileData = () => {
      try {
        console.log(`[Perfil] Cargando datos para: ${user.username} (trigger: ${refreshTrigger})`);
        const storedUsers = localStorage.getItem('smart-student-users');
        
        // Si no hay datos en localStorage, usar datos por defecto del usuario actual
        if (!storedUsers) {
          console.warn("[Perfil] 'smart-student-users' no encontrado en localStorage. Usando datos por defecto.");
          
          // Configurar perfil básico con datos del usuario autenticado
          const defaultSubjects = [
            { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
            { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
            { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
            { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
          ];

          setDynamicUserProfileData({
            name: user.displayName || user.username,
            roleKey: user.role === 'teacher' ? 'profileRoleTeacher' : user.role === 'guardian' ? 'profileRoleGuardian' : 'profileRoleStudent',
            activeCourses: user.activeCourses || ['Sin curso asignado'],
            subjects: defaultSubjects,
            evaluationsCompleted: evaluationHistory.length,
          });
          
          console.log("[Perfil] Perfil configurado con datos por defecto");
          return;
        }

        const usersData = JSON.parse(storedUsers);
        const fullUserData = usersData.find((u: any) => u.username === user.username);

        // Si no se encuentra el usuario específico, usar datos por defecto
        if (!fullUserData) {
          console.warn(`[Perfil] Usuario "${user.username}" no encontrado en localStorage. Usando datos por defecto.`);
          
          const defaultSubjects = [
            { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
            { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
            { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
            { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
          ];

          setDynamicUserProfileData({
            name: user.displayName || user.username,
            roleKey: user.role === 'teacher' ? 'profileRoleTeacher' : user.role === 'guardian' ? 'profileRoleGuardian' : 'profileRoleStudent',
            activeCourses: user.activeCourses || ['Sin curso asignado'],
            subjects: defaultSubjects,
            evaluationsCompleted: evaluationHistory.length,
          });
          
          console.log("[Perfil] Perfil configurado con datos por defecto del usuario");
          return;
        }

        console.log("[Perfil] Datos completos del usuario encontrados:", fullUserData);

        // ✨ PASO CLAVE: DIFERENTE MANEJO PARA PROFESORES Y ESTUDIANTES ✨
        let activeCoursesWithCount;
        
  if (user.role === 'teacher') {
          // Para profesores: Usar activeCourses y teacherAssignments como antes
          const courseIds = fullUserData.activeCourses || [];
          const activeCourseNames = courseIds.map((id: string) => getCourseNameById(id));
          
          console.log("[Perfil] [PROFESOR] IDs de curso encontrados:", courseIds);
          console.log("[Perfil] [PROFESOR] Nombres de curso convertidos:", activeCourseNames);

          activeCoursesWithCount = activeCourseNames.map((name: string, index: number) => ({
            name: name,
            originalId: courseIds[index],
            studentCount: getStudentCountForCourse(name)
          }));
        } else if (user.role === 'student') {
          // Para estudiantes: Usar getStudentCourseInfo para datos académicos actualizados
          console.log("[Perfil] [ESTUDIANTE] Obteniendo datos académicos actualizados...");
          const studentCourseInfo = getStudentCourseInfo(fullUserData);
          
          if (studentCourseInfo && studentCourseInfo.hasAssignment) {
            console.log("[Perfil] [ESTUDIANTE] Datos académicos encontrados:", studentCourseInfo);
            activeCoursesWithCount = [`${studentCourseInfo.courseName} - ${studentCourseInfo.sectionName}`];
          } else {
            console.log("[Perfil] [ESTUDIANTE] No se encontraron datos académicos, usando fallback");
            // Fallback: usar activeCourses si existe
            const courseIds = fullUserData.activeCourses || [];
            const activeCourseNames = courseIds.map((id: string) => getCourseNameById(id));
            activeCoursesWithCount = activeCourseNames.length > 0 ? activeCourseNames : ['Por defecto'];
          }
        } else {
          // ADMIN: mostrar todos los cursos disponibles (nombres) como referencia
          const year = new Date().getFullYear();
          const courses = LocalStorageManager.getCoursesForYear(year) || [];
          activeCoursesWithCount = (courses || []).map((c: any) => c.name);
        }

        console.log("[Perfil] Cursos finales:", activeCoursesWithCount);

        // ✨ FUNCIÓN CRÍTICA: Determinar asignaturas específicas del usuario ✨
        const getUserSpecificSubjects = () => {
          // Mapeo de nombres de asignaturas a objetos con tags y colores
          const subjectNameToObject = {
            'Matemáticas': { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
            'Ciencias Naturales': { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
            'Historia, Geografía y Ciencias Sociales': { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
            'Lenguaje y Comunicación': { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
            'Física': { tag: "FIS", nameKey: "subjectPhysics", colorClass: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300" },
            'Química': { tag: "QUI", nameKey: "subjectChemistry", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
            'Biología': { tag: "BIO", nameKey: "subjectBiology", colorClass: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300" },
            'Inglés': { tag: "ING", nameKey: "subjectEnglish", colorClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300" },
          };

          let userSubjects = [];

          if (user.role === 'teacher') {
            // Para profesores: Mostrar TODAS las asignaturas de TODOS los cursos asignados
            if (fullUserData.courseSubjectAssignments && fullUserData.courseSubjectAssignments.length > 0) {
              // ✨ CORRECCIÓN: Tomar las asignaturas de TODOS los cursos asignados ✨
              const allAssignedSubjects = fullUserData.courseSubjectAssignments
                .flatMap((assignment: any) => assignment.subjects || []);
              
              // Eliminar duplicados y mapear a objetos con tags y colores
              const uniqueSubjects = [...new Set(allAssignedSubjects)];
              
              userSubjects = uniqueSubjects
                .map((subjectName: any) => subjectNameToObject[subjectName as keyof typeof subjectNameToObject])
                .filter((subject: any) => subject !== undefined);
                
            } else if (fullUserData.teachingSubjects && fullUserData.teachingSubjects.length > 0) {
              userSubjects = fullUserData.teachingSubjects
                .map((subjectName: string) => subjectNameToObject[subjectName as keyof typeof subjectNameToObject])
                .filter((subject: any) => subject !== undefined); // Filtrar asignaturas no reconocidas
            } else {
              // Fallback: usar asignaturas por defecto del primer curso
              const courseIds = (fullUserData?.activeCourses || (user as any)?.activeCourses || []) as string[];
              const firstCourse = courseIds.length > 0 ? getCourseNameById(courseIds[0]) : '';
              userSubjects = getSubjectsForCourse(firstCourse);
            }
          } else if (user.role === 'student') {
            // Para estudiantes: usar las asignaturas del curso asignado desde getStudentCourseInfo
            let studentCourse = '';
            const studentCourseInfo = getStudentCourseInfo(fullUserData);
            
            if (studentCourseInfo && studentCourseInfo.hasAssignment) {
              studentCourse = studentCourseInfo.courseName;
              console.log("[Perfil] [ESTUDIANTE] Curso asignado desde gestión:", studentCourse);
            } else {
              // Fallback: usar primer curso de activeCourses
              const fallbackCourses = Array.isArray(activeCoursesWithCount) && activeCoursesWithCount.length > 0 
                ? activeCoursesWithCount 
                : [];
              studentCourse = fallbackCourses.length > 0 ? fallbackCourses[0] : '';
              console.log("[Perfil] [ESTUDIANTE] Curso fallback:", studentCourse);
            }
            
            console.log("[Perfil] [ESTUDIANTE] Curso final para asignaturas:", studentCourse);
            userSubjects = getSubjectsForCourse(studentCourse);
          } else {
            // ADMIN: todas las asignaturas definidas en el sistema (año actual)
            const year = new Date().getFullYear();
            const subjectsData = LocalStorageManager.getSubjectsForYear(year) || [];
            const names = Array.from(new Set((subjectsData || []).map((s: any) => String(s.name)).filter(Boolean))) as string[];
            const allMap: Record<string, any> = {
              'Matemáticas': { tag: 'MAT', nameKey: 'subjectMath', colorClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300' },
              'Ciencias Naturales': { tag: 'CNT', nameKey: 'subjectScience', colorClass: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300' },
              'Historia, Geografía y Ciencias Sociales': { tag: 'HIS', nameKey: 'subjectHistory', colorClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300' },
              'Lenguaje y Comunicación': { tag: 'LEN', nameKey: 'subjectLanguage', colorClass: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300' },
              'Física': { tag: 'FIS', nameKey: 'subjectPhysics', colorClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300' },
              'Química': { tag: 'QUI', nameKey: 'subjectChemistry', colorClass: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300' },
              'Biología': { tag: 'BIO', nameKey: 'subjectBiology', colorClass: 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300' },
              'Inglés': { tag: 'ING', nameKey: 'subjectEnglish', colorClass: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300' },
              'Educación Física': { tag: 'EFI', nameKey: 'subjectPE', colorClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300' },
              'Tecnología': { tag: 'TEC', nameKey: 'subjectTech', colorClass: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300' },
              'Música': { tag: 'MUS', nameKey: 'subjectMusic', colorClass: 'bg-pink-100 text-pink-800 dark:bg-pink-900/50 dark:text-pink-300' },
              'Artes Visuales': { tag: 'ART', nameKey: 'subjectArts', colorClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300' },
              'Orientación': { tag: 'ORI', nameKey: 'subjectOrientation', colorClass: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300' },
            };
            userSubjects = (names as string[]).map((n: string) => allMap[n] || { tag: (n || 'GEN').toString().slice(0,3).toUpperCase(), nameKey: n, colorClass: 'bg-gray-100 text-gray-800 dark:bg-gray-900/50 dark:text-gray-200' });
          }

          console.log("[Perfil] Asignaturas específicas determinadas:", userSubjects);
          return userSubjects;
        };

        // Función para obtener asignaturas según el curso (fallback para estudiantes)
        const getSubjectsForCourse = (course: string) => {
          if (course.includes('Medio')) {
            return [
              { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
              { tag: "FIS", nameKey: "subjectPhysics", colorClass: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300" },
              { tag: "QUI", nameKey: "subjectChemistry", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
              { tag: "BIO", nameKey: "subjectBiology", colorClass: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300" },
              { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
              { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
              { tag: "ING", nameKey: "subjectEnglish", colorClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300" },
            ];
          }
          return [ // Cursos básicos y por defecto
            { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
            { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
            { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
            { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
          ];
        };
        
        // ✨ USAR LAS ASIGNATURAS ESPECÍFICAS DEL USUARIO ✨
        const allSubjects = getUserSpecificSubjects();
        console.log("[Perfil] Asignaturas unificadas:", allSubjects);

        // Actualizar el estado con toda la información obtenida
        setDynamicUserProfileData({
          name: fullUserData.displayName || fullUserData.username,
          roleKey: fullUserData.role === 'teacher' ? 'profileRoleTeacher' : fullUserData.role === 'admin' ? 'profileRoleAdmin' : fullUserData.role === 'guardian' ? 'profileRoleGuardian' : 'profileRoleStudent',
          evaluationsCompleted: evaluationHistory.length,
        });

        console.log("[Perfil] ¡Estado del perfil actualizado correctamente!");

      } catch (error) {
        console.warn("[Perfil] Error al cargar datos del perfil, usando configuración por defecto:", error);
        
        // Configurar perfil con datos por defecto en caso de error
        const defaultSubjects = [
          { tag: "MAT", nameKey: "subjectMath", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
          { tag: "CNT", nameKey: "subjectScience", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
          { tag: "HIS", nameKey: "subjectHistory", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
          { tag: "LEN", nameKey: "subjectLanguage", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
        ];

        setDynamicUserProfileData({
          name: user?.displayName || user?.username || 'Usuario',
          roleKey: user?.role === 'teacher' ? 'profileRoleTeacher' : user?.role === 'guardian' ? 'profileRoleGuardian' : 'profileRoleStudent',
          activeCourses: user?.activeCourses || ['Sin curso asignado'],
          subjects: defaultSubjects,
          evaluationsCompleted: evaluationHistory.length,
        });
      }
    };

    loadProfileData();

  }, [user, mounted, evaluationHistory.length, refreshTrigger]);

  // ✨ LISTENER PARA CAMBIOS EN GESTIÓN DE USUARIOS ✨
  useEffect(() => {
    const handleUserDataUpdate = () => {
      console.log("[Perfil] Detectado cambio en datos de usuarios, refrescando perfil...");
      setRefreshTrigger(prev => prev + 1);
    };

    const handleStudentAssignmentsUpdate = () => {
      console.log("[Perfil] Detectado cambio en asignaciones de estudiantes, refrescando perfil...");
      setRefreshTrigger(prev => prev + 1);
    };

    // Escuchar eventos personalizados de actualización de usuarios
    window.addEventListener('userDataUpdated', handleUserDataUpdate);
    window.addEventListener('studentAssignmentsChanged', handleStudentAssignmentsUpdate);
    
    return () => {
      window.removeEventListener('userDataUpdated', handleUserDataUpdate);
      window.removeEventListener('studentAssignmentsChanged', handleStudentAssignmentsUpdate);
    };
  }, []);

  const handleDeleteHistory = () => {
    if (!mounted) return;
    
    try {
      // Eliminar historial por usuario y global para mantener consistencia
      const userHistoryKey = user?.username ? `evaluationHistory_${user.username}` : null;
      if (userHistoryKey) {
        localStorage.removeItem(userHistoryKey);
      }
      localStorage.removeItem('evaluationHistory');
      localStorage.removeItem('summariesCreatedCount'); 
      localStorage.removeItem('mapsCreatedCount'); 
      localStorage.removeItem('quizzesCreatedCount');
      setEvaluationHistory([]); 
      setCurrentPage(1);

      // Update profile cards immediately
      setDynamicProfileCards(prevCards => prevCards.map(card => {
          if (card.labelKey === "statEvals") return { ...card, value: "0" };
          if (card.labelKey === "statAvgScore") return { ...card, value: "0%" };
          if (card.labelKey === "statSummaries") return { ...card, value: "0" };
          if (card.labelKey === "statMaps") return { ...card, value: "0" };
          if (card.labelKey === "statQuizzes") return { ...card, value: "0" };
          return card;
      }));

      // Reset learning stats with filtered template based on user's course
      const filteredTemplate = getFilteredLearningStats();
      setDynamicLearningStats(filteredTemplate);

      toast({
        title: translate('historyDeletedTitle'),
        description: translate('historyDeletedDesc'),
        variant: "default"
      });
    } catch (error) {
      console.error("Error deleting history:", error);
      toast({
        title: translate('profileError'),
        description: translate('profileDeleteHistoryError'),
        variant: "destructive"
      });
    }
  };

  const handleDownloadHistoryXlsx = async () => {
    if (!mounted) {
      toast({
        title: translate('profileError'),
        description: translate('profileLoadingError'),
        variant: "destructive"
      });
      return;
    }

    if (evaluationHistory.length === 0) {
        toast({
            title: translate('historyEmptyTitle'),
            description: translate('historyEmptyDesc'),
            variant: "default"
        });
        return;
    }

    try {
      // Dynamic import of XLSX to avoid SSR issues
      const XLSX = await import('xlsx');
      
      const headers = [
          translate('tableDate'),
          translate('tableCourse'),
          translate('tableBook'),
          translate('tableTopic'),
          translate('tableGrade') + " (%)",
          translate('tablePoints')
      ];

      const dataForSheet = evaluationHistory.map(item => {
          const gradePercentage = item.totalQuestions > 0 ? Math.round((item.score / item.totalQuestions) * 100) : 0;
          const points = `${item.score}/${item.totalQuestions}`;
          return [
              item.date,
              item.courseName,
              item.bookTitle,
              item.topic,
              gradePercentage, 
              points
          ];
      });

      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataForSheet]);
      
      const columnWidths = [
        {wch: 20}, // Date
        {wch: 20}, // Course
        {wch: 30}, // Book
        {wch: 30}, // Topic
        {wch: 10}, // Grade
        {wch: 10}  // Points
      ];
      ws['!cols'] = columnWidths;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Historial Evaluaciones");

      XLSX.writeFile(wb, "historial_evaluaciones_smart_student.xlsx");
      
      toast({
        title: translate('profileDownloadSuccess'),
        description: translate('profileDownloadSuccessDesc'),
        variant: "default"
      });
    } catch (error) {
      console.error('Error downloading XLSX:', error);
      toast({
        title: translate('profileDownloadError'),
        description: translate('profileDownloadErrorDesc'),
        variant: "destructive"
      });
    }
  };

  const handleRepasar = (item: EvaluationHistoryItem) => {
    router.push(`/dashboard/evaluacion?course=${encodeURIComponent(item.courseName)}&book=${encodeURIComponent(item.bookTitle)}&topic=${encodeURIComponent(item.topic)}`);
  };

  // Funciones para manejo de imagen de perfil
  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validar tipo de archivo
    if (!file.type.startsWith('image/')) {
      toast({
        title: translate('profileError'),
        description: translate('profileImageError'),
        variant: "destructive"
      });
      return;
    }

    // Validar tamaño (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: translate('profileError'), 
        description: translate('profileImageSizeError'),
        variant: "destructive"
      });
      return;
    }

    setIsUploadingImage(true);
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setProfileImage(result);
      
      // Guardar en localStorage
      if (user?.username) {
        localStorage.setItem(`profile-image-${user.username}`, result);
      }
      
      setIsUploadingImage(false);
      toast({
        title: translate('profileImageUploaded'),
        description: translate('profileImageUploadedDesc'),
        variant: "default"
      });
    };

    reader.onerror = () => {
      setIsUploadingImage(false);
      toast({
        title: translate('profileError'),
        description: translate('profileImageUploadError'),
        variant: "destructive"
      });
    };

    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => {
    setProfileImage(null);
    if (user?.username) {
      localStorage.removeItem(`profile-image-${user.username}`);
    }
    toast({
      title: translate('profileImageRemoved'),
      description: translate('profileImageRemovedDesc'),
      variant: "default"
    });
  };

  // Funciones para edición de perfil
  const handleStartEditing = () => {
    setEditingName(user?.displayName || user?.username || '');
    setEditingEmail(user?.email || '');
    setIsEditingProfile(true);
  };

  const handleCancelEditing = () => {
    setIsEditingProfile(false);
    setEditingName('');
    setEditingEmail('');
  };

  const handleSaveProfile = async () => {
    if (!user?.username || !editingName.trim() || !editingEmail.trim()) {
      toast({
        title: translate('profileError'),
        description: translate('profileSaveError'),
        variant: "destructive"
      });
      return;
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(editingEmail)) {
      toast({
        title: translate('profileError'),
        description: translate('profileEmailError'),
        variant: "destructive"
      });
      return;
    }

    setIsSavingProfile(true);

    try {
      // Obtener usuarios actuales del localStorage
      const storedUsers = localStorage.getItem('smart-student-users');
      if (!storedUsers) {
        throw new Error('No se encontraron datos de usuarios');
      }

      const usersData = JSON.parse(storedUsers);
      const userIndex = usersData.findIndex((u: any) => u.username === user.username);
      
      if (userIndex === -1) {
        throw new Error('Usuario no encontrado');
      }

      // Actualizar los datos del usuario
      usersData[userIndex] = {
        ...usersData[userIndex],
        displayName: editingName.trim(),
        email: editingEmail.trim()
      };

      // Guardar de vuelta en localStorage
      localStorage.setItem('smart-student-users', JSON.stringify(usersData));

      // Actualizar el perfil dinámico inmediatamente
      setDynamicUserProfileData(prev => ({
        ...prev,
        name: editingName.trim()
      }));

      // Llamar a refreshUser para actualizar el contexto de autenticación
      refreshUser();

      // Finalizar edición
      setIsEditingProfile(false);
      setIsSavingProfile(false);

      toast({
        title: translate('profileSaveSuccess'),
        description: translate('profileSaveSuccessDesc'),
        variant: "default"
      });

    } catch (error) {
      console.error('Error al guardar perfil:', error);
      setIsSavingProfile(false);
      toast({
        title: translate('profileError'),
        description: translate('profileSaveErrorDesc'),
        variant: "destructive"
      });
    }
  };

  // Cargar imagen desde localStorage al montar
  useEffect(() => {
    if (user?.username && mounted) {
      const savedImage = localStorage.getItem(`profile-image-${user.username}`);
      if (savedImage) {
        setProfileImage(savedImage);
      }
    }
  }, [user?.username, mounted]);
  
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentItems = evaluationHistory.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(evaluationHistory.length / itemsPerPage);

  // Don't render anything until client-side hydration is complete
  if (!mounted) {
    return (
      <div className="space-y-8">
        <div className="animate-pulse">
          <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded-lg"></div>
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded-lg mt-4"></div>
          <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded-lg mt-4"></div>
        </div>
      </div>
    );
  }

  // Error boundary check
  if (!translate || !language) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-red-500 mb-2">Error: Contexto de idioma no disponible</div>
          <div className="text-sm text-gray-500">Por favor, recarga la página</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Monito (misma versión que Calificaciones) */}
      <div className="fixed bottom-24 right-6 z-50">
        <MonitoCalificaciones />
      </div>

      <div className="relative max-w-7xl mx-auto space-y-8">
        {/* ✨ SECCIÓN DE PERFIL PERSONAL MODERNA CON GRADIENTE NEGRO A AZUL ✨ */}
      <Card className="shadow-lg bg-gradient-to-br from-gray-100 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-700 text-gray-800 dark:text-white border border-gray-200 dark:border-slate-600">
        <CardContent className="p-8">
          <div className="flex items-center gap-4 mb-8">
            <UserCircle className="w-8 h-8 text-blue-600 dark:text-blue-300" />
            <div>
              <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{translate('profilePersonalTitle')}</h1>
              <p className="text-gray-600 dark:text-slate-300 text-sm">{translate('profilePersonalSub')}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* 📸 FOTO DE PERFIL - Columna izquierda */}
            <div className="lg:col-span-3 flex flex-col items-center justify-center space-y-4 pt-2">
              {/* Título de la foto de perfil */}
              <div className="text-center mb-2">
                <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">
                  {language === 'en' ? 'Profile Photo' : 'Foto de Perfil'}
                </h3>
              </div>
              
              <div 
                className="relative group cursor-pointer"
                onClick={() => !isUploadingImage && document.getElementById('profile-image-upload')?.click()}
              >
                <div className="relative w-48 h-48 rounded-full overflow-hidden ring-4 ring-blue-300 shadow-xl bg-gradient-to-br from-blue-400 to-purple-500">
                  {profileImage ? (
                    <img 
                      src={profileImage} 
                      alt="Foto de perfil" 
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-blue-500 to-purple-600">
                      <UserCircle2 className="w-24 h-24 text-white" />
                    </div>
                  )}
                  
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                    {isUploadingImage ? (
                      <div className="w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <Camera className="w-12 h-12 text-white" />
                    )}
                  </div>
                </div>

                <input
                  type="file"
                  id="profile-image-upload"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </div>
            </div>

            {/* 👤 DATOS PERSONALES - Columna central */}
            <div className="lg:col-span-4">
              <div className="bg-gray-200/50 dark:bg-slate-800/80 backdrop-blur-sm rounded-xl p-6 border border-gray-300 dark:border-slate-600/50 shadow-lg dark:shadow-slate-900/30">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-400"></div>
                    <h3 className="text-lg font-bold text-gray-800 dark:text-white">{translate('profilePersonalData')}</h3>
                  </div>
                  {!isEditingProfile && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleStartEditing}
                      className="text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-white hover:bg-gray-300 dark:hover:bg-white/20 transition-all duration-300"
                    >
                      <Edit3 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                      {translate('profileName')}
                    </label>
                    {isEditingProfile ? (
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="w-full text-lg font-bold bg-white/50 dark:bg-white/20 text-gray-800 dark:text-white placeholder-gray-500 dark:placeholder-blue-200 border border-gray-400 dark:border-blue-300 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500 dark:focus:border-blue-100 transition-colors"
                        placeholder={translate('profileEnterName')}
                      />
                    ) : (
                      <div className="flex items-center justify-between bg-gray-100 dark:bg-slate-700/60 rounded-lg p-3 border border-gray-300 dark:border-slate-600/50 shadow-sm">
                        <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-blue-400"></div>
                          <span className="text-gray-800 dark:text-white font-medium">
                            {user?.displayName || user?.username || dynamicUserProfileData.name}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                      {translate('profileEmail')}
                    </label>
                    {isEditingProfile ? (
                      <input
                        type="email"
                        value={editingEmail}
                        onChange={(e) => setEditingEmail(e.target.value)}
                        className="w-full text-lg font-bold bg-white/50 dark:bg-white/20 text-gray-800 dark:text-white placeholder-gray-500 dark:placeholder-blue-200 border border-gray-400 dark:border-blue-300 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500 dark:focus:border-blue-100 transition-colors"
                        placeholder={translate('profileEmailPlaceholder')}
                      />
                    ) : (
                      <div className="flex items-center justify-between bg-gray-100 dark:bg-slate-700/60 rounded-lg p-3 border border-gray-300 dark:border-slate-600/50 shadow-sm">
                        <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-blue-400"></div>
                          <span className="text-gray-800 dark:text-white font-medium">
                            {user?.email || 'jorge@gmail.com'}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 uppercase tracking-wider mb-1">
                      {translate('profileSystemRole')}
                    </label>
                    {renderRoleBadge()}
                  </div>

                  {/* 🔔 NOTIFICACIONES POR EMAIL */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                      {translate('profileEmailNotifications')}
                    </label>
                    <div className="flex items-center justify-between bg-gray-100 dark:bg-slate-700/60 rounded-lg p-3 border border-gray-300 dark:border-slate-600/50 shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${emailNotificationsEnabled ? 'bg-blue-100 dark:bg-blue-900/40' : 'bg-gray-200 dark:bg-slate-600'}`}>
                          <Bell className={`w-4 h-4 ${emailNotificationsEnabled ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400'}`} />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-gray-800 dark:text-white">
                            {emailNotificationsEnabled ? translate('profileNotificationsOn') : translate('profileNotificationsOff')}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-slate-400">
                            {translate('profileNotificationsEmailInfo')}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isSavingNotificationPref && (
                          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        )}
                        <Switch
                          checked={emailNotificationsEnabled}
                          onCheckedChange={handleEmailNotificationToggle}
                          disabled={isSavingNotificationPref}
                          className="data-[state=checked]:bg-gray-400"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                      {translate('profileNotificationsFrom')}: <span className="font-medium">notificaciones@smartstudent.online</span>
                    </p>
                  </div>

                  {isEditingProfile && (
                    <div className="flex gap-3 pt-4 border-t border-gray-300 dark:border-slate-600/60">
                      <Button
                        onClick={handleSaveProfile}
                        disabled={isSavingProfile}
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white transition-colors"
                      >
                        {isSavingProfile ? (
                          <>
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                            {translate('profileSaving')}
                          </>
                        ) : (
                          translate('profileSave')
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleCancelEditing}
                        disabled={isSavingProfile}
                        className="bg-transparent border-gray-400 dark:border-slate-500 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-slate-700/50 transition-colors"
                      >
                        {translate('profileCancel')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 🎓 DATOS ACADÉMICOS - Columna centro-derecha */}
            <div className="lg:col-span-5">
              <div className="bg-gray-200/50 dark:bg-slate-800/80 backdrop-blur-sm rounded-xl p-6 border border-gray-300 dark:border-slate-600/50 shadow-lg dark:shadow-slate-900/30">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-2 h-2 rounded-full bg-blue-400"></div>
                  <h3 className="text-lg font-bold text-gray-800 dark:text-white">{translate('profileAcademicData')}</h3>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                      {user?.role === 'admin' ? (translate('profileSystemOverview') || 'System Overview') : user?.role === 'teacher' ? translate('editUserAcademicInfo') : user?.role === 'guardian' ? (translate('profileAssignedStudents') || 'Estudiantes Asignados') : translate('profileAssignedCourse')}
                    </label>
                    
                    {user?.role === 'admin' ? (
                      // Para administradores: mostrar badges con totales del sistema
                      (() => {
                        try {
                          const currentYear = new Date().getFullYear();
                          
                          // Obtener todos los datos del sistema
                          const courses = LocalStorageManager.getCoursesForYear(currentYear) || [];
                          const sections = LocalStorageManager.getSectionsForYear(currentYear) || [];
                          const subjects = LocalStorageManager.getSubjectsForYear(currentYear) || [];
                          const students = LocalStorageManager.getStudentsForYear(currentYear) || [];
                          const studentAssignments = LocalStorageManager.getStudentAssignmentsForYear(currentYear) || [];
                          
                          // Calcular estudiantes asignados (con curso y sección)
                          const assignedStudents = studentAssignments.length > 0 
                            ? studentAssignments.length 
                            : students.filter((s: any) => s.courseId && s.sectionId).length;
                          
                          return (
                            <div className="space-y-3">
                              {/* Fila 1: Cursos y Asignaturas */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge className="text-xs font-bold px-3 py-1.5 bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 shadow-md">
                                  <School className="w-3.5 h-3.5 mr-1.5" />
                                  {language === 'es' ? 'Todos los Cursos' : 'All Courses'}
                                </Badge>
                                <Badge className="text-xs font-bold px-3 py-1.5 bg-gradient-to-r from-purple-500 to-purple-600 text-white border-0 shadow-md">
                                  <BookOpen className="w-3.5 h-3.5 mr-1.5" />
                                  {language === 'es' ? 'Todas las Asignaturas' : 'All Subjects'}
                                </Badge>
                              </div>
                              
                              {/* Fila 2: Secciones y Estudiantes */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge className="text-xs font-bold px-3 py-1.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white border-0 shadow-md">
                                  <Layers className="w-3.5 h-3.5 mr-1.5" />
                                  {language === 'es' ? 'Todas las Secciones' : 'All Sections'}
                                </Badge>
                                <Badge className="text-xs font-bold px-3 py-1.5 bg-gradient-to-r from-amber-500 to-amber-600 text-white border-0 shadow-md">
                                  <Users className="w-3.5 h-3.5 mr-1.5" />
                                  {language === 'es' ? 'Todos los Estudiantes' : 'All Students'}
                                </Badge>
                              </div>
                              
                              {/* Nota informativa */}
                              <div className="text-xs text-gray-500 dark:text-slate-400 mt-2 italic">
                                {language === 'es' 
                                  ? `Año académico ${currentYear} - Acceso total al sistema`
                                  : `Academic year ${currentYear} - Full system access`}
                              </div>
                            </div>
                          );
                        } catch (error) {
                          console.error('Error al cargar datos del administrador:', error);
                          return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileErrorLoadingAcademicInfo')}</div>;
                        }
                      })()
                    ) : user?.role === 'guardian' ? (
                      // Para apoderados: mostrar estudiantes asignados
                      (() => {
                        if (!user?.username) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoUserDataFound')}</div>;
                        
                        try {
                          console.log('[Perfil Guardian] Starting lookup for user:', user?.username);
                          
                          const storedUsers = localStorage.getItem('smart-student-users');
                          
                          if (!storedUsers) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoUserDataFound')}</div>;
                          
                          const usersData = JSON.parse(storedUsers);
                          // Búsqueda case-insensitive en smart-student-users
                          const fullUserData = usersData.find((u: any) => 
                            u.username?.toLowerCase() === user.username?.toLowerCase()
                          );
                          console.log('[Perfil Guardian] fullUserData from smart-student-users:', fullUserData);
                          
                          // Obtener el año actual
                          const currentYear = new Date().getFullYear();
                          console.log('[Perfil Guardian] currentYear:', currentYear);
                          
                          // Obtener todos los años disponibles para buscar en cualquiera de ellos
                          const availableYears = LocalStorageManager.listYears() || [currentYear];
                          console.log('[Perfil Guardian] availableYears:', availableYears);
                          
                          // Buscar guardian en cualquier año disponible (priorizando año actual)
                          let guardianFromYear: any = null;
                          let yearUsed = currentYear;
                          
                          // Primero intentar el año actual
                          const guardiansForCurrentYear = LocalStorageManager.getGuardiansForYear(currentYear) || [];
                          console.log('[Perfil Guardian] guardiansForCurrentYear:', guardiansForCurrentYear.map((g: any) => ({ id: g.id, username: g.username, studentIds: g.studentIds })));
                          
                          guardianFromYear = guardiansForCurrentYear.find((g: any) => 
                            g.username?.toLowerCase() === user.username?.toLowerCase()
                          );
                          
                          // Si no se encuentra en el año actual, buscar en otros años
                          if (!guardianFromYear) {
                            for (const year of availableYears) {
                              if (year === currentYear) continue;
                              const guardiansForOtherYear = LocalStorageManager.getGuardiansForYear(year) || [];
                              const found = guardiansForOtherYear.find((g: any) => 
                                g.username?.toLowerCase() === user.username?.toLowerCase()
                              );
                              if (found && found.studentIds && found.studentIds.length > 0) {
                                guardianFromYear = found;
                                yearUsed = year;
                                console.log('[Perfil Guardian] Found guardian in year', year, ':', found);
                                break;
                              }
                            }
                          }
                          
                          console.log('[Perfil Guardian] guardianFromYear (final):', guardianFromYear, 'yearUsed:', yearUsed);
                          
                          // Obtener relaciones usando LocalStorageManager (igual que en configuration.tsx)
                          const relations = LocalStorageManager.getGuardianStudentRelationsForYear(yearUsed) || [];
                          console.log('[Perfil Guardian] relations for year', yearUsed, ':', relations);
                          
                          // Obtener IDs de estudiantes asignados
                          let assignedStudentIds: string[] = [];
                          
                          // Prioridad 1: desde guardiansForYear (datos más recientes del admin)
                          if (guardianFromYear?.studentIds && guardianFromYear.studentIds.length > 0) {
                            assignedStudentIds = guardianFromYear.studentIds;
                            console.log('[Perfil Guardian] studentIds from guardiansForYear:', assignedStudentIds);
                          }
                          
                          // Prioridad 2: desde relaciones
                          if (assignedStudentIds.length === 0 && relations.length > 0) {
                            // Buscar por ID del guardian (en guardiansForYear o en smart-student-users)
                            const guardianId = guardianFromYear?.id || fullUserData?.id;
                            console.log('[Perfil Guardian] Looking for guardianId in relations:', guardianId);
                            assignedStudentIds = relations
                              .filter((r: any) => 
                                r.guardianId === guardianId || 
                                r.guardianId === user?.username
                              )
                              .map((r: any) => r.studentId);
                            
                            console.log('[Perfil Guardian] studentIds from relations:', assignedStudentIds);
                          }
                          
                          // Prioridad 3: Fallback desde smart-student-users
                          if (assignedStudentIds.length === 0 && fullUserData?.studentIds && fullUserData.studentIds.length > 0) {
                            assignedStudentIds = fullUserData.studentIds;
                            console.log('[Perfil Guardian] studentIds from fullUserData:', assignedStudentIds);
                          }
                          
                          if (assignedStudentIds.length === 0) {
                            return (
                              <div className="space-y-2">
                                <div className="text-sm text-orange-600 dark:text-orange-400 italic">
                                  {translate('profileNoAssignedStudents') || 'No hay estudiantes asignados'}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                  {translate('profileContactAdminForStudents') || 'Contacta al administrador para asignar estudiantes'}
                                </div>
                              </div>
                            );
                          }
                          
                          // Obtener datos de los estudiantes (usando el mismo año donde encontramos al guardian)
                          const courses = LocalStorageManager.getCoursesForYear(yearUsed) || [];
                          const sections = LocalStorageManager.getSectionsForYear(yearUsed) || [];
                          const studentsForYear = LocalStorageManager.getStudentsForYear(yearUsed) || [];
                          const studentAssignments = LocalStorageManager.getStudentAssignmentsForYear(yearUsed) || [];
                          
                          console.log('[Perfil Guardian] Looking for students with IDs:', assignedStudentIds);
                          console.log('[Perfil Guardian] studentsForYear (year', yearUsed, '):', studentsForYear.map((s: any) => ({ id: s.id, username: s.username, name: s.name })));
                          console.log('[Perfil Guardian] usersData (students):', usersData.filter((u: any) => u.role === 'student' || u.type === 'student').map((u: any) => ({ id: u.id, username: u.username })));
                          
                          // Buscar estudiantes en studentsForYear primero (fuente principal)
                          let assignedStudents = studentsForYear.filter((s: any) => 
                            assignedStudentIds.includes(s.id) || assignedStudentIds.includes(s.username)
                          );
                          
                          // Si no se encontraron, buscar en usersData (smart-student-users)
                          if (assignedStudents.length === 0) {
                            assignedStudents = usersData.filter((u: any) => 
                              (assignedStudentIds.includes(u.id) || assignedStudentIds.includes(u.username)) && 
                              (u.role === 'student' || u.type === 'student')
                            );
                          }
                          
                          console.log('[Perfil Guardian] assignedStudents found:', assignedStudents);
                          
                          return (
                            <div className="space-y-3">
                              {assignedStudents.length === 0 ? (
                                <div className="space-y-2">
                                  <div className="text-sm text-orange-600 dark:text-orange-400 italic">
                                    {translate('profileNoAssignedStudents') || 'No hay estudiantes asignados'}
                                  </div>
                                  <div className="text-xs text-gray-500 dark:text-gray-400">
                                    {translate('profileContactAdminForStudents') || 'Contacta al administrador para asignar estudiantes'}
                                  </div>
                                </div>
                              ) : (
                                assignedStudents.map((student: any) => {
                                  // Obtener curso/sección desde assignments o desde el propio estudiante
                                  const assignment = studentAssignments.find((a: any) => a.studentId === student.id);
                                  const courseId = assignment?.courseId || student.courseId;
                                  const sectionId = assignment?.sectionId || student.sectionId;
                                  
                                  const course = courses.find((c: any) => c.id === courseId);
                                  const section = sections.find((s: any) => s.id === sectionId);
                                  return (
                                    <div key={student.id} className="flex items-center gap-2 flex-wrap bg-gray-100 dark:bg-slate-700/60 rounded-lg p-3 border border-gray-300 dark:border-slate-600/50">
                                      <GraduationCap className="w-4 h-4 text-green-600 dark:text-green-400" />
                                      <span className="text-gray-800 dark:text-white font-medium">
                                        {student.displayName || student.name || student.username}
                                      </span>
                                      {course && (
                                        <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700">
                                          {course.name}{section ? ` - ${section.name}` : ''}
                                        </Badge>
                                      )}
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          );
                        } catch (error) {
                          console.error('Error al cargar datos del apoderado:', error);
                          return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileErrorLoadingAcademicInfo')}</div>;
                        }
                      })()
                    ) : user?.role === 'teacher' ? (
                      // Para profesores: mostrar asignaciones completas como en gestión de usuarios
                      (() => {
                        if (!user?.username) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoUserDataFound')}</div>;
                        
                        const storedUsers = localStorage.getItem('smart-student-users');
                        if (!storedUsers) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoUserDataFound')}</div>;
                        
                        try {
                          const usersData = JSON.parse(storedUsers);
                          const fullUserData = usersData.find((u: any) => u.username === user.username);
                          if (!fullUserData) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoTeacherDataFound')}</div>;
                          
                          const teacherInfo = getTeacherAssignmentsInfo(fullUserData);
                          if (!teacherInfo) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileErrorLoadingTeacherInfo')}</div>;
                          
                          return (
                            <div className="space-y-3">
                              {/* Asignaciones específicas por curso y sección */}
                              {teacherInfo.hasAssignments && Object.keys(teacherInfo.assignments).length > 0 ? (
                                <div className="space-y-3">
                                  {Object.entries(teacherInfo.assignments).map(([sectionKey, info]: [string, any]) => (
                                    <div key={sectionKey} className="space-y-2">
                                      {/* Información del curso, sección y asignaturas en la misma línea */}
                                      <div className="flex items-center gap-2 flex-wrap">
                                        {/* Badge del curso y sección */}
                                        <Badge variant="outline" className="text-xs font-semibold bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700">
                                          {info.courseName} - {translate('userManagementSection')} {info.sectionName}
                                        </Badge>
                                        
                                        {/* Badges de las asignaturas al lado */}
                                        {info.subjects.map((subjectName: string) => {
                                          const subjectInfo = getSubjectInfo(subjectName);
                                          return (
                                            <Badge
                                              key={`${sectionKey}-${subjectName}`}
                                              className="text-xs font-bold border-0 px-2 py-1"
                                              style={{
                                                backgroundColor: subjectInfo.bgColor,
                                                color: subjectInfo.textColor
                                              }}
                                              title={subjectName}
                                            >
                                              {subjectInfo.abbreviation}
                                            </Badge>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-sm text-gray-600 dark:text-slate-300 italic">
                                  {translate('profileNoSpecificAssignments')}
                                </div>
                              )}
                            </div>
                          );
                        } catch (error) {
                          console.error('Error al cargar datos del profesor:', error);
                          return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileErrorLoadingAcademicInfo')}</div>;
                        }
                      })()
                    ) : (
                      // Para estudiantes: mostrar curso y sección
                      (() => {
                        if (!user?.username) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoUserDataFound')}</div>;
                        
                        const storedUsers = localStorage.getItem('smart-student-users');
                        if (!storedUsers) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoUserDataFound')}</div>;
                        
                        try {
                          const usersData = JSON.parse(storedUsers);
                          const fullUserData = usersData.find((u: any) => u.username === user.username);
                          if (!fullUserData) return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileNoStudentDataFound')}</div>;
                          
                          const studentInfo = getStudentCourseInfo(fullUserData);
                          
                          if (!studentInfo) {
                            return (
                              <div className="space-y-2">
                                <div className="text-sm text-orange-600 dark:text-orange-400 italic">
                                  No hay datos académicos configurados
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                  Contacta al administrador para configurar tu curso y sección
                                </div>
                              </div>
                            );
                          }
                          
                          return (
                            <div className="space-y-3">
                              {/* Curso y sección */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant="outline" className="text-xs font-semibold bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700">
                                  {studentInfo.courseName} - {translate('userManagementSection')} {studentInfo.sectionName}
                                </Badge>
                              </div>
                              
                              {/* Asignaturas */}
                              {studentInfo.subjects && studentInfo.subjects.length > 0 && (
                                <div className="space-y-1">
                                  <div className="text-xs font-medium text-gray-600 dark:text-slate-400">
                                    Asignaturas ({studentInfo.subjects.length}):
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {studentInfo.subjects.map((subjectName: string) => {
                                      const subjectInfo = getSubjectInfo(subjectName);
                                      return (
                                        <Badge
                                          key={subjectName}
                                          className="text-xs font-bold border-0 px-2 py-1"
                                          style={{
                                            backgroundColor: subjectInfo.bgColor,
                                            color: subjectInfo.textColor
                                          }}
                                          title={subjectName}
                                        >
                                          {subjectInfo.abbreviation}
                                        </Badge>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        } catch (error) {
                          console.error('Error al cargar datos del estudiante:', error);
                          return <div className="text-sm text-gray-600 dark:text-slate-300 italic">{translate('profileErrorLoadingAcademicInfo')}</div>;
                        }
                      })()
                    )}
                  </div>
                </div>
              </div>
              
              {/* 🛠️ ACCIONES RÁPIDAS - Sección compacta debajo */}
              <div className="mt-4 bg-gray-200/30 dark:bg-slate-700/60 backdrop-blur-sm rounded-xl p-4 border border-gray-300 dark:border-slate-600/50 shadow-md dark:shadow-slate-900/20">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full bg-pink-400"></div>
                  <h4 className="text-sm font-bold text-gray-600 dark:text-slate-200 uppercase tracking-wider">
                    {translate('profileQuickActions')}
                  </h4>
                </div>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="flex-1 bg-blue-600 border-blue-600 text-white hover:bg-blue-700 hover:border-blue-700 hover:text-white shadow-md hover:shadow-lg dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-600 dark:hover:border-slate-500 dark:hover:text-white transition-all duration-300 text-xs px-2 py-1"
                  >
                    <Edit3 className="w-3 h-3 mr-1" />
                    {translate('profileChangePass')}
                  </Button>
                  
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={handleDownloadHistoryXlsx}
                    className="flex-1 bg-blue-600 border-blue-600 text-white hover:bg-blue-700 hover:border-blue-700 hover:text-white shadow-md hover:shadow-lg dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-600 dark:hover:border-slate-500 dark:hover:text-white transition-all duration-300 text-xs px-2 py-1"
                  >
                    <Download className="w-3 h-3 mr-1" />
                    {translate('profileDownloadHistory')}
                  </Button>
                </div>
              </div>
            </div>

          </div>

        </CardContent>
      </Card>

      {/* Profile Stats Cards - Oculto para apoderados */}
      {user?.role !== 'guardian' && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
        {dynamicProfileCards.map((card, index) => (
          <Card key={index} className="shadow-lg bg-gradient-to-br from-gray-100 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-700 text-gray-800 dark:text-white border border-gray-200 dark:border-slate-600 relative overflow-hidden group hover:scale-105 hover:shadow-xl transition-all duration-300 cursor-pointer">
            <div className={cn("absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300", card.bgClass)}></div>
            <CardContent className="p-6 relative z-10 text-center">
              <div className="flex items-center justify-center gap-4 mb-3">
                <div className={cn("w-12 h-12 rounded-full flex items-center justify-center", card.colorClass, "shadow-md group-hover:shadow-lg transition-shadow")}>
                  <card.icon className="w-6 h-6 text-white" />
                </div>
                <div className="text-3xl font-bold text-gray-800 dark:text-white group-hover:text-primary/80 transition-colors">
                  {card.value}
                </div>
              </div>
              <div className="text-sm font-medium text-gray-600 dark:text-slate-300 group-hover:text-foreground transition-colors">
                {translate(card.labelKey)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      )}

      {/* Learning Progress - Oculto para apoderados */}
      {user?.role !== 'guardian' && (
      <Card className="shadow-lg bg-gradient-to-br from-gray-100 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-700 text-gray-800 dark:text-white border border-gray-200 dark:border-slate-600">
        <CardHeader>
          <div className="flex items-center gap-4 mb-2">
            <BarChart3 className="w-8 h-8 text-blue-600 dark:text-blue-300" />
            <CardTitle className="text-2xl font-headline text-gray-800 dark:text-white">{translate('learningProgressTitle')}</CardTitle>
          </div>
          <CardDescription className="text-gray-600 dark:text-slate-300">{translate('learningProgressSub')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {dynamicLearningStats.map((stat, index) => (
              <div key={index} className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="font-medium">{stat.label || translate(stat.nameKey)}</span>
                  <span className="text-sm text-muted-foreground">{stat.progress}%</span>
                </div>
                <div className="relative">
                  <Progress value={stat.progress} className="h-3" />
                  <div 
                    className={cn("absolute top-0 left-0 h-3 rounded-full transition-all duration-500", stat.colorClass)}
                    style={{ width: `${stat.progress}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      )}

      {/* Evaluation History - Oculto para apoderados */}
      {user?.role !== 'guardian' && (
      <Card className="shadow-lg bg-gradient-to-br from-gray-100 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-700 text-gray-800 dark:text-white border border-gray-200 dark:border-slate-600">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-4 mb-2">
                <HistoryIcon className="w-8 h-8 text-blue-600 dark:text-blue-300" />
                <CardTitle className="text-2xl font-headline text-gray-800 dark:text-white">{translate('evaluationHistoryTitle')}</CardTitle>
              </div>
              <CardDescription className="text-gray-600 dark:text-slate-300">{translate('evaluationHistorySub')}</CardDescription>
            </div>
            {evaluationHistory.length > 0 && (
              <Button 
                variant="destructive" 
                size="sm"
                onClick={handleDeleteHistory}
                className="flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                {translate('historyDeleteButton')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {evaluationHistory.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <HistoryIcon className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p>{translate('noEvaluationsYet')}</p>
              <p className="text-sm">{translate('noEvaluationsSubtext')}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{translate('tableDate')}</TableHead>
                      <TableHead>{translate('tableCourse')}</TableHead>
                      <TableHead>{translate('tableBook')}</TableHead>
                      <TableHead>{translate('tableTopic')}</TableHead>
                      <TableHead>{translate('tableGrade')}</TableHead>
                      <TableHead>{translate('tablePoints')}</TableHead>
                      <TableHead>{translate('tableActions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentItems.map((item) => {
                      const gradePercentage = item.totalQuestions > 0 ? Math.round((item.score / item.totalQuestions) * 100) : 0;
                      const gradeColorClass = gradePercentage >= 70 ? 'text-green-600 dark:text-green-400' : gradePercentage >= 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400';
                      
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{item.date}</TableCell>
                          <TableCell>{item.courseName}</TableCell>
                          <TableCell className="max-w-xs truncate" title={translateBookTitle(item.bookTitle)}>{translateBookTitle(item.bookTitle)}</TableCell>
                          <TableCell className="max-w-xs truncate" title={item.topic}>{item.topic}</TableCell>
                          <TableCell className={cn("font-semibold", gradeColorClass)}>{gradePercentage}%</TableCell>
                          <TableCell>{item.score}/{item.totalQuestions}</TableCell>
                          <TableCell>
                            <Button 
                              variant="outline" 
                              size="sm"
                              onClick={() => handleRepasar(item)}
                            >
                              {translate('reviewButton')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-center items-center gap-2 mt-6">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                    disabled={currentPage === 1}
                  >
                    {translate('previousPage')}
                  </Button>
                  <span className="px-4 py-2 text-sm">
                    {translate('pageInfo', { current: currentPage.toString(), total: totalPages.toString() })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                    disabled={currentPage === totalPages}
                  >
                    {translate('nextPage')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      )}
      </div>
    </>
  );
}
