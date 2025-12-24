
"use client";
import { useState, useEffect } from 'react';
import { useLanguage } from '@/contexts/language-context';
import { useAppData } from '@/contexts/app-data-context';
import { useAuth } from '@/contexts/auth-context';
import { bookPDFs } from '@/lib/books-data';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CourseData } from '@/lib/types';

interface BookCourseSelectorProps {
  onCourseChange: (course: string) => void;
  onBookChange: (book: string) => void;
  selectedCourse: string;
  selectedBook: string;
  initialBookNameToSelect?: string; // New optional prop
  showSubjectSelector?: boolean; // Para mostrar selector de asignaturas
  onSubjectChange?: (subject: string) => void; // Callback para cambio de asignatura
  selectedSubject?: string; // Asignatura seleccionada
  showBookSelector?: boolean; // Para mostrar/ocultar selector de libros
}

export function BookCourseSelector({ 
  onCourseChange, 
  onBookChange, 
  selectedCourse, 
  selectedBook, 
  initialBookNameToSelect,
  showSubjectSelector = false,
  onSubjectChange,
  selectedSubject = '',
  showBookSelector = true
}: BookCourseSelectorProps) {
  const { translate, language } = useLanguage();
  const { courses } = useAppData();
  const { getAccessibleCourses, hasAccessToCourse, isAdmin, user, isLoading } = useAuth();
  const [booksForCourse, setBooksForCourse] = useState<string[]>([]);
  const [availableSubjects, setAvailableSubjects] = useState<string[]>([]);

  // Helper: Normaliza nombres de curso para comparaciones y display
  const normalizeCourseName = (raw: string) => {
    if (!raw) return '';
    let s = String(raw).trim();
    // Quitar sufijo " - Sección X" si existe
    const m = s.match(/^(.+?)\s*-\s*Secci[oó]n/i);
    if (m && m[1]) s = m[1].trim();
    // Quitar posible letra de sección final ("1ro Básico A" -> "1ro Básico")
    s = s.replace(/\s+[A-Z]$/i, '').trim();
    return s;
  };

  // Helper: cursos accesibles para estudiante; si no hay en activeCourses, derivar desde usuario completo en localStorage o desde asignaciones
  const getStudentAccessibleCourses = (): string[] => {
    const base = getAccessibleCourses() || [];
    if (user?.role !== 'student') return base;

    // Si ya hay cursos accesibles desde contexto, devolverlos
    if (Array.isArray(base) && base.length > 0) return base;

    const names = new Set<string>();

    try {
      // Intentar obtener el usuario completo desde localStorage (gestion de usuarios)
      const storedUsers = localStorage.getItem('smart-student-users');
      if (storedUsers) {
        const usersData = JSON.parse(storedUsers);
        const fullUserData = usersData.find((u: any) => String(u.id) === String(user.id) || String(u.username) === String(user.username));
        if (fullUserData) {
          console.log('📚 [BookSelector] getStudentAccessibleCourses - fullUserData found in localStorage for', user.username);

          if (fullUserData.course) names.add(normalizeCourseName(fullUserData.course));

          if (Array.isArray(fullUserData.enrolledCourses) && fullUserData.enrolledCourses.length > 0) {
            for (const entry of fullUserData.enrolledCourses) {
              const raw = typeof entry === 'string' ? entry : (entry?.name || '');
              if (raw) names.add(normalizeCourseName(raw));
            }
          }

          if (Array.isArray(fullUserData.activeCourseNames) && fullUserData.activeCourseNames.length > 0) {
            for (const entry of fullUserData.activeCourseNames) {
              const raw = typeof entry === 'string' ? entry : (entry?.name || '');
              if (raw) names.add(normalizeCourseName(raw));
            }
          }

          if (names.size > 0) {
            const res = Array.from(names);
            console.log('📚 [BookSelector] getStudentAccessibleCourses =>', res);
            return res;
          }
        }
      }

      // 2) Fallback: buscar en studentAssignments
      const assignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
      const coursesLS = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      const sectionsLS = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
      const mine = Array.isArray(assignments) ? assignments.filter((a: any) => {
        const matchById = String(a.studentId) === String(user.id);
        const matchByUsername = String(a.studentUsername) === String(user.username);
        const matchByPartial = a.studentId && user.id && (String(a.studentId).includes(String(user.id)) || String(user.id).includes(String(a.studentId)));
        return matchById || matchByUsername || matchByPartial;
      }) : [];

      for (const a of mine) {
        let courseName: string | null = null;
        if (a.courseId) {
          const c = coursesLS.find((c: any) => String(c.id) === String(a.courseId));
          courseName = c?.name || null;
        } else if (a.sectionId) {
          const s = sectionsLS.find((s: any) => String(s.id) === String(a.sectionId));
          if (s) {
            const c = coursesLS.find((c: any) => String(c.id) === String(s.courseId));
            courseName = c?.name || null;
          }
        }
        if (courseName) names.add(normalizeCourseName(courseName));
      }

      const list = Array.from(names);
      console.log('📚 [BookSelector] getStudentAccessibleCourses fallback =>', list.length > 0 ? list : base);
      return list.length > 0 ? list : base;
    } catch (err) {
      console.warn('[BookSelector] Error al derivar cursos accesibles para estudiante:', err);
      return base;
    }
  };

  // Función para traducir nombres de asignaturas
  const translateSubjectName = (subjectName: string): string => {
    // Mapeo directo de nombres exactos de asignaturas
    const exactSubjectMap: { [key: string]: string } = {
      'Ciencias Naturales': translate('subjectCienciasNaturales'),
      'Historia, Geografía y Ciencias Sociales': translate('subjectHistoriaGeografia'),
      'Lenguaje y Comunicación': translate('subjectLenguajeComunicacion'),
      'Matemáticas': translate('subjectMatematicas'),
    };
    
    // Si encontramos una coincidencia exacta, usarla
    if (exactSubjectMap[subjectName]) {
      return exactSubjectMap[subjectName];
    }
    
    // Fallback con lógica parcial para otras asignaturas
    const lowerSubject = subjectName.toLowerCase();
    
    if (lowerSubject.includes('matemáticas') || lowerSubject.includes('matematicas') || lowerSubject.includes('mathematics') || lowerSubject.includes('math')) {
      return translate('subjectMatematicas');
    }
    if (lowerSubject.includes('ciencias naturales') || lowerSubject.includes('natural sciences')) {
      return translate('subjectCienciasNaturales');
    }
    if (lowerSubject.includes('historia') && (lowerSubject.includes('geografía') || lowerSubject.includes('geografia') || lowerSubject.includes('geography'))) {
      return translate('subjectHistoriaGeografia');
    }
    if (lowerSubject.includes('lenguaje') && (lowerSubject.includes('comunicación') || lowerSubject.includes('comunicacion') || lowerSubject.includes('communication'))) {
      return translate('subjectLenguajeComunicacion');
    }
    if (lowerSubject.includes('física') || lowerSubject.includes('fisica') || lowerSubject.includes('physics')) {
      return translate('subjectFisica');
    }
    if (lowerSubject.includes('química') || lowerSubject.includes('quimica') || lowerSubject.includes('chemistry')) {
      return translate('subjectQuimica');
    }
    
    // Si no encuentra una traducción específica, devolver el nombre original
    return subjectName;
  };

  // Función para obtener las asignaturas asignadas al profesor para un curso específico
  const getTeacherAssignedSubjectsForCourse = (courseName: string) => {
    if (!user || user.role !== 'teacher' || !courseName) return [];

    try {
      console.log('🔍 [BookSelector] Obteniendo asignaturas del profesor:', user.username, 'para curso:', courseName);
      
      const storedUsers = localStorage.getItem('smart-student-users');
      if (!storedUsers) return [];
      
      const usersData = JSON.parse(storedUsers);
      const fullUserData = usersData.find((u: any) => u.username === user.username);
      if (!fullUserData) return [];

      const storedAssignments = localStorage.getItem('smart-student-teacher-assignments');
      const storedSections = localStorage.getItem('smart-student-sections');
      const storedCourses = localStorage.getItem('smart-student-courses');

      if (storedAssignments && storedSections && storedCourses) {
        const assignments = JSON.parse(storedAssignments);
        const sections = JSON.parse(storedSections);
        const courses = JSON.parse(storedCourses);

        // Buscar asignaciones por ID del profesor
        const teacherAssignments = assignments.filter((assignment: any) => 
          assignment.teacherId === fullUserData.id
        );

        const assignedSubjectsForCourse = new Set<string>();

        teacherAssignments.forEach((assignment: any) => {
          const section = sections.find((s: any) => s.id === assignment.sectionId);
          if (section) {
            const course = courses.find((c: any) => c.id === section.courseId);
            if (course && course.name === courseName) {
              assignedSubjectsForCourse.add(assignment.subjectName);
              console.log('✅ [BookSelector] Asignatura encontrada para', courseName, ':', assignment.subjectName);
            }
          }
        });

        const result = Array.from(assignedSubjectsForCourse);
        console.log('📋 [BookSelector] Asignaturas finales para', courseName, ':', result);
        return result;
      }

      return [];
    } catch (error) {
      console.error('[BookSelector] Error al obtener asignaturas por curso:', error);
      return [];
    }
  };

  // Función para obtener asignaturas disponibles para estudiantes/admin a partir de la biblioteca de libros
  const getSubjectsForCourseForStudent = (courseName: string) => {
    if (!courseName) return [] as string[];
    try {
      const subjects = new Set<string>();
      bookPDFs.forEach((b) => {
        if (b.course === courseName && b.subject) {
          subjects.add(b.subject);
        }
      });
      return Array.from(subjects);
    } catch (e) {
      console.warn('[BookSelector] Error obteniendo asignaturas para estudiante:', e);
      return [] as string[];
    }
  };

  // Función para obtener las asignaturas asignadas al profesor
  const getTeacherAssignedSubjects = () => {
    if (!user || user.role !== 'teacher') return null;

    try {
      console.log('🔍 [BookSelector] Analizando asignaciones del profesor:', user.username);
      
      // Obtener datos del usuario completo desde localStorage
      const storedUsers = localStorage.getItem('smart-student-users');
      if (!storedUsers) {
        console.warn('[BookSelector] No se encontraron usuarios en localStorage');
        return null;
      }
      
      const usersData = JSON.parse(storedUsers);
      const fullUserData = usersData.find((u: any) => u.username === user.username);
      
      if (!fullUserData) {
        console.warn('[BookSelector] Usuario no encontrado:', user.username);
        return null;
      }

      console.log('👤 [BookSelector] Datos del usuario:', {
        id: fullUserData.id,
        username: fullUserData.username,
        role: fullUserData.role
      });

      // Buscar asignaciones en el sistema de gestión de usuarios
      const storedAssignments = localStorage.getItem('smart-student-teacher-assignments');
      const storedSections = localStorage.getItem('smart-student-sections');
      const storedCourses = localStorage.getItem('smart-student-courses');

      console.log('📦 [BookSelector] Verificando datos:', {
        hasAssignments: !!storedAssignments,
        hasSections: !!storedSections,
        hasCourses: !!storedCourses
      });

      if (storedAssignments && storedSections && storedCourses) {
        const assignments = JSON.parse(storedAssignments);
        const sections = JSON.parse(storedSections);
        const courses = JSON.parse(storedCourses);

        console.log('📋 [BookSelector] Total asignaciones en sistema:', assignments.length);
        console.log('📋 [BookSelector] Buscando asignaciones para teacherId:', fullUserData.id);

        // Buscar asignaciones por ID del profesor
        const teacherAssignments = assignments.filter((assignment: any) => 
          assignment.teacherId === fullUserData.id
        );

        console.log('📋 [BookSelector] Asignaciones encontradas para este profesor:', teacherAssignments);

        if (teacherAssignments.length > 0) {
          const assignedCourses = new Set<string>();
          const assignedSubjects = new Set<string>();

          teacherAssignments.forEach((assignment: any) => {
            console.log('🔍 [BookSelector] Procesando asignación:', assignment);
            const section = sections.find((s: any) => s.id === assignment.sectionId);
            
            if (section) {
              const course = courses.find((c: any) => c.id === section.courseId);
              if (course) {
                assignedCourses.add(course.name);
                console.log('📚 [BookSelector] Curso agregado:', course.name);
              }
              assignedSubjects.add(assignment.subjectName);
              console.log('🎯 [BookSelector] Asignatura agregada:', assignment.subjectName);
            }
          });

          const result = {
            courses: Array.from(assignedCourses),
            subjects: Array.from(assignedSubjects)
          };

          console.log('✅ [BookSelector] Resultado final:', result);
          return result;
        }
      }

      console.log('⚠️ [BookSelector] No se encontraron asignaciones específicas para el profesor');
      return null;

    } catch (error) {
      console.error('[BookSelector] Error al obtener asignaciones del profesor:', error);
      return null;
    }
  };

  // Función para verificar si un libro coincide con las asignaturas del profesor
  const doesBookMatchTeacherSubjects = (bookName: string): boolean => {
    if (!user || user.role !== 'teacher') return true;
    
    // Si hay selector de asignaturas y una asignatura específica seleccionada
    if (showSubjectSelector && selectedSubject) {
      console.log('🎯 [BookSelector] Filtrando por asignatura específica:', selectedSubject);
      return matchesSpecificSubject(bookName, selectedSubject);
    }
    
    // Si hay selector de asignaturas pero no hay asignatura seleccionada, no mostrar libros
    if (showSubjectSelector && !selectedSubject) {
      console.log('⚠️ [BookSelector] No hay asignatura seleccionada, no mostrar libros');
      return false;
    }
    
    // Si no hay selector de asignaturas, usar todas las asignaturas del profesor
    const teacherAssignments = getTeacherAssignedSubjects();
    if (!teacherAssignments?.subjects || teacherAssignments.subjects.length === 0) {
      return true;
    }

    return teacherAssignments.subjects.some((subject: string) => 
      matchesSpecificSubject(bookName, subject)
    );
  };

  // Función auxiliar para verificar si un libro coincide con una asignatura específica
  const matchesSpecificSubject = (bookName: string, subject: string): boolean => {
    const lowerSubject = subject.toLowerCase();
    const lowerBook = bookName.toLowerCase();
    
    // Mapear asignaturas a nombres comunes en libros
    if (lowerSubject.includes('matemáticas') || lowerSubject.includes('matematicas')) {
      return lowerBook.includes('matemática') || lowerBook.includes('matematica');
    }
    if (lowerSubject.includes('ciencias') && lowerSubject.includes('naturales')) {
      return lowerBook.includes('ciencias naturales') || lowerBook.includes('ciencias');
    }
    if (lowerSubject.includes('historia') || lowerSubject.includes('geografía') || lowerSubject.includes('sociales')) {
      return lowerBook.includes('historia') || lowerBook.includes('geografía') || lowerBook.includes('sociales');
    }
    if (lowerSubject.includes('lenguaje') || lowerSubject.includes('comunicación')) {
      return lowerBook.includes('lenguaje') || lowerBook.includes('comunicación');
    }
    if (lowerSubject.includes('física') || lowerSubject.includes('fisica')) {
      return lowerBook.includes('física') || lowerBook.includes('fisica');
    }
    if (lowerSubject.includes('química') || lowerSubject.includes('quimica')) {
      return lowerBook.includes('química') || lowerBook.includes('quimica');
    }
    if (lowerSubject.includes('biología') || lowerSubject.includes('biologia')) {
      return lowerBook.includes('biología') || lowerBook.includes('biologia');
    }
    
    // Fallback: verificación por inclusión directa
    return lowerBook.includes(lowerSubject) || lowerSubject.includes(lowerBook);
  };

  // Early return if loading or no user
  if (isLoading || !user) {
    return (
      <div className="space-y-3">
        <div className="h-12 bg-muted animate-pulse rounded-md"></div>
        <div className="h-12 bg-muted animate-pulse rounded-md"></div>
      </div>
    );
  }

  // Filtrar cursos basado en permisos del usuario  
  const isUserAdmin = isAdmin();
  let filteredCourses: string[] = [];

  // Nueva función: obtener cursos accesibles para el apoderado a partir de los estudiantes asignados
  const getGuardianAccessibleCourses = (): string[] => {
    if (user?.role !== 'guardian') return [];
    try {
      const usersData = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const fullUserData = usersData.find((u: any) => String(u.id) === String(user.id) || String(u.username) === String(user.username));
      const studentIdsFromUser = fullUserData?.studentIds || [];

      // 1) si tenemos studentIds directos, obtener estudiantes
      let studentRecords: any[] = [];
      if (Array.isArray(studentIdsFromUser) && studentIdsFromUser.length > 0) {
        studentRecords = usersData.filter((u: any) => studentIdsFromUser.some((sid: any) => String(sid) === String(u.id) || String(sid) === String(u.username) || String(sid) === String(u.rut)));
      }

      // 2) fallback a relaciones guardian-student
      if (studentRecords.length === 0) {
        const relations = JSON.parse(localStorage.getItem('smart-student-guardian-student-relations') || '[]');
        const rels = relations.filter((r: any) => String(r.guardianId) === String(user.id) || String(r.guardianUsername) === String(user.username));
        const relStudentIds = rels.map((r: any) => r.studentId);
        if (relStudentIds.length > 0) {
          studentRecords = usersData.filter((u: any) => relStudentIds.some((sid: any) => String(sid) === String(u.id) || String(sid) === String(u.username) || String(sid) === String(u.rut)));
        }
      }

      const names = new Set<string>();

      for (const s of studentRecords) {
        if (s.course) names.add(normalizeCourseName(s.course));
        if (Array.isArray(s.enrolledCourses)) {
          s.enrolledCourses.forEach((e: any) => { if (e) names.add(normalizeCourseName(typeof e === 'string' ? e : (e?.name || ''))); });
        }
        if (Array.isArray(s.activeCourseNames)) {
          s.activeCourseNames.forEach((e: any) => { if (e) names.add(normalizeCourseName(typeof e === 'string' ? e : (e?.name || ''))); });
        }

        // Fallback: buscar asignación directa en studentAssignments
        const assignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
        const a = assignments.find((as: any) => String(as.studentId) === String(s.id) || String(as.studentUsername) === String(s.username));
        if (a) {
          const coursesLS = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
          const sectionsLS = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
          if (a.courseId) {
            const c = coursesLS.find((c: any) => String(c.id) === String(a.courseId)); if (c?.name) names.add(normalizeCourseName(c.name));
          } else if (a.sectionId) {
            const sec = sectionsLS.find((ss: any) => String(ss.id) === String(a.sectionId));
            if (sec) { const c = coursesLS.find((c: any) => String(c.id) === String(sec.courseId)); if (c?.name) names.add(normalizeCourseName(c.name)); }
          }
        }
      }

      return Array.from(names);
    } catch (err) {
      console.warn('[BookSelector] Error al obtener cursos del apoderado:', err);
      return [];
    }
  };

  if (user?.role === 'teacher') {
    // Para profesores, filtrar por cursos asignados
    const teacherAssignments = getTeacherAssignedSubjects();
    if (teacherAssignments?.courses) {
      filteredCourses = teacherAssignments.courses;
      console.log('📚 [BookSelector] Cursos filtrados para profesor:', filteredCourses);
    } else {
      // Fallback a cursos accesibles normales
      const userAccessibleCourses = getAccessibleCourses();
      filteredCourses = Object.keys(courses || {}).filter(course => 
        Array.isArray(userAccessibleCourses) && userAccessibleCourses.includes(course)
      );
    }
  } else if (user?.role === 'guardian') {
    // Para apoderados, derivar cursos desde los estudiantes asignados
    const guardianCourses = getGuardianAccessibleCourses();
    console.log('📚 [BookSelector] Cursos detectados para apoderado:', guardianCourses);
    const accessible = isUserAdmin ? Object.keys(courses || {}) : guardianCourses;
    filteredCourses = Object.keys(courses || {}).filter(course => Array.isArray(accessible) && accessible.includes(course));
  } else {
    // Admin: todos; Estudiante: usar activeCourses o derivar desde asignaciones si vacío
    const userAccessibleCourses = user?.role === 'student' ? getStudentAccessibleCourses() : getAccessibleCourses();
    console.log('📚 [BookSelector] userAccessibleCourses:', userAccessibleCourses, 'user:', user?.username, 'role:', user?.role);
    const accessibleCourses = isUserAdmin ? Object.keys(courses || {}) : (userAccessibleCourses || []);
    filteredCourses = Object.keys(courses || {}).filter(course => 
      Array.isArray(accessibleCourses) && accessibleCourses.includes(course)
    );
    console.log('📚 [BookSelector] filteredCourses computed:', filteredCourses);
  }

  // Cargar asignaturas disponibles según rol y curso seleccionado
  useEffect(() => {
    if (!showSubjectSelector) {
      setAvailableSubjects([]);
      return;
    }

    if (selectedCourse) {
      if (user?.role === 'teacher') {
        console.log('🔍 [BookSelector] Cargando asignaturas para profesor:', user.username, 'en curso:', selectedCourse);
        const subjectsForCourse = getTeacherAssignedSubjectsForCourse(selectedCourse);

        if (subjectsForCourse.length > 0) {
          console.log('✅ [BookSelector] Asignaturas encontradas para el curso:', subjectsForCourse);
          setAvailableSubjects(subjectsForCourse);

          if (selectedSubject && !subjectsForCourse.includes(selectedSubject)) {
            onSubjectChange?.('');
          }
        } else {
          console.log('⚠️ [BookSelector] No hay asignaturas asignadas para el curso:', selectedCourse);
          setAvailableSubjects([]);
          onSubjectChange?.('');
        }
      } else {
        // Estudiante/Admin: derivar asignaturas desde bookPDFs para el curso
        const subjectsForCourse = getSubjectsForCourseForStudent(selectedCourse);
        setAvailableSubjects(subjectsForCourse);
        if (selectedSubject && !subjectsForCourse.includes(selectedSubject)) {
          onSubjectChange?.('');
        }
      }
    } else {
      setAvailableSubjects([]);
      onSubjectChange?.('');
    }
  }, [showSubjectSelector, user?.role, selectedCourse, selectedSubject, onSubjectChange, language]);

  // AUTOSELECT: si el usuario es estudiante o apoderado y no hay curso seleccionado, seleccionar el curso detectado por prioridad
  useEffect(() => {
    if (!user) return;
    if (selectedCourse) return; // no sobrescribir selección manual

    if (filteredCourses && filteredCourses.length > 0) {
      // Priorizar match con user.course / enrolledCourses / activeCourseNames si existe (estudiante)
      let candidate: string | null = null;

      if (user.role === 'student') {
        const userCourseNormalized = user?.course ? normalizeCourseName(user.course) : null;
        candidate = (userCourseNormalized && filteredCourses.find(c => normalizeCourseName(c) === userCourseNormalized)) || filteredCourses[0] || null;
      }

      if (user.role === 'guardian') {
        // priorizar curso del primer estudiante asignado
        try {
          const usersData = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
          const fullUserData = usersData.find((u: any) => String(u.id) === String(user.id) || String(u.username) === String(user.username));
          let firstStudentId = null;
          if (fullUserData?.studentIds && fullUserData.studentIds.length > 0) firstStudentId = fullUserData.studentIds[0];
          if (!firstStudentId) {
            const relations = JSON.parse(localStorage.getItem('smart-student-guardian-student-relations') || '[]');
            const rels = relations.filter((r: any) => String(r.guardianId) === String(user.id) || String(r.guardianUsername) === String(user.username));
            if (rels.length > 0) firstStudentId = rels[0].studentId;
          }
          if (firstStudentId) {
            const student = usersData.find((s: any) => String(s.id) === String(firstStudentId) || String(s.username) === String(firstStudentId) || String(s.rut) === String(firstStudentId));
            if (student) {
              const candidateName = normalizeCourseName(student.course || (Array.isArray(student.enrolledCourses) && student.enrolledCourses[0]) || (Array.isArray(student.activeCourseNames) && student.activeCourseNames[0]) || '');
              if (candidateName) candidate = filteredCourses.find(c => normalizeCourseName(c) === candidateName) || null;
            }
          }
        } catch (e) {
          console.warn('[BookSelector] Error al auto-seleccionar curso para apoderado:', e);
        }

        // Si no encontramos candidato específico, usar el primero disponible
        if (!candidate) candidate = filteredCourses[0] || null;
      }

      if (candidate) {
        console.log('📚 [BookSelector] Auto-seleccionando curso para usuario:', user.role, candidate);
        onCourseChange(candidate);
      }
    }
  }, [user?.role, filteredCourses, selectedCourse, onCourseChange]);

  useEffect(() => {
    const canUseSelected = selectedCourse && courses[selectedCourse] && (
      filteredCourses.includes(selectedCourse)
    );
    if (canUseSelected) {
      let newBooks = courses[selectedCourse][language] || [];
      
      // 🎓 FILTRAR LIBROS PARA PROFESORES BASADO EN SUS ASIGNATURAS ASIGNADAS
      if (user?.role === 'teacher') {
        newBooks = newBooks.filter(bookName => doesBookMatchTeacherSubjects(bookName));
        console.log(`📚 [BookSelector] Libros filtrados para profesor en ${selectedCourse}:`, newBooks);
      }
      
      setBooksForCourse(newBooks);
      
      if (initialBookNameToSelect && newBooks.includes(initialBookNameToSelect)) {
        onBookChange(initialBookNameToSelect);
      } else {
        // Only reset if not trying to set an initial book or if course itself changed significantly
        // This condition might need refinement if initialBookNameToSelect should persist across course changes that still contain it
        if (!initialBookNameToSelect || selectedBook && !newBooks.includes(selectedBook) ) {
             onBookChange('');
        }
      }
    } else {
      setBooksForCourse([]);
      onBookChange(''); 
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCourse, selectedSubject, language, courses, initialBookNameToSelect, user?.role, showSubjectSelector]); // agregado selectedSubject; permiso derivado de filteredCourses

  return (
    <>
      <Select onValueChange={onCourseChange} value={selectedCourse}>
        <SelectTrigger className="w-full py-3 text-base md:text-sm">
          <SelectValue placeholder={translate('selectCourse')} />
        </SelectTrigger>
        <SelectContent>
          {filteredCourses.map(courseName => (
            <SelectItem key={courseName} value={courseName}>
              {courseName.replace(/Básico/g, 'Básico').replace(/Medio/g, 'Medio')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

    {showSubjectSelector && (
        <Select 
          onValueChange={(value) => {
            if (onSubjectChange) {
              onSubjectChange(value);
              // Resetear la selección de libro cuando cambie la asignatura
              onBookChange('');
            }
          }} 
          value={selectedSubject}
      disabled={!selectedCourse || availableSubjects.length === 0}
        >
          <SelectTrigger className="w-full py-3 text-base md:text-sm">
            <SelectValue placeholder={translate('selectSubject')} />
          </SelectTrigger>
          <SelectContent>
            {availableSubjects.map(subject => (
              <SelectItem key={subject} value={subject}>
                {translateSubjectName(subject)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {showBookSelector && (
        <Select onValueChange={onBookChange} value={selectedBook} disabled={!selectedCourse || booksForCourse.length === 0 || (showSubjectSelector && user?.role === 'teacher' && !selectedSubject)}>
          <SelectTrigger className="w-full py-3 text-base md:text-sm">
            <SelectValue placeholder={translate('selectBook')} />
          </SelectTrigger>
          <SelectContent>
            {booksForCourse.map(bookName => (
              <SelectItem key={bookName} value={bookName}>
                {bookName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  );
}
    
