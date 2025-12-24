"use client";

import { useState, useEffect, useMemo } from 'react';
import { useLanguage } from '@/contexts/language-context';
import { useAppData } from '@/contexts/app-data-context';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Library, Download, Book, FileText, GraduationCap, Filter, Microscope, Calculator, BookOpen, Map, Atom, Zap, TestTube, Brain, Users, Scale } from 'lucide-react';
import { bookPDFs, BookPDF } from '@/lib/books-data';
import { useToast } from "@/hooks/use-toast";
import { cn } from '@/lib/utils';

export default function LibrosPage() {
  const { translate, language } = useLanguage();
  const { courses } = useAppData();
  const { user, getAccessibleCourses, hasAccessToCourse, isLoading } = useAuth();
  const { toast } = useToast();

  // Early return if loading or no user
  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">{translate('loadingLibrary')}</p>
        </div>
      </div>
    );
  }

  // 🎓 FUNCIÓN PARA OBTENER ASIGNACIONES DEL PROFESOR
  const getTeacherAssignedSubjects = () => {
    if (!user || user.role !== 'teacher') return null;

    try {
      console.log('🔍 [Libros] Analizando asignaciones del profesor:', user.username);
      
      // Obtener datos del usuario completo desde localStorage
      const storedUsers = localStorage.getItem('smart-student-users');
      if (!storedUsers) {
        console.warn('[Libros] No se encontraron usuarios en localStorage');
        return null;
      }
      
      const usersData = JSON.parse(storedUsers);
      const fullUserData = usersData.find((u: any) => u.username === user.username);
      
      if (!fullUserData) {
        console.warn('[Libros] No se encontró el usuario completo');
        return null;
      }

      // Buscar asignaciones en el sistema de gestión de usuarios (teacher-assignments)
      const assignments = JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]');
      const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');

      console.log('📊 [Libros] Datos del sistema:', { 
        assignments: assignments.length, 
        courses: courses.length, 
        sections: sections.length,
        teacherId: fullUserData.id 
      });

      // Buscar asignaciones por ID del profesor
      const teacherAssignments = assignments.filter((assignment: any) => 
        assignment.teacherId === fullUserData.id
      );

      console.log('📋 [Libros] Asignaciones encontradas:', teacherAssignments);

      if (teacherAssignments.length > 0) {
        // Extraer cursos y asignaturas únicos
        const assignedCourses = new Set<string>();
        const assignedSubjects = new Set<string>();

        teacherAssignments.forEach((assignment: any) => {
          const section = sections.find((s: any) => s.id === assignment.sectionId);
          
          if (section) {
            const course = courses.find((c: any) => c.id === section.courseId);
            if (course) {
              assignedCourses.add(course.name);
            }
            assignedSubjects.add(assignment.subjectName);
          }
        });

        console.log('✅ [Libros] Cursos asignados:', Array.from(assignedCourses));
        console.log('✅ [Libros] Asignaturas asignadas:', Array.from(assignedSubjects));

        return {
          courses: Array.from(assignedCourses),
          subjects: Array.from(assignedSubjects)
        };
      }

      // Fallback: usar teachingAssignments del usuario
      if (fullUserData.teachingAssignments && Array.isArray(fullUserData.teachingAssignments) && fullUserData.teachingAssignments.length > 0) {
        console.log('⚠️ [Libros] Usando teachingAssignments como fallback');
        
        const assignedCourses = new Set<string>();
        const assignedSubjects = new Set<string>();

        fullUserData.teachingAssignments.forEach((assignment: any) => {
          if (assignment.courses && Array.isArray(assignment.courses)) {
            assignment.courses.forEach((course: string) => assignedCourses.add(course));
          }
          if (assignment.subject) {
            assignedSubjects.add(assignment.subject);
          }
        });

        return {
          courses: Array.from(assignedCourses),
          subjects: Array.from(assignedSubjects)
        };
      }

      // Último fallback: asignación por defecto
      console.log('⚠️ [Libros] Usando asignación por defecto');
      return {
        courses: ['4to Básico'],
        subjects: ['Matemáticas']
      };

    } catch (error) {
      console.error('[Libros] Error al obtener asignaciones del profesor:', error);
      return null;
    }
  };

  // Function to get subject icon and color
  const getSubjectIconAndColor = (subject: string) => {
    const lowerSubject = subject.toLowerCase();
    
    // Ciencias básicas
    if (lowerSubject.includes('ciencias') && lowerSubject.includes('naturales')) {
      return { icon: Microscope, color: 'text-green-600' };
    } 
    // Materias específicas de media
    else if (lowerSubject.includes('biología') || lowerSubject.includes('biologia')) {
      return { icon: Atom, color: 'text-emerald-600' };
    } else if (lowerSubject.includes('física') || lowerSubject.includes('fisica')) {
      return { icon: Zap, color: 'text-yellow-600' };
    } else if (lowerSubject.includes('química') || lowerSubject.includes('quimica')) {
      return { icon: TestTube, color: 'text-purple-600' };
    } else if (lowerSubject.includes('filosofía') || lowerSubject.includes('filosofia')) {
      return { icon: Brain, color: 'text-indigo-600' };
    } else if (lowerSubject.includes('ciencias para la ciudadanía') || lowerSubject.includes('ciencias para la ciudadania')) {
      return { icon: Users, color: 'text-teal-600' };
    } else if (lowerSubject.includes('educación ciudadana') || lowerSubject.includes('educacion ciudadana')) {
      return { icon: Scale, color: 'text-orange-600' };
    }
    // Materias básicas
    else if (lowerSubject.includes('matemáticas') || lowerSubject.includes('matematicas')) {
      return { icon: Calculator, color: 'text-blue-600' };
    } else if (lowerSubject.includes('lenguaje') || lowerSubject.includes('comunicación')) {
      return { icon: BookOpen, color: 'text-red-600' };
    } else if (lowerSubject.includes('historia') || lowerSubject.includes('geografía') || lowerSubject.includes('sociales')) {
      return { icon: Map, color: 'text-amber-700' };
    } else {
      return { icon: Book, color: 'text-gray-600' };
    }
  };

  // Función para traducir nombres de asignaturas
  const translateSubject = (subject: string): string => {
    if (language === 'es') return subject; // Sin traducción si está en español
    
    const subjectMap: { [key: string]: string } = {
      'Ciencias Naturales': translate('subjectCienciasNaturales'),
      'Historia, Geografía y Ciencias Sociales': translate('subjectHistoriaGeografia'),
      'Lenguaje y Comunicación': translate('subjectLenguajeComunicacion'),
      'Matemáticas': translate('subjectMatematicas'),
      'Física': translate('subjectFisica'),
      'Química': translate('subjectQuimica'),
      'Biología': translate('subjectBiologia'),
      'Filosofía y Psicología': translate('subjectFilosofia'),
      'Educación Ciudadana': translate('subjectEducacionCiudadana'),
      'Inglés': translate('subjectIngles'),
      'Artes Visuales': translate('subjectArtes'),
      'Música': translate('subjectMusica'),
      'Educación Física y Salud': translate('subjectEducacionFisica'),
      'Tecnología': translate('subjectTecnologia'),
      'Religión': translate('subjectReligion'),
      'Orientación': translate('subjectOrientacion')
    };
    
    return subjectMap[subject] || subject;
  };

  // Función para traducir nombres de cursos
  const translateCourse = (course: string): string => {
    if (language === 'es') return course; // Sin traducción si está en español
    
    const courseMap: { [key: string]: string } = {
      '1ro Básico': translate('course1roBasico'),
      '2do Básico': translate('course2doBasico'),
      '3ro Básico': translate('course3roBasico'),
      '4to Básico': translate('course4toBasico'),
      '5to Básico': translate('course5toBasico'),
      '6to Básico': translate('course6toBasico'),
      '7mo Básico': translate('course7moBasico'),
      '8vo Básico': translate('course8voBasico'),
      '1ro Medio': translate('course1roMedio'),
      '2do Medio': translate('course2doMedio'),
      '3ro Medio': translate('course3roMedio'),
      '4to Medio': translate('course4toMedio')
    };
    
    return courseMap[course] || course;
  };

  // 🔧 FUNCIÓN PARA NORMALIZAR NOMBRES DE CURSOS (para matching con bookPDFs)
  const normalizeCourseNameForBooks = (courseName: string): string => {
    if (!courseName) return '';
    
    // Remover la sección si existe (ej: "1ro Básico - Sección A" -> "1ro Básico")
    let normalized = courseName.split(' - ')[0].trim();
    
    // Normalizar variantes comunes
    normalized = normalized
      .replace(/1er|1°|Primer/gi, '1ro')
      .replace(/2do|2°|Segundo/gi, '2do')
      .replace(/3er|3°|Tercer/gi, '3ro')
      .replace(/4to|4°|Cuarto/gi, '4to')
      .replace(/5to|5°|Quinto/gi, '5to')
      .replace(/6to|6°|Sexto/gi, '6to')
      .replace(/7mo|7°|Séptimo|Septimo/gi, '7mo')
      .replace(/8vo|8°|Octavo/gi, '8vo')
      .replace(/basica/gi, 'Básico')
      .replace(/medio/gi, 'Medio');
    
    return normalized;
  };

  // 🔧 FUNCIÓN PARA VERIFICAR SI UN LIBRO COINCIDE CON UN CURSO
  const bookMatchesCourse = (bookCourse: string, userCourse: string): boolean => {
    const normalizedBook = normalizeCourseNameForBooks(bookCourse);
    const normalizedUser = normalizeCourseNameForBooks(userCourse);
    
    return normalizedBook.toLowerCase() === normalizedUser.toLowerCase();
  };

  // Group books by course - filtered by user permissions and teacher assignments
  // Helper: cursos accesibles para estudiante (replica lógica de perfil)
  const getStudentAccessibleCourses = () => {
    if (user.role !== 'student' && user.role !== 'estudiante') {
      return getAccessibleCourses() || [];
    }
    
    try {
      console.log('📚 [Libros] Buscando cursos para estudiante:', { id: user.id, username: user.username, role: user.role });
      
      // Helper: obtener datasets considerando año actual (clave con sufijo -YYYY si existe)
      const getYearAwareData = (baseKey: string) => {
        const year = new Date().getFullYear();
        const withYear = localStorage.getItem(`${baseKey}-${year}`);
        const raw = withYear || localStorage.getItem(baseKey);
        try { return raw ? JSON.parse(raw) : []; } catch { return []; }
      };
      
      const coursesData = getYearAwareData('smart-student-courses');
      const sections = getYearAwareData('smart-student-sections');
      const studentAssignments = getYearAwareData('smart-student-student-assignments');
      const usersData = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      
      console.log('📚 [Libros] Datos disponibles:', { 
        courses: coursesData.length, 
        sections: sections.length,
        assignments: studentAssignments.length
      });
      
      // Buscar el usuario completo para obtener courseId y sectionId
      const fullUserData = usersData.find((u: any) => 
        u.username?.toLowerCase() === user.username?.toLowerCase() ||
        String(u.id) === String(user.id)
      );
      
      console.log('📚 [Libros] Usuario completo:', fullUserData ? {
        id: fullUserData.id,
        username: fullUserData.username,
        courseId: fullUserData.courseId,
        sectionId: fullUserData.sectionId,
        activeCourses: fullUserData.activeCourses
      } : 'NO ENCONTRADO');
      
      if (!fullUserData) {
        console.warn('📚 [Libros] Usuario no encontrado en smart-student-users');
        return [];
      }
      
      const names = new Set<string>();
      
      // MÉTODO 1: courseId y sectionId directamente en el usuario (Gestión de Usuarios)
      if (fullUserData.courseId && fullUserData.sectionId) {
        const course = coursesData.find((c: any) => c.id === fullUserData.courseId);
        if (course?.name) {
          console.log('📚 [Libros] ✅ Curso encontrado por courseId directo:', course.name);
          names.add(normalizeCourseNameForBooks(course.name));
        }
      }
      
      // MÉTODO 2: Solo courseId (sin sectionId)
      if (names.size === 0 && fullUserData.courseId) {
        const course = coursesData.find((c: any) => c.id === fullUserData.courseId);
        if (course?.name) {
          console.log('📚 [Libros] ✅ Curso encontrado por courseId:', course.name);
          names.add(normalizeCourseNameForBooks(course.name));
        }
      }
      
      // MÉTODO 3: Solo sectionId (derivar courseId desde la sección)
      if (names.size === 0 && fullUserData.sectionId) {
        const section = sections.find((s: any) => s.id === fullUserData.sectionId);
        if (section) {
          const course = coursesData.find((c: any) => c.id === section.courseId);
          if (course?.name) {
            console.log('📚 [Libros] ✅ Curso encontrado por sectionId:', course.name);
            names.add(normalizeCourseNameForBooks(course.name));
          }
        }
      }
      
      // MÉTODO 4: Buscar asignación en studentAssignments (comparación flexible)
      if (names.size === 0) {
        console.log('📚 [Libros] Buscando en studentAssignments para ID:', fullUserData.id, 'username:', fullUserData.username);
        
        const assignment = studentAssignments.find((a: any) => {
          const matchById = String(a.studentId) === String(fullUserData.id);
          const matchByUsername = a.studentUsername === fullUserData.username;
          // También intentar match parcial del ID
          const matchByPartialId = a.studentId && fullUserData.id && 
            (String(a.studentId).includes(String(fullUserData.id)) || 
             String(fullUserData.id).includes(String(a.studentId)));
          
          if (matchById || matchByUsername || matchByPartialId) {
            console.log('📚 [Libros] ✓ Assignment match encontrado:', a);
            return true;
          }
          return false;
        });
        
        if (assignment) {
          const course = coursesData.find((c: any) => c.id === assignment.courseId);
          const section = sections.find((s: any) => s.id === assignment.sectionId);
          
          if (course?.name) {
            console.log('📚 [Libros] ✅ Curso encontrado por assignment:', course.name);
            names.add(normalizeCourseNameForBooks(course.name));
          } else if (section) {
            // Si no hay courseId directo, derivar desde la sección
            const courseFromSection = coursesData.find((c: any) => c.id === section.courseId);
            if (courseFromSection?.name) {
              console.log('📚 [Libros] ✅ Curso encontrado por assignment.sectionId:', courseFromSection.name);
              names.add(normalizeCourseNameForBooks(courseFromSection.name));
            }
          }
        } else {
          // Log de muestra para debugging
          const sampleAssignments = studentAssignments.slice(0, 3);
          console.log('📚 [Libros] No se encontró assignment. Muestra de assignments:', sampleAssignments);
        }
      }
      
      // MÉTODO 5: Parsear activeCourses estilo "1ro Básico - Sección A"
      if (names.size === 0 && Array.isArray(fullUserData.activeCourses) && fullUserData.activeCourses.length > 0) {
        for (const entry of fullUserData.activeCourses) {
          let raw = typeof entry === 'string' ? entry : (entry?.name || entry?.id || '');
          if (raw) {
            // Extraer nombre de curso (antes de " - Sección")
            const match = raw.match(/^(.+?)\s*-\s*Sección/i);
            const courseName = match ? match[1].trim() : raw;
            console.log('📚 [Libros] ✅ Curso parseado de activeCourses:', courseName);
            names.add(normalizeCourseNameForBooks(courseName));
          }
        }
      }
      
      // MÉTODO 6: Fallback a getAccessibleCourses del contexto
      if (names.size === 0) {
        const base = getAccessibleCourses() || [];
        console.log('📚 [Libros] Fallback a getAccessibleCourses:', base);
        base.forEach(c => names.add(normalizeCourseNameForBooks(c)));
      }
      
      const list = Array.from(names);
      console.log('📚 [Libros] ✅ Cursos finales para estudiante:', list);
      return list;
    } catch (error) {
      console.error('📚 [Libros] Error obteniendo cursos del estudiante:', error);
      return [];
    }
  };

  // 👨‍👩‍👧 FUNCIÓN PARA OBTENER CURSOS ACCESIBLES PARA APODERADO (GUARDIAN)
  const getGuardianAccessibleCourses = (): string[] => {
    if (!user || user.role !== 'guardian') return [];

    try {
      console.log('👨‍👩‍👧 [Libros] Obteniendo cursos para apoderado:', user.username);
      
      const currentYear = new Date().getFullYear();
      const usersData = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const studentAssignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
      const coursesData = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
      
      // Buscar estudiantes asignados al apoderado
      let assignedStudentIds: string[] = [];
      
      // Prioridad 1: fullUserData.studentIds
      const fullUserData = usersData.find((u: any) => 
        u.username?.toLowerCase() === user.username?.toLowerCase()
      );
      
      if (fullUserData?.studentIds && fullUserData.studentIds.length > 0) {
        assignedStudentIds = fullUserData.studentIds;
        console.log(`👨‍👩‍👧 [Libros] studentIds desde usuario:`, assignedStudentIds);
      }
      
      // Prioridad 2: guardian-student-relations
      if (assignedStudentIds.length === 0) {
        let guardianRelations = JSON.parse(localStorage.getItem(`smart-student-guardian-student-relations-${currentYear}`) || '[]');
        if (guardianRelations.length === 0) {
          guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-student-relations') || '[]');
        }
        
        assignedStudentIds = guardianRelations
          .filter((rel: any) => rel.guardianId === (user as any).id || rel.guardianUsername === user.username)
          .map((rel: any) => rel.studentId);
        
        if (assignedStudentIds.length > 0) {
          console.log(`👨‍👩‍👧 [Libros] studentIds desde relations:`, assignedStudentIds);
        }
      }
      
      if (assignedStudentIds.length === 0) {
        console.warn('👨‍👩‍👧 [Libros] No se encontraron estudiantes asignados al apoderado');
        return [];
      }
      
      // Buscar los cursos de los estudiantes asignados
      const courseNames = new Set<string>();
      
      for (const studentId of assignedStudentIds) {
        // Buscar asignaciones del estudiante
        const studentAssigns = studentAssignments.filter((a: any) => 
          String(a.studentId) === String(studentId)
        );
        
        console.log(`👨‍👩‍👧 [Libros] Asignaciones para estudiante ${studentId}:`, studentAssigns);
        
        for (const assignment of studentAssigns) {
          let courseName: string | null = null;
          
          if (assignment.courseId) {
            const course = coursesData.find((c: any) => String(c.id) === String(assignment.courseId));
            courseName = course?.name || null;
          }
          if (!courseName && assignment.sectionId) {
            const section = sections.find((s: any) => String(s.id) === String(assignment.sectionId));
            if (section) {
              const course = coursesData.find((c: any) => String(c.id) === String(section.courseId));
              courseName = course?.name || null;
            }
          }
          
          if (courseName) {
            // Normalizar el nombre del curso
            courseNames.add(normalizeCourseNameForBooks(courseName));
          }
        }
        
        // Método 2: Buscar sectionId/courseId directamente en el estudiante
        const student = usersData.find((u: any) => 
          (String(u.id) === String(studentId) || u.username === studentId) && 
          (u.role === 'student' || u.role === 'estudiante')
        );
        
        if (student) {
          console.log(`👨‍👩‍👧 [Libros] Estudiante encontrado:`, { id: student.id, username: student.username, sectionId: student.sectionId, courseId: student.courseId });
          
          // Buscar por sectionId del estudiante
          if (student.sectionId && courseNames.size === 0) {
            const section = sections.find((s: any) => String(s.id) === String(student.sectionId));
            if (section) {
              const course = coursesData.find((c: any) => String(c.id) === String(section.courseId));
              if (course?.name) {
                console.log('👨‍👩‍👧 [Libros] Curso desde estudiante.sectionId:', course.name);
                courseNames.add(normalizeCourseNameForBooks(course.name));
              }
            }
          }
          
          // Buscar por courseId del estudiante
          if (student.courseId && courseNames.size === 0) {
            const course = coursesData.find((c: any) => String(c.id) === String(student.courseId));
            if (course?.name) {
              console.log('👨‍👩‍👧 [Libros] Curso desde estudiante.courseId:', course.name);
              courseNames.add(normalizeCourseNameForBooks(course.name));
            }
          }
          
          // Fallback: revisar activeCourses del estudiante
          if (student.activeCourses && Array.isArray(student.activeCourses) && courseNames.size === 0) {
            for (const courseId of student.activeCourses) {
              const course = coursesData.find((c: any) => String(c.id) === String(courseId) || c.name === courseId);
              if (course?.name) {
                courseNames.add(normalizeCourseNameForBooks(course.name));
              } else if (typeof courseId === 'string' && (courseId.includes('Básico') || courseId.includes('Medio'))) {
                courseNames.add(normalizeCourseNameForBooks(courseId));
              }
            }
          }
        }
      }
      
      const result = Array.from(courseNames);
      console.log('👨‍👩‍👧 [Libros] Cursos accesibles para apoderado (normalizados):', result);
      return result;
      
    } catch (error) {
      console.error('👨‍👩‍👧 [Libros] Error al obtener cursos del apoderado:', error);
      return [];
    }
  };

  const booksByCourse = useMemo(() => {
    let filteredBooks = [...bookPDFs];

    // 🎓 FILTRAR LIBROS PARA PROFESORES BASADO EN SUS ASIGNACIONES
    if (user.role === 'teacher') {
      const teacherAssignments = getTeacherAssignedSubjects();
      
      if (teacherAssignments) {
        console.log('📚 [Libros] Filtrando libros para profesor:', {
          assignedCourses: teacherAssignments.courses,
          assignedSubjects: teacherAssignments.subjects,
          totalBooks: bookPDFs.length
        });

        filteredBooks = bookPDFs.filter(book => {
          const courseMatch = teacherAssignments.courses.some(c => bookMatchesCourse(book.course, c));
          const subjectMatch = teacherAssignments.subjects.some(subject => 
            book.subject.toLowerCase().includes(subject.toLowerCase()) ||
            subject.toLowerCase().includes(book.subject.toLowerCase())
          );
          
          const hasAccess = courseMatch && subjectMatch;
          
          if (hasAccess) {
            console.log(`✅ [Libros] Acceso permitido: ${book.subject} - ${book.course}`);
          }
          
          return hasAccess;
        });

        console.log(`📊 [Libros] Libros filtrados: ${filteredBooks.length}/${bookPDFs.length}`);
      } else {
        console.warn('⚠️ [Libros] No se pudieron obtener asignaciones del profesor');
        // Si no se pueden obtener asignaciones, mostrar solo libros básicos por defecto
        filteredBooks = bookPDFs.filter(book => book.course === '4to Básico' && book.subject === 'Matemáticas');
      }
    } else if (user.role === 'student' || user.role === 'estudiante') {
      // Para estudiantes: tomar cursos desde asignaciones y normalizar
      const accessibleCourses = getStudentAccessibleCourses();
      console.log('📚 [Libros] Estudiante - Cursos accesibles (normalizados):', accessibleCourses);
      
      filteredBooks = bookPDFs.filter(book => {
        const match = accessibleCourses.some(c => bookMatchesCourse(book.course, c));
        if (match) {
          console.log(`✅ [Libros] Match encontrado: ${book.course} para estudiante`);
        }
        return match;
      });
      
      console.log(`📚 [Libros] Libros filtrados para estudiante: ${filteredBooks.length}`);
    } else if (user.role === 'guardian') {
      // 👨‍👩‍👧 Para apoderados: mostrar libros de los cursos de sus estudiantes asignados
      const accessibleCourses = getGuardianAccessibleCourses();
      console.log('👨‍👩‍👧 [Libros] Apoderado - Cursos accesibles (normalizados):', accessibleCourses);
      
      filteredBooks = bookPDFs.filter(book => {
        const match = accessibleCourses.some(c => bookMatchesCourse(book.course, c));
        if (match) {
          console.log(`✅ [Libros] Match encontrado: ${book.course} para apoderado`);
        }
        return match;
      });
      
      console.log(`👨‍👩‍👧 [Libros] Libros filtrados para apoderado: ${filteredBooks.length}`);
    } else {
      // Admin u otros roles: lógica existente
      const accessibleCourses = getAccessibleCourses();
      filteredBooks = bookPDFs.filter(book => accessibleCourses.includes(book.course));
    }
    
    // Agrupar libros filtrados por curso
    const grouped = filteredBooks.reduce((acc, book) => {
      if (!acc[book.course]) {
        acc[book.course] = [];
      }
      acc[book.course].push(book);
      return acc;
    }, {} as Record<string, BookPDF[]>);

    return grouped;
  }, [user.role, user.id, user.username, getAccessibleCourses]);

  // 📚 FUNCIÓN PARA VERIFICAR ACCESO A UN LIBRO ESPECÍFICO
  const hasAccessToBook = (book: BookPDF) => {
    if (user.role === 'teacher') {
      const teacherAssignments = getTeacherAssignedSubjects();
      
      if (!teacherAssignments) return false;
      
      const courseMatch = teacherAssignments.courses.some(c => bookMatchesCourse(book.course, c));
      const subjectMatch = teacherAssignments.subjects.some(subject => 
        book.subject.toLowerCase().includes(subject.toLowerCase()) ||
        subject.toLowerCase().includes(book.subject.toLowerCase())
      );
      
      return courseMatch && subjectMatch;
    } else if (user.role === 'student' || user.role === 'estudiante') {
      const accessibleCourses = getStudentAccessibleCourses();
      return accessibleCourses.some(c => bookMatchesCourse(book.course, c));
    } else if (user.role === 'guardian') {
      // 👨‍👩‍👧 Para apoderados: verificar si el libro está en los cursos de sus estudiantes
      const accessibleCourses = getGuardianAccessibleCourses();
      return accessibleCourses.some(c => bookMatchesCourse(book.course, c));
    } else {
      // Admin u otros roles
      const accessibleCourses = getAccessibleCourses();
      return accessibleCourses.includes(book.course);
    }
  };

  const handleDownloadPdf = (book: BookPDF) => {
    // 🎓 VERIFICAR ACCESO ESPECÍFICO PARA PROFESORES
    if (user.role === 'teacher') {
      const teacherAssignments = getTeacherAssignedSubjects();
      
      if (teacherAssignments) {
        const courseMatch = teacherAssignments.courses.includes(book.course);
        const subjectMatch = teacherAssignments.subjects.some(subject => 
          book.subject.toLowerCase().includes(subject.toLowerCase()) ||
          subject.toLowerCase().includes(book.subject.toLowerCase())
        );
        
        if (!courseMatch || !subjectMatch) {
          toast({
            title: translate('accessDenied'),
            description: `No tienes asignado el curso "${book.course}" o la asignatura "${book.subject}"`,
            variant: 'destructive'
          });
          return;
        }
      } else {
        toast({
          title: translate('accessDenied'),
          description: translate('couldNotVerifyAssignments'),
          variant: 'destructive'
        });
        return;
      }
    } else if (user.role === 'student' || user.role === 'estudiante') {
      // Para estudiantes: verificar usando cursos accesibles
      const accessibleCourses = getStudentAccessibleCourses();
      if (!accessibleCourses.includes(book.course)) {
        toast({
          title: translate('accessDenied'),
          description: translate('noBookPermissions'),
          variant: 'destructive'
        });
        return;
      }
    } else if (user.role === 'guardian') {
      // 👨‍👩‍👧 Para apoderados: verificar usando cursos de sus estudiantes
      const accessibleCourses = getGuardianAccessibleCourses();
      if (!accessibleCourses.includes(book.course)) {
        toast({
          title: translate('accessDenied'),
          description: translate('noBookPermissions'),
          variant: 'destructive'
        });
        return;
      }
    } else {
      // Para admin y otros, usar verificación existente
      if (!hasAccessToCourse(book.course)) {
        toast({
          title: translate('accessDenied'),
          description: translate('noBookPermissions'),
          variant: 'destructive'
        });
        return;
      }
    }

    window.open(book.pdfUrl, '_blank');
    toast({
      title: translate('pdfOpened'),
      description: translate('openingBook', { title: book.title }),
      variant: 'default'
    });
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <Library className="w-12 h-12 text-green-500 dark:text-green-400" />
        </div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          {translate('digitalLibraryTitle')}
        </h1>
        <p className="text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
          {translate('digitalLibraryDescription')}
        </p>
        
        {/* 🎓 INFORMACIÓN DE ASIGNACIONES PARA PROFESORES */}
        {user.role === 'teacher' && (() => {
          const teacherAssignments = getTeacherAssignedSubjects();
          
          if (teacherAssignments) {
            return (
              <div className="mt-6 p-4 bg-blue-50 dark:bg-slate-800 rounded-lg border border-blue-200 dark:border-slate-600">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <GraduationCap className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  <h3 className="text-lg font-semibold text-blue-800 dark:text-blue-300">
                    {translate('teacherAcademicAssignments')}
                  </h3>
                </div>
                <p className="text-sm text-blue-700 dark:text-blue-300 mb-3">
                  {translate('teacherBooksAccessInfo')}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {/* Mostrar cursos */}
                  {teacherAssignments.courses.map((course, index) => (
                    <Badge key={`course-${index}`} variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300">
                      📚 {translateCourse(course)}
                    </Badge>
                  ))}
                  {/* Mostrar asignaturas */}
                  {teacherAssignments.subjects.map((subject, index) => (
                    <Badge key={`subject-${index}`} variant="outline" className="border-blue-300 text-blue-700 dark:border-blue-600 dark:text-blue-300">
                      🎯 {translateSubject(subject)}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          }
          
          return (
            <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700">
              <div className="flex items-center justify-center gap-2 mb-2">
                <GraduationCap className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <h3 className="text-lg font-semibold text-amber-800 dark:text-amber-300">
                  {translate('informationNotAvailable')}
                </h3>
              </div>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {translate('couldNotLoadAssignments')}
              </p>
            </div>
          );
        })()}

        {/* 👨‍👩‍👧 INFORMACIÓN DE CURSOS PARA APODERADOS */}
        {user.role === 'guardian' && (() => {
          const accessibleCourses = getGuardianAccessibleCourses();
          
          if (accessibleCourses.length > 0) {
            return (
              <div className="mt-6 p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-700">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <Users className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                  <h3 className="text-lg font-semibold text-purple-800 dark:text-purple-300">
                    {translate('guardianBooksTitle') || 'Biblioteca de tus Estudiantes'}
                  </h3>
                </div>
                <p className="text-sm text-purple-700 dark:text-purple-300 mb-3">
                  {translate('guardianBooksAccessInfo') || 'Tienes acceso a los libros de los cursos asignados a tus estudiantes'}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {accessibleCourses.map((course, index) => (
                    <Badge key={`course-${index}`} variant="secondary" className="bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300">
                      📚 {translateCourse(course)}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          }
          
          return (
            <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Users className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <h3 className="text-lg font-semibold text-amber-800 dark:text-amber-300">
                  {translate('noStudentsAssigned') || 'Sin estudiantes asignados'}
                </h3>
              </div>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {translate('contactAdminForStudentAssignment') || 'Contacta al administrador para asignar estudiantes a tu cuenta.'}
              </p>
            </div>
          );
        })()}

        {/* 📚 INFORMACIÓN DE CURSO PARA ESTUDIANTES */}
        {(user.role === 'student' || user.role === 'estudiante') && (() => {
          const accessibleCourses = getStudentAccessibleCourses();
          
          if (accessibleCourses.length > 0) {
            return (
              <div className="mt-6 p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-700">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <GraduationCap className="w-5 h-5 text-green-600 dark:text-green-400" />
                  <h3 className="text-lg font-semibold text-green-800 dark:text-green-300">
                    {translate('yourCourseBooks') || 'Libros de tu Curso'}
                  </h3>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {accessibleCourses.map((course, index) => (
                    <Badge key={`course-${index}`} variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300">
                      📚 {translateCourse(course)}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          }
          
          return null;
        })()}
      </div>

      {/* Books List */}
      <div className="space-y-8">
        {/* 📊 CONTADOR DE LIBROS PARA PROFESORES */}
        {user.role === 'teacher' && Object.keys(booksByCourse).length > 0 && (
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-900/20 rounded-full border border-green-200 dark:border-green-700">
              <Book className="w-4 h-4 text-green-600 dark:text-green-400" />
              <span className="text-sm font-medium text-green-700 dark:text-green-300">
                {Object.values(booksByCourse).flat().length} {translate('booksAvailableForAssignments')}
              </span>
            </div>
          </div>
        )}
        
        {Object.keys(booksByCourse).length === 0 ? (
          <div className="text-center py-12">
            <Library className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
            {user.role === 'teacher' ? (
              <div>
                <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
                  {translate('noBooksAvailableForAssignments')}
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  {translate('onlyAccessAssignedBooks')}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500">
                  {translate('contactAdminIfError')}
                </p>
              </div>
            ) : (
              <div>
                <h3 className="text-xl font-semibold text-muted-foreground mb-2">
                  {translate('noAccessToBooks')}
                </h3>
                <p className="text-muted-foreground">
                  {translate('contactAdminForAccess')}
                </p>
              </div>
            )}
          </div>
        ) : (
          Object.entries(booksByCourse).map(([course, books]) => (
            <div key={course} className="space-y-4">
              {/* Course Title */}
              <div className="flex items-center gap-3 mb-6">
                <GraduationCap className="w-6 h-6 text-green-600" />
                <h2 className="text-2xl font-bold text-foreground">{translateCourse(course)}</h2>
                <Badge variant="secondary" className="ml-auto">
                  {books.length} {books.length === 1 ? translate('bookSingular') : translate('bookPlural')}
                </Badge>
              </div>

              {/* Books Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {books.map((book, index) => {
                  const { icon: SubjectIcon, color } = getSubjectIconAndColor(book.subject);
                  return (
                    <Card key={`${book.course}-${book.subject}-${index}`} className="hover:shadow-lg transition-shadow duration-200 flex flex-col">
                      <CardHeader className="pb-3 flex-grow">
                        <div className="flex items-start gap-2">
                          <SubjectIcon className={`w-5 h-5 ${color} mt-1 flex-shrink-0`} />
                          <div className="min-w-0 flex-1">
                            <CardTitle className="text-base font-semibold leading-tight line-clamp-2">
                              {translateSubject(book.subject)}
                            </CardTitle>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0 mt-auto">
                        <div className="space-y-3">
                          <Badge variant="outline" className="text-xs">
                            {translateCourse(book.course)}
                          </Badge>
                          <Button
                            variant="outline"
                            onClick={() => handleDownloadPdf(book)}
                            className={cn(
                              "home-card-button home-card-button-green",
                              "hover:shadow-lg hover:scale-105 transition-all duration-200"
                            )}
                            size="sm"
                            disabled={!hasAccessToBook(book)}
                          >
                            <Download className="mr-2 h-4 w-4" />
                            {translate('downloadPDF')}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
