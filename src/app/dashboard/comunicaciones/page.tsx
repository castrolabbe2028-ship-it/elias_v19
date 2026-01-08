"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { useLanguage } from '@/contexts/language-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Send, Trash2, Edit, Megaphone, Users, UserCheck, Calendar, Search, Eye, Shield } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { LocalStorageManager } from '@/lib/education-utils';
import { sendEmailOnNotification } from '@/services/email-notification.service';

// Tipos de datos
interface Communication {
  id: string;
  title: string;
  content: string;
  type: 'course' | 'student';
  targetCourse?: string;
  targetSection?: string;
  // Fallbacks amigables para mostrar en historial si faltan datos en memoria
  targetCourseName?: string;
  targetSectionName?: string;
  targetStudent?: string;
  createdBy: string;
  senderId: string;
  createdAt: string;
  readBy: string[];
  // Marca de lectura por usuario (userId -> ISO timestamp)
  readAt?: Record<string, string>;
  // Adjuntos opcionales (slides compartidos)
  attachment?: {
    type: 'slide';
    slideId: string;
    slide?: {
      id: string;
      title?: string;
      topic?: string;
      subjectName?: string;
      slideCount?: number;
  slides?: Array<{ title?: string; content?: string[]; imageUrl?: string }>;
    };
  };
}

interface Course {
  id: string;
  name: string;
}

interface Section {
  id: string;
  name: string;
  courseId: string;
}

// Nueva interfaz para cursos-sección combinados
interface CourseSection {
  id: string;
  name: string; // "5to Básico A"
  courseId: string;
  sectionId: string;
  courseName: string;
  sectionName: string;
}

interface Student {
  id: string;
  username: string;
  displayName: string;
  email: string;
  assignedCourses: string[];
}

export default function ComunicacionesPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const { translate, language } = useLanguage();

  // Formateador consistente de fecha y hora en una sola línea, según idioma actual
  const formatDateTimeOneLine = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const locale = language === 'en' ? 'en-US' : 'es-CL';
      return date.toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  };
  
  // Función helper para generar claves únicas más robustas
  const generateUniqueKey = (prefix: string, id: string, index?: number, suffix?: string) => {
    const timestamp = Date.now().toString(36); // Base36 para ser más compacto
    const random = Math.random().toString(36).substr(2, 5); // 5 caracteres aleatorios
    let baseKey = `${prefix}-${id}`;
    
    if (index !== undefined) {
      baseKey += `-${index}`;
    }
    
    if (suffix) {
      baseKey += `-${suffix}`;
    }
    
    // Agregar timestamp y random para garantizar unicidad absoluta
    const finalKey = `${baseKey}-${timestamp}-${random}`;
    
    // Log para debugging (remover en producción)
    if (process.env.NODE_ENV === 'development') {
      console.log(`🔑 Generated key: ${finalKey}`);
    }
    
    return finalKey;
  };
  
  // Estados para el formulario (solo para profesores)
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    type: 'course' as 'course' | 'student',
    targetCourse: '',
    targetSection: '',
    targetStudent: '',
  selectedCourseForStudent: '', // Nuevo campo para curso cuando se selecciona estudiante específico
  selectedStudents: [] as string[] // múltiples destinatarios (ids)
  });
  
  // Estados para datos
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [courseSections, setCourseSections] = useState<CourseSection[]>([]); // Nuevo estado para cursos-sección
  const [students, setStudents] = useState<Student[]>([]);
  const [availableSections, setAvailableSections] = useState<Section[]>([]);
  const [availableStudents, setAvailableStudents] = useState<Student[]>([]);
  const [teacherCourses, setTeacherCourses] = useState<Course[]>([]); // Nuevo estado para cursos del profesor
  const [searchTerm, setSearchTerm] = useState('');
  const [editingCommunication, setEditingCommunication] = useState<Communication | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  
  // Estados específicos para estudiantes
  const [receivedCommunications, setReceivedCommunications] = useState<Communication[]>([]);
  const [selectedCommunication, setSelectedCommunication] = useState<Communication | null>(null);
  const [showCommunicationDialog, setShowCommunicationDialog] = useState(false);
  
  // Estados de validación
  const [errors, setErrors] = useState<Record<string, string>>({});
  
  // Estado adicional para forzar re-render completo cuando sea necesario
  const [forceRenderKey, setForceRenderKey] = useState(0);

  // Memoizar listas para evitar re-renders innecesarios
  const memoizedCourseSections = useMemo(() => courseSections, [courseSections]);
  const memoizedAvailableStudents = useMemo(() => availableStudents, [availableStudents]);
  const memoizedCommunications = useMemo(() => communications, [communications]);
  const memoizedReceivedCommunications = useMemo(() => receivedCommunications, [receivedCommunications]);

  // Deep-link: abrir automáticamente una comunicación cuando viene ?commId= en la URL
  useEffect(() => {
    try {
      const commId = searchParams?.get('commId');
      if (!commId) return;

      // Buscar primero en las recibidas (estudiante), luego en todas
      const pool = user?.role === 'student' && receivedCommunications.length > 0
        ? receivedCommunications
        : communications;
      const target = pool.find(c => c.id === commId);
      if (target) {
        handleViewCommunication(target);
        // Limpiar el query param para evitar reabrir
        try { router.replace('/dashboard/comunicaciones'); } catch {}
      }
    } catch (e) {
      console.warn('[Comunicaciones] Error handling commId query param:', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, receivedCommunications, communications, user]);

  // Cargar datos iniciales
  useEffect(() => {
    loadData();
  }, []);

  // Forzar re-render cuando cambien los datos críticos
  useEffect(() => {
    setForceRenderKey(prev => prev + 1);
  }, [courseSections, availableStudents]);

  // Si es estudiante, recalcular sus comunicaciones cuando ya tengamos catálogos
  useEffect(() => {
    if (user?.role === 'student' && communications.length > 0) {
      loadStudentCommunications(communications);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses, sections, communications]);

  // Enriquecer comunicaciones con nombres de curso/sección cuando carguen catálogos
  useEffect(() => {
    if (communications.length === 0 || (courses.length === 0 && sections.length === 0)) return;
    let changed = false;
    const enriched = communications.map((comm) => {
      if (comm.type === 'course') {
        const courseName = comm.targetCourseName || courses.find(c => c.id === comm.targetCourse)?.name;
        const sectionName = comm.targetSectionName || sections.find(s => s.id === comm.targetSection)?.name;
        if (courseName !== comm.targetCourseName || sectionName !== comm.targetSectionName) {
          changed = true;
          return { ...comm, targetCourseName: courseName, targetSectionName: sectionName };
        }
      }
      return comm;
    });
    if (changed) {
      setCommunications(enriched);
      try { localStorage.setItem('smart-student-communications', JSON.stringify(enriched)); } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses, sections]);

  // Filtrar estudiantes cuando cambia el tipo o curso/sección
  useEffect(() => {
    if (formData.type === 'student') {
      let filteredStudents = [...students];
      
      console.log('🔍 DEBUG Filtrado - students cargados:', students.length);
      console.log('🔍 DEBUG Filtrado - selectedCourseForStudent:', formData.selectedCourseForStudent);

      // Filtrar por curso-sección seleccionado
      if (formData.selectedCourseForStudent) {
        const selectedCourseSection = courseSections.find(cs => cs.id === formData.selectedCourseForStudent);
        const courseName = selectedCourseSection?.courseName;
        const courseId = selectedCourseSection?.courseId;
        const sectionId = selectedCourseSection?.sectionId;
        
        console.log('🔍 DEBUG Filtrado - courseSection encontrado:', selectedCourseSection);
        console.log('🔍 DEBUG Filtrado - courseId:', courseId, 'sectionId:', sectionId);

        try {
          // Buscar asignaciones en storage por año (2025) Y legacy
          const currentYear = new Date().getFullYear();
          const storedYear = localStorage.getItem(`smart-student-student-assignments-${currentYear}`);
          const storedLegacy = localStorage.getItem('smart-student-student-assignments');
          const stored = storedYear || storedLegacy;
          
          console.log('🔍 DEBUG Filtrado - stored assignments found:', !!stored);
          
          if (stored && sectionId) {
            const assignments = JSON.parse(stored);
            console.log('🔍 DEBUG Filtrado - total assignments:', assignments.length);
            
            // Filtrar por sectionId
            const matchingAssignments = assignments.filter((a: any) => a.sectionId === sectionId);
            console.log('🔍 DEBUG Filtrado - matching sectionId:', matchingAssignments.length);
            
            const allowedIds = new Set(matchingAssignments.map((a: any) => a.studentId));
            console.log('🔍 DEBUG Filtrado - allowedIds:', Array.from(allowedIds));
            
            if (allowedIds.size > 0) {
              filteredStudents = filteredStudents.filter(s => allowedIds.has(s.id));
              console.log('🔍 DEBUG Filtrado - filteredStudents por sectionId:', filteredStudents.length);
            } else {
              // Si no hay asignaciones específicas, intentar filtro por courseId también
              const courseMatchingAssignments = assignments.filter((a: any) => a.courseId === courseId);
              const courseAllowedIds = new Set(courseMatchingAssignments.map((a: any) => a.studentId));
              
              if (courseAllowedIds.size > 0) {
                filteredStudents = filteredStudents.filter(s => courseAllowedIds.has(s.id));
                console.log('🔍 DEBUG Filtrado - filteredStudents por courseId:', filteredStudents.length);
              }
            }
          }
          
          // Fallback: Si no hay estudiantes después del filtro, usar activeCourses
          if (filteredStudents.length === 0 && courseName) {
            console.log('🔍 DEBUG Filtrado - Usando fallback por activeCourses');
            filteredStudents = students.filter(student => 
              student.assignedCourses?.some((c: any) => 
                typeof c === 'string' ? c.includes(courseName) : c?.name?.includes(courseName)
              )
            );
            console.log('🔍 DEBUG Filtrado - filteredStudents por activeCourses:', filteredStudents.length);
          }
          
          // Último fallback: mostrar todos los estudiantes si no hay ningún filtro que funcione
          if (filteredStudents.length === 0) {
            console.log('🔍 DEBUG Filtrado - Sin estudiantes, mostrando todos los disponibles');
            filteredStudents = [...students];
          }
        } catch (e) {
          console.error('🔍 DEBUG Filtrado - Error:', e);
          // Si algo falla, mostrar todos los estudiantes
          filteredStudents = [...students];
        }
      }

      console.log('🔍 DEBUG Filtrado - FINAL availableStudents:', filteredStudents.length);
      setAvailableStudents(filteredStudents);
    } else {
      setAvailableStudents([]);
      setFormData(prev => ({ 
        ...prev, 
        targetStudent: '',
  selectedCourseForStudent: '',
  selectedStudents: []
      }));
    }
  }, [formData.type, formData.selectedCourseForStudent, students, courseSections]);

  const loadData = () => {
    try {
      // Cargar comunicaciones
      const storedCommunications = localStorage.getItem('smart-student-communications');
      if (storedCommunications) {
        const allCommunications = JSON.parse(storedCommunications);

        // Migración/normalización: separar courseId y sectionId si vienen combinados
        let changed = false; // Variable para rastrear cambios
        const normalized: Communication[] = allCommunications.map((comm: any) => {
          if (comm?.type === 'course') {
            let courseId = comm.targetCourse || '';
            let sectionId = comm.targetSection || '';

            // Si alguno viene combinado, separarlo (soporta "courseId::sectionId" y 5+5 con guiones)
            const trySplit = (val: string) => {
              if (typeof val !== 'string') return null;
              if (val.includes('::')) {
                const [c, s] = val.split('::');
                if (c && s) return { c, s };
              }
              const parts = val.split('-');
              if (parts.length >= 10) {
                const c = parts.slice(0, 5).join('-');
                const s = parts.slice(5, 10).join('-');
                if (c && s) return { c, s };
              }
              return null;
            };

            const fromCourse = trySplit(courseId);
            const fromSection = trySplit(sectionId);

            if (fromCourse && (!sectionId || sectionId === courseId || fromSection)) { 
              courseId = fromCourse.c;
              sectionId = fromCourse.s;
              changed = true;
            } else if (fromSection) {
              courseId = fromSection.c;
              sectionId = fromSection.s;
              changed = true;
            }

            if (changed) { 
              return { ...comm, targetCourse: courseId, targetSection: sectionId } as Communication;
            }
          }
          return comm as Communication;
        });

        if (changed) {
          localStorage.setItem('smart-student-communications', JSON.stringify(normalized));
        }

        const finalCommunications: Communication[] = changed ? normalized : allCommunications;
        setCommunications(finalCommunications);
        
        // Si es estudiante, filtrar comunicaciones dirigidas a él usando la lista final
        if (user?.role === 'student') {
          loadStudentCommunications(finalCommunications);
        }
        
        // Si es apoderado, filtrar comunicaciones de sus estudiantes asignados
        if (user?.role === 'guardian') {
          loadGuardianCommunications(finalCommunications);
        }
      }

      // Cargar cursos y secciones reales del sistema usando LocalStorageManager
      // Usar versiones con año actual para compatibilidad con carga masiva
      const currentYear = new Date().getFullYear();
      const coursesData = LocalStorageManager.getCoursesForYear(currentYear);
      const sectionsData = LocalStorageManager.getSectionsForYear(currentYear);
      
      console.log('🔍 DEBUG - Cursos cargados (año ' + currentYear + '):', coursesData);
      console.log('🔍 DEBUG - Secciones cargadas (año ' + currentYear + '):', sectionsData);
      
      setCourses(coursesData);
      setSections(sectionsData);

      // Si es profesor, crear cursos-sección basados en asignaciones reales del módulo admin
      if (user?.role === 'teacher') {
        console.log('🔍 DEBUG - Usuario es profesor:', user.id, user.username);
        
        // Obtener asignaciones de profesores desde múltiples fuentes
        // 1. Buscar en el storage sin año (legacy)
        const legacyAssignments = JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]');
        
        // 2. Buscar en el storage por año (nuevo formato)
        const yearAssignments = LocalStorageManager.getTeacherAssignmentsForYear(currentYear);
        
        // Combinar todas las asignaciones
        const allAssignments = [...legacyAssignments, ...yearAssignments];
        
        // Eliminar duplicados por id
        const uniqueAssignmentsMap = new Map();
        allAssignments.forEach((a: any) => {
          if (a && a.id) {
            uniqueAssignmentsMap.set(a.id, a);
          } else if (a && a.teacherId && a.sectionId) {
            // Si no hay id, crear una clave única
            uniqueAssignmentsMap.set(`${a.teacherId}-${a.sectionId}-${a.subjectId || ''}`, a);
          }
        });
        const teacherAssignments = Array.from(uniqueAssignmentsMap.values());
        
        console.log('🔍 DEBUG - Asignaciones legacy:', legacyAssignments.length);
        console.log('🔍 DEBUG - Asignaciones por año:', yearAssignments.length);
        console.log('🔍 DEBUG - Total asignaciones combinadas:', teacherAssignments.length);
        
        // Buscar asignaciones del profesor actual
        // Buscar por teacherId O teacherUsername (igual que en admin/page.tsx)
        const currentTeacherAssignments = teacherAssignments.filter((assignment: any) => 
          assignment.teacherId === user.id || 
          assignment.teacherId === user.username ||
          assignment.teacherUsername === user.username ||
          assignment.teacherUsername === user.id
        );
        console.log('🔍 DEBUG - user.id:', user.id, 'user.username:', user.username);
        console.log('🔍 DEBUG - Asignaciones del profesor actual:', currentTeacherAssignments);
        
        // Obtener sectionIds únicos asignados al profesor
        const assignedSectionIds = [...new Set(currentTeacherAssignments.map((assignment: any) => assignment.sectionId))];
        console.log('🔍 DEBUG - IDs de secciones asignadas:', assignedSectionIds);
        
        // Crear cursos-sección solo para las secciones asignadas
        const assignedCourseSections = sectionsData
          .filter((section: any) => assignedSectionIds.includes(section.id))
          .map((section: any) => {
            const course = coursesData.find((course: any) => course.id === section.courseId);
            console.log(`🔍 DEBUG - Mapeando sección ${section.id} (${section.name}) con curso:`, course);
            return {
              id: `${section.courseId}-${section.id}`,
              name: `${course?.name || 'Curso'} ${section.name}`, // "5to Básico A"
              courseId: section.courseId,
              sectionId: section.id,
              courseName: course?.name || 'Curso',
              sectionName: section.name
            };
          });
        
        console.log('🔍 DEBUG - Cursos-sección creados:', assignedCourseSections);
        setCourseSections(assignedCourseSections);
        
        // Debug: Verificar IDs únicos
        const sectionIds = assignedCourseSections.map((cs: CourseSection) => cs.id);
        const uniqueIds = [...new Set(sectionIds)];
        if (sectionIds.length !== uniqueIds.length) {
          console.warn('⚠️ ADVERTENCIA: Se detectaron IDs de curso-sección duplicados');
          console.log('IDs originales:', sectionIds);
          console.log('IDs únicos:', uniqueIds);
        } else {
          console.log('✅ Todos los IDs de curso-sección son únicos');
        }
        
        // Crear lista de cursos únicos asignados al profesor para selector de estudiantes específicos
        const uniqueCourseIds = [...new Set(assignedCourseSections.map((cs: CourseSection) => cs.courseId))];
        const assignedCourses = coursesData.filter((course: any) => uniqueCourseIds.includes(course.id));
        console.log('🔍 DEBUG - Cursos únicos del profesor:', assignedCourses);
        setTeacherCourses(assignedCourses);
        
        // Si no hay asignaciones, mostrar mensaje en consola
        if (assignedCourseSections.length === 0) {
          console.log('❌ PROBLEMA: No se encontraron cursos-sección para el profesor');
          console.log('💡 SOLUCIÓN: Ve al módulo Admin > Gestión de Usuarios > Asignaciones');
          console.log('💡 O ejecuta el script DIAGNOSTICO-COMUNICACIONES.js');
        }
        
        // Cargar estudiantes
        const storedUsers = localStorage.getItem('smart-student-users');
        if (storedUsers) {
          const users = JSON.parse(storedUsers);
          const studentUsers = users.filter((u: any) => u.role === 'student').map((u: any) => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            email: u.email || '',
            assignedCourses: u.activeCourses || []
          }));
          setStudents(studentUsers);
        }
      } else {
        // Para estudiantes o admin, mostrar todos los cursos-sección
        const allCourseSections = sectionsData.map((section: any) => {
          const course = coursesData.find((course: any) => course.id === section.courseId);
          return {
            id: `${section.courseId}-${section.id}`,
            name: `${course?.name || 'Curso'} ${section.name}`,
            courseId: section.courseId,
            sectionId: section.id,
            courseName: course?.name || 'Curso',
            sectionName: section.name
          };
        });
        setCourseSections(allCourseSections);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast({
        title: translate('error') || 'Error',
        description: translate('errorLoadingData') || 'Error al cargar los datos',
        variant: 'destructive'
      });
    }
  };

  // Función para cargar comunicaciones específicas para estudiantes
  const loadStudentCommunications = (allCommunications: Communication[]) => {
    if (!user || user.role !== 'student') return;

    try {
      const currentYear = new Date().getFullYear();
      
      // Obtener asignaciones del estudiante (primero con año, luego legacy)
      let myAssignments: any[] = [];
      const yearAssignments = localStorage.getItem(`smart-student-student-assignments-${currentYear}`);
      const legacyAssignments = localStorage.getItem('smart-student-student-assignments');
      
      if (yearAssignments) {
        const all = JSON.parse(yearAssignments);
        myAssignments = all.filter((a: any) => a && (a.studentId === user.id || a.studentUsername === user.username));
      }
      if (myAssignments.length === 0 && legacyAssignments) {
        const all = JSON.parse(legacyAssignments);
        myAssignments = all.filter((a: any) => a && (a.studentId === user.id || a.studentUsername === user.username));
      }
      
      // Obtener también datos del estudiante desde students-{year}
      const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
      const studentData = studentsForYear.find((s: any) => s.id === user.id || s.username === user.username);
      
      // Si el estudiante tiene courseId/sectionId directo, usarlo
      if (myAssignments.length === 0 && studentData?.courseId && studentData?.sectionId) {
        myAssignments.push({
          studentId: user.id,
          courseId: studentData.courseId,
          sectionId: studentData.sectionId
        });
      }
      
      console.log(`🔍 DEBUG Student ${user.username}: myAssignments =`, myAssignments);
      
      const studentCommunications = allCommunications.filter(comm => {
        // Comunicaciones dirigidas específicamente a este estudiante
        if (comm.type === 'student' && (comm.targetStudent === user.id || comm.targetStudent === user.username)) {
          return true;
        }

        // Comunicaciones dirigidas al curso y sección del estudiante
        if (comm.type === 'course' && comm.targetCourse) {
          // 1) Verificar con asignaciones
          if (myAssignments.length > 0) {
            // Coincidencia por courseId + sectionId (si la comunicación tiene sección)
            if (comm.targetSection) {
              const matchCourseAndSection = myAssignments.some((a: any) => 
                a.courseId === comm.targetCourse && a.sectionId === comm.targetSection
              );
              if (matchCourseAndSection) return true;
            } else {
              // La comunicación es para todo el curso (sin sección específica)
              const matchCourse = myAssignments.some((a: any) => a.courseId === comm.targetCourse);
              if (matchCourse) return true;
            }
            
            // No coincide con ninguna asignación
            return false;
          }

          // 2) Fuente secundaria: activeCourses del perfil
          const active = (user as any).activeCourses as string[] | undefined;
          if (active && active.length > 0) {
            const course = courses.find(c => c.id === comm.targetCourse);
            const courseName = course?.name || comm.targetCourseName || '';
            const normalizedActive = active.map(v => String(v));
            
            const hasCourse = normalizedActive.some(str => {
              if (!str) return false;
              if (str === comm.targetCourse) return true;
              if (courseName && (str === courseName || str.includes(courseName))) return true;
              return false;
            });
            
            if (!hasCourse) return false;

            // Si tiene sectionName, verificar también
            const studentSectionName = (user as any).sectionName;
            if (comm.targetSection && studentSectionName && comm.targetSectionName) {
              return studentSectionName === comm.targetSectionName;
            }
            return hasCourse;
          }

          // 3) Sin asignaciones ni activeCourses: NO mostrar (evitar que llegue a todos)
          console.log(`⚠️ Student ${user.username} sin asignaciones, ignorando comunicación de curso`);
          return false;
        }

        return false;
      });

      // Ordenar por fecha (más recientes primero)
      studentCommunications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      setReceivedCommunications(studentCommunications);
      
      console.log(`📧 [Student] ${user.username} loaded ${studentCommunications.length} communications`);
    } catch (error) {
      console.error('Error loading student communications:', error);
    }
  };

  // Función para cargar comunicaciones específicas para apoderados
  const loadGuardianCommunications = (allCommunications: Communication[]) => {
    if (!user || user.role !== 'guardian') return;

    try {
      const currentYear = new Date().getFullYear();
      
      // ============ BUSCAR ESTUDIANTES ASIGNADOS (igual que perfil-client.tsx) ============
      let assignedStudentIds: string[] = [];
      
      // Prioridad 1: Buscar en smart-student-guardians-{year} (datos de carga masiva)
      const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]');
      const guardianFromYear = guardiansForYear.find((g: any) => 
        g.username?.toLowerCase() === user.username?.toLowerCase() ||
        g.id === user.id
      );
      
      console.log(`🔍 DEBUG Guardian: ${user.username} (ID: ${user.id})`);
      console.log(`🔍 DEBUG guardiansForYear (${currentYear}):`, guardiansForYear.length);
      console.log(`🔍 DEBUG guardianFromYear:`, guardianFromYear);
      
      if (guardianFromYear?.studentIds && guardianFromYear.studentIds.length > 0) {
        assignedStudentIds = guardianFromYear.studentIds;
        console.log(`🔍 DEBUG studentIds desde guardiansForYear:`, assignedStudentIds);
      }
      
      // Prioridad 2: Buscar en smart-student-guardian-student-relations-{year}
      if (assignedStudentIds.length === 0) {
        let guardianRelations = JSON.parse(localStorage.getItem(`smart-student-guardian-student-relations-${currentYear}`) || '[]');
        if (guardianRelations.length === 0) {
          guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-student-relations') || '[]');
        }
        
        assignedStudentIds = guardianRelations
          .filter((rel: any) => rel.guardianId === user.id || rel.guardianUsername === user.username)
          .map((rel: any) => rel.studentId);
        
        console.log(`🔍 DEBUG guardianRelations encontradas:`, guardianRelations.length);
        console.log(`🔍 DEBUG studentIds desde relations:`, assignedStudentIds);
      }
      
      // Prioridad 3: Buscar en smart-student-users (fullUserData.studentIds)
      if (assignedStudentIds.length === 0) {
        const storedUsers = localStorage.getItem('smart-student-users');
        if (storedUsers) {
          const usersData = JSON.parse(storedUsers);
          const fullUserData = usersData.find((u: any) => 
            u.username?.toLowerCase() === user.username?.toLowerCase()
          );
          if (fullUserData?.studentIds && fullUserData.studentIds.length > 0) {
            assignedStudentIds = fullUserData.studentIds;
            console.log(`🔍 DEBUG studentIds desde smart-student-users:`, assignedStudentIds);
          }
        }
      }
      
      console.log(`🔍 DEBUG assignedStudentIds FINAL:`, assignedStudentIds);
      
      if (assignedStudentIds.length === 0) {
        setReceivedCommunications([]);
        console.log(`📧 [Guardian] ${user.username} no tiene estudiantes asignados`);
        return;
      }

      // ============ OBTENER INFORMACIÓN DE ESTUDIANTES ============
      const storedUsers = localStorage.getItem('smart-student-users');
      const allUsers = storedUsers ? JSON.parse(storedUsers) : [];
      
      // Buscar también en smart-student-students-{year}
      const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
      
      const studentMap = new Map<string, any>();
      
      // Agregar desde studentsForYear
      studentsForYear
        .filter((s: any) => assignedStudentIds.includes(s.id) || assignedStudentIds.includes(s.username))
        .forEach((s: any) => studentMap.set(s.id, s));
      
      // Agregar desde allUsers si no están ya
      allUsers
        .filter((u: any) => (u.role === 'student' || u.type === 'student') && 
          (assignedStudentIds.includes(u.id) || assignedStudentIds.includes(u.username)))
        .forEach((u: any) => {
          if (!studentMap.has(u.id)) {
            studentMap.set(u.id, u);
          }
        });

      console.log(`🔍 DEBUG studentMap size:`, studentMap.size);

      // ============ OBTENER ASIGNACIONES DE ESTUDIANTES ============
      let studentAssignments: any[] = [];
      const yearAssignments = localStorage.getItem(`smart-student-student-assignments-${currentYear}`);
      const legacyAssignments = localStorage.getItem('smart-student-student-assignments');
      
      if (yearAssignments) {
        studentAssignments = JSON.parse(yearAssignments);
        console.log(`🔍 DEBUG usando student-assignments con año ${currentYear}:`, studentAssignments.length);
      } else if (legacyAssignments) {
        studentAssignments = JSON.parse(legacyAssignments);
        console.log(`🔍 DEBUG usando student-assignments legacy:`, studentAssignments.length);
      }
      
      // Si aún no hay, buscar en los propios estudiantes
      if (studentAssignments.length === 0) {
        console.log(`🔍 DEBUG No hay student-assignments, buscando en estudiantes...`);
        
        // Buscar en studentsForYear
        studentsForYear
          .filter((s: any) => assignedStudentIds.includes(s.id) || assignedStudentIds.includes(s.username))
          .forEach((s: any) => {
            if (s.courseId && s.sectionId) {
              studentAssignments.push({
                studentId: s.id,
                courseId: s.courseId,
                sectionId: s.sectionId
              });
            }
          });
        
        // Buscar en allUsers
        allUsers
          .filter((u: any) => (u.role === 'student' || u.type === 'student') && 
            (assignedStudentIds.includes(u.id) || assignedStudentIds.includes(u.username)))
          .forEach((u: any) => {
            if (u.courseId && u.sectionId) {
              const exists = studentAssignments.find((a: any) => a.studentId === u.id);
              if (!exists) {
                studentAssignments.push({
                  studentId: u.id,
                  courseId: u.courseId,
                  sectionId: u.sectionId
                });
              }
            }
            if (u.assignedCourses?.length > 0) {
              u.assignedCourses.forEach((courseSection: string) => {
                const parts = courseSection.split('-');
                const exists = studentAssignments.find((a: any) => 
                  a.studentId === u.id && a.courseId === parts[0]
                );
                if (!exists) {
                  studentAssignments.push({
                    studentId: u.id,
                    courseId: parts[0],
                    sectionId: parts[1] || parts[0]
                  });
                }
              });
            }
          });
        
        console.log(`🔍 DEBUG asignaciones construidas:`, studentAssignments.length);
      }

      // ============ PROCESAR COMUNICACIONES ============
      const guardianCommunications: (Communication & { studentInfo?: { id: string; name: string; courseName?: string; sectionName?: string } })[] = [];

      console.log(`🔍 DEBUG procesando ${allCommunications.length} comunicaciones...`);

      allCommunications.forEach(comm => {
        // Comunicaciones dirigidas específicamente a alguno de los estudiantes asignados
        if (comm.type === 'student' && comm.targetStudent) {
          // Verificar si el targetStudent está en assignedStudentIds (por id o username)
          const isAssigned = assignedStudentIds.includes(comm.targetStudent) || 
            Array.from(studentMap.values()).some((s: any) => 
              s.username === comm.targetStudent && assignedStudentIds.includes(s.id)
            );
          
          if (isAssigned) {
            const student = studentMap.get(comm.targetStudent) || 
              Array.from(studentMap.values()).find((s: any) => s.username === comm.targetStudent);
            
            console.log(`🔍 DEBUG Comunicación tipo student encontrada para:`, comm.targetStudent);
            guardianCommunications.push({
              ...comm,
              studentInfo: student ? {
                id: student.id,
                name: student.displayName || student.name || student.username,
                courseName: comm.targetCourseName,
                sectionName: comm.targetSectionName
              } : undefined
            });
          }
          return;
        }

        // Comunicaciones de curso: verificar si algún estudiante asignado pertenece al curso/sección
        if (comm.type === 'course' && comm.targetCourse) {
          console.log(`🔍 DEBUG Comunicación tipo course: ${comm.targetCourse}/${comm.targetSection}`);
          
          // Buscar qué estudiantes asignados al apoderado pertenecen a este curso/sección
          const matchingStudents = studentAssignments.filter((a: any) => {
            if (!a) return false;
            
            // Verificar que es un estudiante asignado al apoderado
            const isAssigned = assignedStudentIds.includes(a.studentId) ||
              Array.from(studentMap.keys()).includes(a.studentId);
            
            if (!isAssigned) return false;
            
            // Comparar curso
            const courseMatch = a.courseId === comm.targetCourse;
            
            // Comparar sección (si existe en la comunicación)
            const sectionMatch = !comm.targetSection || a.sectionId === comm.targetSection;
            
            return courseMatch && sectionMatch;
          });

          console.log(`🔍 DEBUG matchingStudents para ${comm.targetCourse}:`, matchingStudents.length);

          matchingStudents.forEach((assignment: any) => {
            const student = studentMap.get(assignment.studentId);
            if (student) {
              guardianCommunications.push({
                ...comm,
                id: `${comm.id}_${student.id}`, // ID único por estudiante para evitar duplicados en la UI
                studentInfo: {
                  id: student.id,
                  name: student.displayName || student.name || student.username,
                  courseName: comm.targetCourseName,
                  sectionName: comm.targetSectionName
                }
              });
            }
          });
        }
      });

      // Ordenar por fecha (más recientes primero)
      guardianCommunications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      setReceivedCommunications(guardianCommunications);
      
      console.log(`📧 [Guardian] ${user.username} loaded ${guardianCommunications.length} communications for ${assignedStudentIds.length} students`);
    } catch (error) {
      console.error('Error loading guardian communications:', error);
      setReceivedCommunications([]);
    }
  };

  // Función para manejar la visualización de comunicaciones por estudiantes
  const handleViewCommunication = (communication: Communication) => {
    setSelectedCommunication(communication);
    setShowCommunicationDialog(true);
    
    // Marcar como leída si no lo está
    if (!communication.readBy?.includes(user?.id || '')) {
      markCommunicationAsRead(communication.id);
    }
  };

  // Función para marcar comunicación como leída
  const markCommunicationAsRead = (communicationId: string, studentId?: string) => {
    if (!user) return;

    try {
      // 🔧 CORRECCIÓN APODERADO: Extraer ID original y studentId si es un ID modificado con _studentId
      // Las comunicaciones de curso para apoderados tienen formato: "originalId_studentId"
      let originalCommId = communicationId;
      let extractedStudentId = studentId;
      
      if (user.role === 'guardian' && communicationId.includes('_')) {
        // Intentar extraer el ID original (todo antes del último _studentId)
        const parts = communicationId.split('_');
        if (parts.length >= 2) {
          // El formato es: comm_timestamp_index_studentId o comm_timestamp_studentId
          // Reconstruir el ID original removiendo el último segmento (studentId)
          const lastPart = parts[parts.length - 1];
          // Verificar si el último segmento es un studentId (usualmente un UUID o ID largo)
          if (lastPart.length > 10 || lastPart.includes('-')) {
            originalCommId = parts.slice(0, -1).join('_');
            extractedStudentId = lastPart;
            console.log(`🔧 [Guardian] Extracted original communication ID: ${originalCommId}, studentId: ${extractedStudentId} from ${communicationId}`);
          }
        }
      }

      // 🔧 CLAVE: Para apoderados con múltiples estudiantes, usar identificador compuesto
      // Esto permite que cada instancia (por estudiante) sea independiente
      const readByKey = (user.role === 'guardian' && extractedStudentId) 
        ? `${user.id}_forStudent_${extractedStudentId}` 
        : user.id;

      const updatedCommunications = communications.map(comm => {
        // 🔧 Buscar tanto por ID original como por ID modificado
        if (comm.id === communicationId || comm.id === originalCommId) {
          const readBy = comm.readBy || [];
          if (!readBy.includes(readByKey)) {
            return {
              ...comm,
              readBy: [...readBy, readByKey],
              readAt: { ...(comm.readAt || {}), [readByKey]: new Date().toISOString() }
            };
          } else if (!comm.readAt || !comm.readAt[readByKey]) {
            // Ya estaba marcado anteriormente; aseguremos timestamp
            return {
              ...comm,
              readAt: { ...(comm.readAt || {}), [readByKey]: new Date().toISOString() }
            };
          }
        }
        return comm;
      });

  setCommunications(updatedCommunications);
  localStorage.setItem('smart-student-communications', JSON.stringify(updatedCommunications));
  try { if (editingCommunication) { window.dispatchEvent(new CustomEvent('studentCommunicationsUpdated', { detail: { action: 'edited', id: editingCommunication.id } })); } } catch {}
      
      // Actualizar las comunicaciones recibidas del estudiante
      if (user.role === 'student') {
        loadStudentCommunications(updatedCommunications);
      }
      
      // Actualizar las comunicaciones recibidas del apoderado
      if (user.role === 'guardian') {
        loadGuardianCommunications(updatedCommunications);
      }

      console.log(`📖 Communication ${communicationId} (original: ${originalCommId}) marked as read by ${user.username}`);
      // Notificar a otros módulos (dashboard/campana) para actualizar contadores
      try {
        window.dispatchEvent(new CustomEvent('studentCommunicationsUpdated', { detail: { action: 'read', userId: user.id, communicationId } }));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('studentCommunicationsUpdated', { detail: { action: 'created' } }));
      } catch {}
    } catch (error) {
      console.error('Error marking communication as read:', error);
    }
  };

  // Función para obtener información del remitente
  const getSenderInfo = (senderId: string) => {
    try {
      const storedUsers = localStorage.getItem('smart-student-users');
      if (storedUsers) {
        const users = JSON.parse(storedUsers);
        const sender = users.find((u: any) => u.id === senderId);
        return sender ? {
          name: sender.displayName || sender.username,
          email: sender.email || ''
        } : { name: translate('commUnknownSender') || 'Remitente desconocido', email: '' };
      }
    } catch (error) {
      console.error('Error getting sender info:', error);
    }
    return { name: translate('commUnknownSender') || 'Remitente desconocido', email: '' };
  };

  // Función para obtener información del curso/sección
  const getCourseInfo = (courseId: string, sectionId?: string) => {
    try {
      const course = courses.find(c => c.id === courseId);
      const section = sectionId ? sections.find(s => s.id === sectionId) : null;
      
      if (course) {
        return section 
          ? `${course.name} - ${section.name}`
          : course.name;
      }
    } catch (error) {
      console.error('Error getting course info:', error);
    }
    return translate('commUnknownCourse') || 'Curso desconocido';
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.title.trim()) {
      newErrors.title = translate('titleRequired') || 'El título es obligatorio';
    }

    if (!formData.content.trim()) {
      newErrors.content = translate('contentRequired') || 'El contenido es obligatorio';
    }

    if (formData.type === 'course') {
      if (!formData.targetCourse || !formData.targetSection) {
        newErrors.targetCourse = translate('courseRequired') || 'Selecciona un curso-sección';
      }
      // Ya no necesitamos validar targetSection por separado
    } else if (formData.type === 'student') {
      if (!formData.selectedCourseForStudent) {
        newErrors.selectedCourseForStudent = translate('courseRequired') || 'Selecciona un curso';
      }
      if (!formData.targetStudent && (formData.selectedStudents?.length || 0) === 0) {
        newErrors.targetStudent = translate('studentRequired') || 'Selecciona al menos un estudiante';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    try {
      let updatedCommunications = [...communications];

  if (formData.type === 'student') {
        // Destinatarios: los seleccionados o el actual del Select si no se agregó a la lista
        const recipients = (formData.selectedStudents && formData.selectedStudents.length > 0)
          ? formData.selectedStudents
          : (formData.targetStudent ? [formData.targetStudent] : []);

    recipients.forEach((studentId, i) => {
          // Obtener curso/sección: primero desde selectedCourseForStudent, luego desde estudiante
          let studentCourseName: string | undefined;
          let studentSectionName: string | undefined;
          
          // Prioridad 1: usar el curso-sección seleccionado en el formulario
          if (formData.selectedCourseForStudent) {
            const cs = courseSections.find(c => c.id === formData.selectedCourseForStudent);
            if (cs) {
              studentCourseName = cs.courseName;
              studentSectionName = cs.sectionName;
            } else {
              // Intentar separar el ID
              if (formData.selectedCourseForStudent.includes('-')) {
                const [courseId, sectionId] = formData.selectedCourseForStudent.split('-');
                const csAlt = courseSections.find(c => c.courseId === courseId && c.sectionId === sectionId);
                if (csAlt) {
                  studentCourseName = csAlt.courseName;
                  studentSectionName = csAlt.sectionName;
                } else {
                  // Fallback localStorage
                  try {
                    const lsCourses: any[] = LocalStorageManager.getCourses() || [];
                    const lsSections: any[] = LocalStorageManager.getSections() || [];
                    const course = lsCourses.find(c => c.id === courseId);
                    const section = lsSections.find(s => s.id === sectionId);
                    if (course) studentCourseName = course.name;
                    if (section) studentSectionName = section.name;
                  } catch (e) { /* ignore */ }
                }
              }
            }
          }
          
          // Prioridad 2: si no hay curso del formulario, buscar desde estudiante
          if (!studentCourseName || !studentSectionName) {
            const student = students.find(s => s.id === studentId);
            if (student && student.assignedCourses?.length > 0) {
              const ac = student.assignedCourses[0];
              if (ac && ac.includes('-')) {
                const [courseId, sectionId] = ac.split('-');
                const cs = courseSections.find(c => c.courseId === courseId && c.sectionId === sectionId);
                if (cs) {
                  studentCourseName = studentCourseName || cs.courseName;
                  studentSectionName = studentSectionName || cs.sectionName;
                }
              }
            }
          }

          const comm: Communication = {
            id: `comm_${Date.now()}_${i}`,
            title: formData.title,
            content: formData.content,
            type: 'student',
            targetStudent: studentId,
            targetCourseName: studentCourseName,
            targetSectionName: studentSectionName,
            createdBy: user?.username || '',
            senderId: user?.id || '',
            createdAt: new Date().toISOString(),
      readBy: [],
      readAt: {}
          };
          updatedCommunications.push(comm);
        });
      } else {
        // type = 'course'. Ya tenemos courseId y sectionId en formData
        const courseId = formData.targetCourse;
        const sectionId = formData.targetSection;
        const courseName = courses.find(c => c.id === courseId)?.name;
        const sectionName = sections.find(s => s.id === sectionId)?.name;
        const comm: Communication = {
          id: `comm_${Date.now()}`,
          title: formData.title,
          content: formData.content,
          type: 'course',
          targetCourse: courseId,
          targetSection: sectionId,
          targetCourseName: courseName,
          targetSectionName: sectionName,
          createdBy: user?.username || '',
          senderId: user?.id || '',
          createdAt: new Date().toISOString(),
          readBy: [],
          readAt: {}
        };
        updatedCommunications.push(comm);
      }

      setCommunications(updatedCommunications);
      localStorage.setItem('smart-student-communications', JSON.stringify(updatedCommunications));
  try { window.dispatchEvent(new CustomEvent('studentCommunicationsUpdated', { detail: { action: 'created' } })); } catch {}

      // 📧 Enviar notificaciones por email a los destinatarios
      try {
        let recipientIds: string[] = [];
        let courseName = '';
        let sectionName = '';
        
        if (formData.type === 'student') {
          // Para comunicaciones a estudiantes específicos
          recipientIds = (formData.selectedStudents && formData.selectedStudents.length > 0)
            ? formData.selectedStudents
            : (formData.targetStudent ? [formData.targetStudent] : []);
          
          console.log(`📧 [COMUNICACIONES] Enviando a estudiante(s) específico(s):`, recipientIds);
          
          // Obtener info del curso
          if (formData.selectedCourseForStudent) {
            const cs = courseSections.find(c => c.id === formData.selectedCourseForStudent);
            if (cs) {
              courseName = cs.courseName;
              sectionName = cs.sectionName;
            }
          }
        } else {
          // Para comunicaciones a un curso/sección completo
          // Obtener todos los estudiantes del curso/sección
          const courseId = formData.targetCourse;
          const sectionId = formData.targetSection;
          courseName = courses.find(c => c.id === courseId)?.name || '';
          sectionName = sections.find(s => s.id === sectionId)?.name || '';
          
          // 📧 Buscar estudiantes del año actual que pertenecen a este curso/sección
          const savedYear = Number(localStorage.getItem('admin-selected-year') || '');
          const currentYear = Number.isFinite(savedYear) && savedYear > 0 ? savedYear : new Date().getFullYear();
          
          // 1. Buscar en estudiantes del año actual (fuente principal)
          const storedStudents = localStorage.getItem(`smart-student-students-${currentYear}`);
          if (storedStudents) {
            const allStudents = JSON.parse(storedStudents);
            const studentsInSection = allStudents.filter((s: any) => {
              // Verificar si el estudiante pertenece a la sección seleccionada
              const matchesCourse = s.courseId === courseId || s.course === courseId;
              const matchesSection = s.sectionId === sectionId || s.section === sectionId;
              // También verificar formato combinado
              const combinedId = `${courseId}-${sectionId}`;
              const matchesCombined = s.courseSectionId === combinedId || 
                                      (s.courseId === courseId && s.sectionId === sectionId);
              return matchesCourse && matchesSection || matchesCombined;
            });
            recipientIds = studentsInSection.map((s: any) => s.id);
            console.log(`📧 [COMUNICACIONES] Encontrados ${recipientIds.length} estudiantes en ${courseName} - ${sectionName}`);
          }
          
          // 2. También buscar en smart-student-users (respaldo)
          const storedUsers = localStorage.getItem('smart-student-users');
          if (storedUsers) {
            const allUsers = JSON.parse(storedUsers);
            const courseSectionKey = `${courseId}-${sectionId}`;
            const userIds = allUsers
              .filter((u: any) => 
                (u.role === 'student' || u.role === 'guardian') && 
                u.activeCourses?.some((ac: string) => ac === courseSectionKey || ac.includes(courseName))
              )
              .map((u: any) => u.id);
            recipientIds = [...new Set([...recipientIds, ...userIds])];
          }
        }
        
        // 📧 BUSCAR APODERADOS DE LOS ESTUDIANTES (múltiples fuentes)
        const studentIdsForGuardianLookup = [...recipientIds]; // Copiar los IDs de estudiantes encontrados
        console.log(`📧 [COMUNICACIONES] Buscando apoderados para ${studentIdsForGuardianLookup.length} estudiantes`);
        
        // Fuente 1: guardian-student-relations (relaciones explícitas)
        const savedYearForGuardians = Number(localStorage.getItem('admin-selected-year') || '');
        const yearForGuardians = Number.isFinite(savedYearForGuardians) && savedYearForGuardians > 0 ? savedYearForGuardians : new Date().getFullYear();
        
        let guardianRelations = JSON.parse(localStorage.getItem(`smart-student-guardian-student-relations-${yearForGuardians}`) || '[]');
        if (guardianRelations.length === 0) {
          guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-student-relations') || '[]');
        }
        
        if (guardianRelations.length > 0) {
          const guardiansFromRelations = guardianRelations
            .filter((rel: any) => studentIdsForGuardianLookup.some(sid => 
              String(rel.studentId) === String(sid) || 
              rel.studentId === sid
            ))
            .map((rel: any) => rel.guardianId);
          recipientIds = [...new Set([...recipientIds, ...guardiansFromRelations])];
          console.log(`📧 [COMUNICACIONES] Apoderados desde relations: ${guardiansFromRelations.length}`);
        }
        
        // Fuente 2: guardians-{year} (apoderados con studentIds)
        const storedGuardians = localStorage.getItem(`smart-student-guardians-${yearForGuardians}`);
        if (storedGuardians) {
          const allGuardians = JSON.parse(storedGuardians);
          const guardianIds = allGuardians
            .filter((g: any) => {
              // Verificar studentIds o students
              const gStudentIds = g.studentIds || g.assignedStudents || g.students || [];
              return gStudentIds.some((sid: string) => 
                studentIdsForGuardianLookup.some(targetId => 
                  String(sid) === String(targetId) || sid === targetId
                )
              );
            })
            .map((g: any) => g.id);
          recipientIds = [...new Set([...recipientIds, ...guardianIds])];
          console.log(`📧 [COMUNICACIONES] Apoderados desde guardians-${yearForGuardians}: ${guardianIds.length}`);
        }
        
        // Fuente 3: smart-student-users (usuarios con role guardian)
        const storedUsersForGuardians = localStorage.getItem('smart-student-users');
        if (storedUsersForGuardians) {
          const allUsers = JSON.parse(storedUsersForGuardians);
          const guardianIds = allUsers
            .filter((u: any) => {
              if (u.role !== 'guardian') return false;
              const uStudentIds = u.studentIds || u.assignedStudents || [];
              return uStudentIds.some((sid: string) => 
                studentIdsForGuardianLookup.some(targetId => 
                  String(sid) === String(targetId) || sid === targetId
                )
              );
            })
            .map((u: any) => u.id);
          recipientIds = [...new Set([...recipientIds, ...guardianIds])];
          console.log(`📧 [COMUNICACIONES] Apoderados desde smart-student-users: ${guardianIds.length}`);
        }
        
        console.log(`📧 [COMUNICACIONES] Total destinatarios para email: ${recipientIds.length}`, recipientIds);
        
        if (recipientIds.length > 0) {
          // Usar .then/.catch en lugar de await para evitar requerir async
          sendEmailOnNotification(
            'communication',
            recipientIds,
            {
              title: formData.title,
              content: formData.content,
              senderName: user?.displayName || user?.username || 'Profesor',
              courseName: courseName,
              sectionName: sectionName
            }
          ).then(() => {
            console.log(`📧 [COMUNICACIONES] Email notifications sent to ${recipientIds.length} recipients`);
          }).catch((emailError) => {
            console.warn('⚠️ [COMUNICACIONES] Error sending email notifications:', emailError);
          });
        }
      } catch (emailError) {
        console.warn('⚠️ [COMUNICACIONES] Error sending email notifications:', emailError);
        // No mostrar error al usuario, las notificaciones de campana ya se enviaron
      }

      // Limpiar formulario
      setFormData({
        title: '',
        content: '',
        type: 'course',
        targetCourse: '',
        targetSection: '',
        targetStudent: '',
        selectedCourseForStudent: '',
        selectedStudents: []
      });
      setErrors({});

      toast({
        title: translate('communicationSent') || 'Comunicación enviada',
        description: translate('communicationSentSuccess') || 'La comunicación ha sido enviada con éxito',
      });
    } catch (error) {
      console.error('Error saving communication:', error);
      toast({
        title: translate('error') || 'Error',
        description: translate('errorSavingCommunication') || 'Error al guardar la comunicación',
        variant: 'destructive'
      });
    }
  };

  const handleEdit = (communication: Communication) => {
    setEditingCommunication(communication);
    setFormData({
      title: communication.title,
      content: communication.content,
      type: communication.type,
      targetCourse: communication.targetCourse || '',
      targetSection: communication.targetSection || '',
      targetStudent: communication.targetStudent || '',
  selectedCourseForStudent: '',
  selectedStudents: []
    });
    setShowEditDialog(true);
  };

  // Manejar quitar estudiante de la lista seleccionada
  const removeSelectedStudent = (studentId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedStudents: prev.selectedStudents.filter(id => id !== studentId)
    }));
  };

  const handleUpdate = () => {
    if (!validateForm() || !editingCommunication) {
      return;
    }

    const updatedCommunication: Communication = {
      ...editingCommunication,
      title: formData.title,
      content: formData.content,
      type: formData.type,
  targetCourse: formData.type === 'course' ? formData.targetCourse : undefined,
  targetSection: formData.type === 'course' ? formData.targetSection : undefined,
  targetCourseName: formData.type === 'course' ? (courses.find(c => c.id === formData.targetCourse)?.name) : undefined,
  targetSectionName: formData.type === 'course' ? (sections.find(s => s.id === formData.targetSection)?.name) : undefined,
      targetStudent: formData.type === 'student' ? formData.targetStudent : undefined,
    };

    try {
      const updatedCommunications = communications.map(comm => 
        comm.id === editingCommunication.id ? updatedCommunication : comm
      );
      setCommunications(updatedCommunications);
      localStorage.setItem('smart-student-communications', JSON.stringify(updatedCommunications));

      setShowEditDialog(false);
      setEditingCommunication(null);
      setFormData({
        title: '',
        content: '',
        type: 'course',
        targetCourse: '',
        targetSection: '',
        targetStudent: '',
  selectedCourseForStudent: '',
  selectedStudents: []
      });
      setErrors({});

      toast({
        title: translate('communicationUpdated') || 'Comunicación actualizada',
        description: translate('communicationUpdatedSuccess') || 'La comunicación ha sido actualizada con éxito',
      });
    } catch (error) {
      console.error('Error updating communication:', error);
      toast({
        title: translate('error') || 'Error',
        description: translate('errorUpdatingCommunication') || 'Error al actualizar la comunicación',
        variant: 'destructive'
      });
    }
  };

  const handleDelete = (communicationId: string) => {
    try {
      const updatedCommunications = communications.filter(comm => comm.id !== communicationId);
  setCommunications(updatedCommunications);
  localStorage.setItem('smart-student-communications', JSON.stringify(updatedCommunications));
  try { window.dispatchEvent(new CustomEvent('studentCommunicationsUpdated', { detail: { action: 'deleted', id: communicationId } })); } catch {}

      toast({
        title: translate('communicationDeleted') || 'Comunicación eliminada',
        description: translate('communicationDeletedSuccess') || 'La comunicación ha sido eliminada con éxito',
      });
    } catch (error) {
      console.error('Error deleting communication:', error);
      toast({
        title: translate('error') || 'Error',
        description: translate('errorDeletingCommunication') || 'Error al eliminar la comunicación',
        variant: 'destructive'
      });
    }
  };

  const getTargetInfo = (communication: Communication) => {
    if (communication.type === 'course') {
      // 1) Intento directo por IDs
      let course = courses.find(c => c.id === communication.targetCourse);
      let section = sections.find(s => s.id === communication.targetSection);

      // 2) Formatos combinados (legado): "courseId-sectionId" o "courseId::sectionId"
      const trySplit = (val?: string) => {
        if (!val) return null;
        if (val.includes('::')) return val.split('::');
        if (val.includes('-')) return val.split('-');
        return null;
      };

      if ((!course || !section) && (communication.targetCourse || communication.targetSection)) {
        const cSplit = trySplit(communication.targetCourse);
        const sSplit = trySplit(communication.targetSection);
        const maybeCourseId = cSplit?.[0] || communication.targetCourse;
        const maybeSectionId = cSplit?.[1] || sSplit?.[1] || sSplit?.[0] || communication.targetSection;

        if (!course && maybeCourseId) {
          course = courses.find(c => c.id === maybeCourseId) || courses.find(c => c.name === maybeCourseId);
        }
        if (!section && maybeSectionId) {
          // Buscar por id directo primero
          section = sections.find(s => s.id === maybeSectionId);
          // Si no existe, intentar por nombre + courseId (caso: 'A'/'B')
          if (!section) {
            const candidateCourseId = course?.id;
            if (candidateCourseId) {
              section = sections.find(s => s.courseId === candidateCourseId && s.name === maybeSectionId) || undefined as any;
            }
          }
        }
      }

      // 3) Derivar curso desde la sección si aún falta
      if (!course && section) {
        const secCourseId = (section as Section).courseId;
        if (secCourseId) {
          course = courses.find(c => c.id === secCourseId);
        }
      }

  // 4) Fallback usando courseSections (cuando existen en estado)
      if ((!course || !section) && courseSections.length > 0) {
        // Por sectionId
        if (!section && communication.targetSection) {
          const cs = courseSections.find(cs => cs.sectionId === communication.targetSection || cs.id.endsWith(`-${communication.targetSection}`));
          if (cs) {
            section = { id: cs.sectionId, name: cs.sectionName, courseId: cs.courseId } as Section;
            if (!course) course = courses.find(c => c.id === cs.courseId) || { id: cs.courseId, name: cs.courseName } as Course;
          }
        }
        // Por courseId o nombre del curso
        if (!course && communication.targetCourse) {
          const cs = courseSections.find(cs => cs.courseId === communication.targetCourse || cs.courseName === communication.targetCourse || cs.name.includes(String(communication.targetCourse)));
          if (cs) {
            course = { id: cs.courseId, name: cs.courseName } as Course;
            if (!section && communication.targetSection) {
              const s = courseSections.find(x => x.courseId === cs.courseId && (x.sectionId === communication.targetSection || x.sectionName === communication.targetSection));
              if (s) section = { id: s.sectionId, name: s.sectionName, courseId: s.courseId } as Section;
            }
          }
        }
      }

      // 5) Último recurso: leer directamente del LocalStorage (por si el estado aún no cargó)
      if (!course || !section) {
        try {
          const lsCourses = LocalStorageManager.getCourses();
          const lsSections = LocalStorageManager.getSections();
          if (!course && communication.targetCourse) {
            course = lsCourses.find((c: any) => c.id === communication.targetCourse || c.name === communication.targetCourse);
          }
          if (!section && communication.targetSection) {
            section = lsSections.find((s: any) => s.id === communication.targetSection);
            if (!section && course?.id) {
              // Buscar por nombre A/B en la sección si solo vino el nombre
              section = lsSections.find((s: any) => s.courseId === course!.id && s.name === communication.targetSection);
            }
          }
        } catch (e) {
          // ignore
        }
      }

  const finalCourseName = course?.name || communication.targetCourseName;
  const finalSectionName = section?.name || communication.targetSectionName;
  return `${finalCourseName || 'Curso desconocido'} - ${finalSectionName || 'Sección desconocida'}`;
    } else {
      const student = students.find(s => s.id === communication.targetStudent);
      return student?.displayName || 'Estudiante desconocido';
    }
  };

  // Helper: obtener nomenclatura "Curso Sección" para un estudiante (p.ej. "1ro Básico B")
  const getStudentCourseSection = (studentId?: string): string | null => {
    if (!studentId) return null;
    const student = students.find(s => s.id === studentId);
    if (!student) return null;
    const assigned = student.assignedCourses || [];

    // Intentar encontrar coincidencia en courseSections
    let cs = courseSections.find(c => assigned.includes(c.id));

    // Intentar por partes si no hay coincidencia directa
    if (!cs) {
      for (const ac of assigned) {
        if (!ac) continue;
        if (ac.includes('-')) {
          const [maybeCourseId, maybeSectionId] = ac.split('-');
          cs = courseSections.find(c => c.courseId === maybeCourseId && c.sectionId === maybeSectionId);
        }
        if (cs) break;
      }
    }

    // Fallback: leer desde localStorage
    if (!cs) {
      try {
        const lsCourses: any[] = LocalStorageManager.getCourses() || [];
        const lsSections: any[] = LocalStorageManager.getSections() || [];
        if (assigned.length > 0) {
          const ac = assigned[0];
          if (ac && ac.includes('-')) {
            const [courseId, sectionId] = ac.split('-');
            const course = lsCourses.find(c => c.id === courseId || c.name === courseId);
            const section = lsSections.find(s => s.id === sectionId || (course && s.courseId === course.id && s.name === sectionId));
            if (course && section) return `${course.name} ${section.name}`;
          }
        }
      } catch (e) {
        // ignore
      }
    }

    if (cs) return `${cs.courseName} ${cs.sectionName}`;
    return null;
  };

  const filteredCommunications = useMemo(() => {
    return memoizedCommunications
      .filter(comm => comm.createdBy === user?.username)
      .filter(comm => 
        comm.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        comm.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
        getTargetInfo(comm).toLowerCase().includes(searchTerm.toLowerCase())
      );
  }, [memoizedCommunications, user?.username, searchTerm]);

  // Verificar que el usuario tenga acceso a comunicaciones
  if (user?.role !== 'teacher' && user?.role !== 'student' && user?.role !== 'guardian') {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {translate('teacherOnlyAccess') || 'Esta página es solo para profesores, estudiantes y apoderados.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Renderizar vista específica según el rol
  if (user?.role === 'student') {
    return (
      <div className="container mx-auto px-4 py-8 space-y-8">
        {/* Header para estudiantes */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold flex items-center text-foreground">
              <Megaphone className="w-8 h-8 mr-3 text-red-500" />
              {translate('receivedCommunications') || 'Comunicaciones Recibidas'}
            </h1>
            <p className="text-muted-foreground mt-2">
              {translate('receivedCommunicationsSubtitle') || 'Mensajes y anuncios enviados por tus profesores'}
            </p>
          </div>
        </div>

        {/* Comunicaciones recibidas */}
        <Card>
          <CardContent className="p-6">
            {receivedCommunications.length === 0 ? (
              <div className="text-center py-12">
                <Megaphone className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">
                  {translate('noReceivedCommunications') || 'No tienes comunicaciones nuevas'}
                </h3>
                <p className="text-muted-foreground">
                  {translate('noReceivedCommunicationsSubtext') || 'Aquí aparecerán los mensajes que envíen tus profesores'}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {memoizedReceivedCommunications.map((communication, index) => {
                  const isRead = communication.readBy?.includes(user.id);
                  const senderInfo = getSenderInfo(communication.senderId);
                  
                  return (
                    <div
                      key={generateUniqueKey('received', communication.id, index, 'comm')}
                      className={`border rounded-lg p-4 hover:shadow-md transition-all cursor-pointer ${
                        !isRead
                          ? 'border-blue-200 bg-blue-50/50 dark:border-blue-500/50 dark:bg-blue-500/10'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                      }`}
                      onClick={() => handleViewCommunication(communication)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="font-semibold text-lg">{communication.title}</h3>
                            {isRead ? (
                              <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-700 transition-colors hover:bg-red-200 hover:border-red-300 dark:hover:bg-red-900/40">
                                {translate('readCommunication') || 'Leído'}
                              </span>
                            ) : (
                              <span className="bg-blue-500 text-white text-xs px-2 py-1 rounded-full transition-colors hover:bg-blue-600 dark:hover:bg-blue-400">
                                {translate('unreadCommunication') || 'Sin leer'}
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground mb-3 line-clamp-2">
                            {communication.content}
                          </p>
                          <div className="flex items-center space-x-4 text-sm text-muted-foreground">
                            <div className="flex items-center">
                              <UserCheck className="w-4 h-4 mr-1" />
                              {translate('sentBy') || 'Enviado por'}:
                              <Badge
                                variant="outline"
                                className="ml-2 mr-2 text-[10px] px-2 py-0.5 rounded-full border-blue-200 text-blue-700 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-700"
                              >
                                <Shield className="w-3 h-3 inline mr-1" />
                                {translate('teacherTitle') || 'Profesor'}
                              </Badge>
                              {senderInfo.name}
                            </div>
                            <div className="flex items-center">
                              <Calendar className="w-4 h-4 mr-1" />
                              {formatDateTimeOneLine(communication.createdAt)}
                            </div>
                            {communication.type === 'course' && (
                              <div className="flex items-center">
                                <Users className="w-4 h-4 mr-1" />
                                {getCourseInfo(communication.targetCourse || '', communication.targetSection)}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="ml-4">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-foreground hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dialog para ver detalles de comunicación */}
        <Dialog open={showCommunicationDialog} onOpenChange={setShowCommunicationDialog}>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>
                {translate('communicationDetails') || 'Detalles de la Comunicación'}
              </DialogTitle>
            </DialogHeader>
            {selectedCommunication && (
              <div className="space-y-4 py-4">
                <div>
                  <h3 className="text-xl font-bold mb-2">{selectedCommunication.title}</h3>
                  <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-4 mb-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <strong>{translate('sentBy') || 'Enviado por'}:</strong><br />
                        <Badge
                          variant="outline"
                          className="mr-2 text-[10px] px-2 py-0.5 rounded-full border-blue-200 text-blue-700 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-700"
                        >
                          <Shield className="w-3 h-3 inline mr-1" />
                          {translate('teacherTitle') || 'Profesor'}
                        </Badge>
                        {getSenderInfo(selectedCommunication.senderId).name}
                      </div>
                      <div>
                        <strong>{translate('sentDate') || 'Fecha de envío'}:</strong><br />
                        {formatDateTimeOneLine(selectedCommunication.createdAt)}
                      </div>
                      <div>
                        <strong>{translate('readByYou') || 'Leído por ti'}:</strong><br />
                        {selectedCommunication.readAt?.[user.id]
                          ? formatDateTimeOneLine(selectedCommunication.readAt[user.id])
                          : '—'}
                      </div>
                      <div className="md:col-span-2">
                        <strong>{translate('targetAudience') || 'Dirigido a'}:</strong><br />
                        {selectedCommunication.type === 'course' 
                          ? getCourseInfo(selectedCommunication.targetCourse || '', selectedCommunication.targetSection)
                          : translate('specificStudent') || 'Estudiante específico'
                        }
                      </div>
                    </div>
                  </div>
                  <div className="prose max-w-none">
                    <div className="whitespace-pre-wrap text-gray-700 dark:text-gray-200">
                      {selectedCommunication.content}
                    </div>
                  </div>
                  {/* Descarga de PPTX si hay presentación adjunta */}
                  {selectedCommunication.attachment?.type === 'slide' && (
                    <div className="mt-6 p-4 rounded-lg border border-border bg-muted/30">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium">{translate('attachments') || 'Archivos adjuntos'}</p>
                          <p className="text-sm text-muted-foreground mt-1">
                            PPTX • {(selectedCommunication.attachment.slide?.title || selectedCommunication.attachment.slideId)}
                          </p>
                        </div>
                        <Button
                          variant="default"
                          onClick={async () => {
                            try {
                              const data = selectedCommunication.attachment?.slide;
                              if (!data) return;
                              const mod: any = await import('pptxgenjs');
                              const PptxGen = mod.default || mod;
                              const pptx = new PptxGen();
                              pptx.company = 'Smart Student';
                              pptx.author = (user?.displayName || user?.username || 'Teacher') as any;

                              // Helpers para incrustar imágenes como dataURL (evita pérdida de fondos)
                              const toDirectUrl = (u?: string | null) => {
                                if (!u) return '';
                                if (u.startsWith('data:')) return u;
                                try {
                                  const m = u.match(/\/api\/image-proxy\?u=(.*)$/);
                                  if (m) return decodeURIComponent(m[1]);
                                } catch {}
                                return u;
                              };
                              const toDataUrl = async (url?: string | null): Promise<string | null> => {
                                if (!url) return null;
                                try {
                                  if (url.startsWith('data:')) return url;
                                  // 1) Intentar directo
                                  const direct = toDirectUrl(url);
                                  let res = await fetch(direct, { cache: 'no-store' } as RequestInit);
                                  // 2) Si falla, intentar vía proxy interno
                                  if (!res || !res.ok) {
                                    const proxied = url.startsWith('/api/image-proxy') || url.startsWith('data:') ? url : `/api/image-proxy?u=${encodeURIComponent(direct)}`;
                                    res = await fetch(proxied, { cache: 'no-store' } as RequestInit);
                                    if (!res || !res.ok) return null;
                                  }
                                  const blob = await res.blob();
                                  return await new Promise((resolve) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => resolve(String(reader.result || ''));
                                    reader.readAsDataURL(blob);
                                  });
                                } catch {
                                  return null;
                                }
                              };

                              // Catálogo curado: priorizar fondos por tema/asignatura y garantizar variedad
                              const normalizeAscii = (s?: string) => {
                                try {
                                  return String(s || '')
                                    .normalize('NFD')
                                    .replace(/\p{Diacritic}+/gu, '')
                                    .replace(/[^\w\s-]+/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .toLowerCase();
                                } catch { return String(s || '').toLowerCase(); }
                              };
                              // Pools por tema (10+ imágenes por tema para evitar repeticiones)
                              const CURATED_POOLS: Record<string, string[]> = {
                                astronomy: [
                                  'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1444080748397-f442aa95c3e5?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1447433819943-74a20887a81e?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1457369804613-52c61a468e7d?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1442544213729-6a15f1611937?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1450849608880-6f787542c88a?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1473929737554-5b7f1825f1bb?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1496307042754-b4aa456c4a2d?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1472437774355-71ab6752b434?q=80&w=1200&auto=format&fit=crop'
                                ],
                                respiratory: [
                                  'https://images.unsplash.com/photo-1588613259305-59989a937b23?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1530023367847-a683933f417e?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1588776814546-1ffcf47267ff?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1532938911079-1b06ac7ceec7?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?q=80&w=1200&auto=format&fit=crop'
                                ],
                                circulatory: [
                                  'https://images.unsplash.com/photo-1530023367847-a683933f417e?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1530026405186-ed1f139313f8?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1582711647076-f9a27b0d0407?q=80&w=1200&auto=format&fit=crop'
                                ],
                                math: [
                                  'https://images.unsplash.com/photo-1516321497487-e288fb19713f?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1523246191915-6ad8e0f8ff5f?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1532012197267-da84d127e765?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=1200&auto=format&fit=crop'
                                ],
                                history: [
                                  'https://images.unsplash.com/photo-1548585742-1df49e7532a6?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1519681393784-d120267933ba?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1473181488821-2d23949a045a?q=80&w=1200&auto=format&fit=crop'
                                ],
                                language: [
                                  'https://images.unsplash.com/photo-1519681393784-d120267933ba?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1455390582262-044cdead277a?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1516979187457-637abb4f9353?q=80&w=1200&auto=format&fit=crop'
                                ],
                                technology: [
                                  'https://images.unsplash.com/photo-1518779578993-ec3579fee39f?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1504386106331-3e4e71712b38?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1498050108023-c5249f4df085?q=80&w=1200&auto=format&fit=crop'
                                ],
                                geography: [
                                  'https://images.unsplash.com/photo-1502920917128-1aa500764cbd?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1469474968028-56623f02e42e?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1469474968028-56623f02e42e?q=80&w=1200&auto=format&fit=crop'
                                ],
                                general: [
                                  'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1513258496099-48168024aec0?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1509062522246-3755977927d7?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1509062522246-3755977927d7?q=80&w=1200&auto=format&fit=crop',
                                  'https://images.unsplash.com/photo-1522071820081-009f0129c71c?q=80&w=1200&auto=format&fit=crop'
                                ]
                              };

                              const resolveTopicKey = (topic?: string, subjectName?: string, slideTitle?: string): string => {
                                const txt = normalizeAscii(`${topic} ${subjectName} ${slideTitle}`);
                                if (/(astronom|sistema\s*solar|planeta|galax|espacio|universe|space|nasa)/.test(txt)) return 'astronomy';
                                if (/(respir|pulmon|oxigen|alveol|bronq|diafragm|traquea)/.test(txt)) return 'respiratory';
                                if (/(circulator|corazon|cardio|sangre|arterias|venas)/.test(txt)) return 'circulatory';
                                if (/(mate|algebra|geometr|aritm|calculo|funcion|probabil|estat)/.test(txt)) return 'math';
                                if (/(historia|sociales|civiliz|revoluc|independenc|edad\s*media|antigua)/.test(txt)) return 'history';
                                if (/(lengua|literat|comunicaci|lectura|escritura|idioma|gramatica)/.test(txt)) return 'language';
                                if (/(tecnolog|comput|program|informat|robot|ia|inteligencia)/.test(txt)) return 'technology';
                                if (/(geograf|mapa|planeta|tierra|geolog|clima)/.test(txt)) return 'geography';
                                return 'general';
                              };

                              const resolveCuratedUrls = (topic?: string, subjectName?: string, slideTitle?: string): string[] => {
                                const key = resolveTopicKey(topic, subjectName, slideTitle);
                                return CURATED_POOLS[key] || CURATED_POOLS.general;
                              };

                              // Temas/estilos iguales a los del módulo de Presentaciones
                              const designThemes: Record<string, { titleHex: string; contentHex: string; bgHex: string; primary: string }>= {
                                professional: { titleHex: '#1E40AF', contentHex: '#374151', bgHex: '#F8FAFC', primary: '#2563eb' },
                                modern:       { titleHex: '#6D28D9', contentHex: '#374151', bgHex: '#F5F3FF', primary: '#8b5cf6' },
                                warm:         { titleHex: '#92400E', contentHex: '#374151', bgHex: '#FEF3C7', primary: '#f59e0b' },
                                nature:       { titleHex: '#065F46', contentHex: '#374151', bgHex: '#ECFDF5', primary: '#10b981' },
                                elegant:      { titleHex: '#111827', contentHex: '#374151', bgHex: '#F9FAFB', primary: '#111827' },
                              };
                              const themeKey = (data as any).designTheme || 'professional';
                              const theme = designThemes[themeKey] || designThemes.professional;
                              const styleKind = String((data as any).designStyle || 'accents');
                              const useDesignOnly = ((data as any).useDesignOnly !== false);

                              const title = data.title || data.topic || 'Presentación';
                              const usedCanonUrls = new Set<string>();
                              const s0 = pptx.addSlide();
                              if (useDesignOnly) {
                                s0.background = { fill: theme.bgHex } as any;
                              } else {
                                const coverUrl = (data as any).coverImageUrl as (string | undefined);
                                // Candidatos para portada: imagen del profesor -> curadas por tema
                                const coverCandidates: string[] = [];
                                if (coverUrl) coverCandidates.push(toDirectUrl(coverUrl));
                                coverCandidates.push(...resolveCuratedUrls((data as any).topic || (data as any).title, (data as any).subjectName, (data as any).title));

                                let bg: string | null = null;
                                for (const cand of coverCandidates) {
                                  const canon = toDirectUrl(cand);
                                  if (canon && !usedCanonUrls.has(canon)) {
                                    const d = await toDataUrl(canon);
                                    if (d) { bg = d; usedCanonUrls.add(canon); break; }
                                  }
                                }
                                if (bg) s0.background = { data: bg } as any; else s0.background = { fill: theme.bgHex } as any;
                                // Overlay semitransparente para legibilidad
                                s0.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 5.625, fill: { color: 'FFFFFF', transparency: 30 }, line: { color: 'FFFFFF' } } as any);
                              }
                              if (styleKind === 'grid') {
                                s0.addShape(pptx.shapes.LINE, { x: 0.5, y: 0.5, w: 9.0, h: 0, line: { color: theme.primary, width: 0.25 } } as any);
                                for (let i = 1; i <= 5; i++) s0.addShape(pptx.shapes.LINE, { x: 0.5, y: 0.5 + i * 0.8, w: 9.0, h: 0, line: { color: theme.primary, width: 0.1, transparency: 80 } } as any);
                                for (let i = 1; i <= 4; i++) s0.addShape(pptx.shapes.LINE, { x: 0.5 + i * 2.0, y: 0.5, w: 0, h: 5.0, line: { color: theme.primary, width: 0.1, transparency: 80 } } as any);
                              } else if (styleKind === 'bubbles') {
                                s0.addShape(pptx.shapes.OVAL, { x: 7.6, y: 0.8, w: 1.8, h: 1.8, fill: { color: theme.primary, transparency: 75 } } as any);
                                s0.addShape(pptx.shapes.OVAL, { x: 7.0, y: 1.9, w: 1.0, h: 1.0, fill: { color: theme.primary, transparency: 70 } } as any);
                                s0.addShape(pptx.shapes.OVAL, { x: -0.2, y: 5.0, w: 2.6, h: 1.1, fill: { color: '0F172A', transparency: 85 } } as any);
                              } else {
                                s0.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 0.7, w: 4.0, h: 0.25, fill: { color: theme.primary, transparency: 80 } } as any);
                                s0.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 7.4, y: 1.0, w: 2.2, h: 1.6, fill: { color: theme.primary, transparency: 75 } } as any);
                                s0.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: -0.3, y: 5.2, w: 3.0, h: 1.0, fill: { color: '0F172A', transparency: 85 } } as any);
                              }

                              // Textos de portada alineados como en el del profesor
                              const courseLabel = (selectedCommunication.targetCourseName) || getCourseInfo(selectedCommunication.targetCourse || '', selectedCommunication.targetSection);
                              const subjectVal = data.subjectName || '';
                              const teacherPrefix = (translate('teacherTitle') || 'Profesor');
                              const teacherName = (selectedCommunication as any).senderName || getSenderInfo(selectedCommunication.senderId).name || '—';
                              const x = 0.6; const w = 8.6;
                              s0.addText(title, { x, y: 3.0, w, h: 1, fontSize: 36, bold: true, color: theme.titleHex, align: 'left', shadow: { type: 'outer', color: '000000', blur: 3, offset: 2, angle: 45, opacity: 0.6 } as any } as any);
                              if (courseLabel) s0.addText(String(courseLabel), { x, y: 3.7, w, h: 0.6, fontSize: 28, bold: true, color: theme.titleHex, align: 'left', shadow: { type: 'outer', color: '000000', blur: 3, offset: 2, angle: 45, opacity: 0.6 } as any } as any);
                              if (subjectVal) s0.addText(String(subjectVal), { x, y: 4.2, w, h: 0.6, fontSize: 28, bold: true, color: theme.titleHex, align: 'left', shadow: { type: 'outer', color: '000000', blur: 3, offset: 2, angle: 45, opacity: 0.6 } as any } as any);
                              s0.addText(`${teacherPrefix}: ${teacherName}`, { x, y: 4.8, w, h: 0.6, fontSize: 22, color: theme.contentHex, align: 'left' } as any);

                              const slides = Array.isArray(data.slides) && data.slides.length > 0
                                ? data.slides
                                : Array.from({ length: Math.max(1, Number(data.slideCount || 5)) }, (_, i) => ({ title: `${title} - ${i + 1}`, content: [] as string[] }));

                              for (let idx = 0; idx < slides.length; idx++) {
                                const sl = slides[idx];
                                const s = pptx.addSlide();
                                if (useDesignOnly) {
                                  s.background = { fill: theme.bgHex } as any;
                                } else {
                                  try {
                                    // 1) Candidatos: imagen explícita -> curadas por título/contenido -> curadas por tema general
                                    const slideImg = (("imageUrl" in (sl as any)) ? (sl as any).imageUrl as (string | undefined) : undefined) || (sl as any).thumbUrl;
                                    const cands: string[] = [];
                                    if (slideImg) cands.push(toDirectUrl(slideImg));
                                    cands.push(...resolveCuratedUrls((data as any).topic || (data as any).title, (data as any).subjectName, (sl as any)?.title));
                                    cands.push(...resolveCuratedUrls((data as any).topic || (data as any).title, (data as any).subjectName, ((sl as any)?.content || []).join(' ')));

                                    // Elegir el primer candidato no usado; si todos usados, intentar cualquiera del pool general no usado
                                    let chosenCanon: string | null = null;
                                    for (const cand of cands) {
                                      const canon = toDirectUrl(cand);
                                      if (canon && !usedCanonUrls.has(canon)) { chosenCanon = canon; break; }
                                    }
                                    if (!chosenCanon) {
                                      for (const alt of CURATED_POOLS.general) {
                                        const canon = toDirectUrl(alt);
                                        if (canon && !usedCanonUrls.has(canon)) { chosenCanon = canon; break; }
                                      }
                                    }
                                    let dataUrl: string | null = null;
                                    if (chosenCanon) {
                                      dataUrl = await toDataUrl(chosenCanon);
                                      if (dataUrl) usedCanonUrls.add(chosenCanon);
                                    }
                                    if (dataUrl) s.background = { data: dataUrl } as any; else s.background = { fill: theme.bgHex } as any;
                                  } catch { s.background = { fill: theme.bgHex } as any; }
                                  // Overlay semitransparente como en el profesor para legibilidad
                                  s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 5.625, fill: { color: 'FFFFFF', transparency: 30 }, line: { color: 'FFFFFF' } } as any);
                                }
                              // Reservar portada para evitar duplicarla en slide 1
                if (idx === 0) {
                                try {
                                  const canonCover = toDirectUrl((data as any).coverImageUrl || '') || '';
                                  if (canonCover) usedCanonUrls.add(canonCover);
                                } catch {}
                              }
                                if (styleKind === 'grid') {
                                  for (let i = 0; i <= 5; i++) s.addShape(pptx.shapes.LINE, { x: 0.5, y: 0.5 + i * 0.8, w: 9.0, h: 0, line: { color: theme.primary, width: 0.1, transparency: 80 } } as any);
                                  for (let i = 1; i <= 4; i++) s.addShape(pptx.shapes.LINE, { x: 0.5 + i * 2.0, y: 0.5, w: 0, h: 5.0, line: { color: theme.primary, width: 0.1, transparency: 80 } } as any);
                                } else if (styleKind === 'bubbles') {
                                  s.addShape(pptx.shapes.OVAL, { x: 7.8, y: 0.9, w: 1.6, h: 1.6, fill: { color: theme.primary, transparency: 75 } } as any);
                                  s.addShape(pptx.shapes.OVAL, { x: 7.2, y: 2.1, w: 0.9, h: 0.9, fill: { color: theme.primary, transparency: 70 } } as any);
                                  s.addShape(pptx.shapes.OVAL, { x: -0.2, y: 5.2, w: 2.3, h: 0.9, fill: { color: '0F172A', transparency: 85 } } as any);
                                } else {
                                  s.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 0.4, w: 3.6, h: 0.2, fill: { color: theme.primary, transparency: 80 } } as any);
                                  s.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 7.8, y: 0.9, w: 1.8, h: 1.2, fill: { color: theme.primary, transparency: 75 } } as any);
                                  s.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: -0.3, y: 5.2, w: 2.5, h: 0.8, fill: { color: '0F172A', transparency: 85 } } as any);
                                }
                                // Título y puntos con mismas posiciones que profesor para evitar solapes
                                s.addText(sl.title || `${title} - ${idx + 1}`, { 
                                  x: 0.6, y: 0.6, w: 8.0, h: 1,
                                  fontSize: 32, bold: true, color: theme.titleHex,
                                  shadow: { type: 'outer', color: '000000', blur: 3, offset: 2, angle: 45, opacity: 0.6 } as any,
                                } as any);
                                (sl.content || []).forEach((pt: string, i: number) => {
                                  s.addText(pt, { 
                                    x: 0.6, y: 1.9 + (i * 0.7), w: 8.0, h: 0.6,
                                    fontSize: 18, color: theme.contentHex,
                                    bullet: true as any, indentLevel: 1 as any, paraSpaceBefore: 6 as any,
                                    shadow: { type: 'outer', color: '000000', blur: 2, offset: 1, angle: 45, opacity: 0.45 } as any,
                                  } as any);
                                });
                              }

                              const fileName = `${(title || 'presentacion').replace(/[^a-z0-9\-_]+/gi,'_')}.pptx`;
                              await pptx.writeFile({ fileName });
                            } catch (err) {
                              console.error('[Comunicaciones] PPTX download error:', err);
                            }
                          }}
                        >
                          {translate('slidesFeatureDownloadPptx') || 'Descarga PPTX'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-end space-x-2">
                  <Button
                    variant="outline"
                    className="hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                    onClick={() => setShowCommunicationDialog(false)}
                  >
                    {translate('close') || 'Cerrar'}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Vista para apoderados (guardians) - solo lectura de comunicaciones de sus estudiantes
  if (user?.role === 'guardian') {
    return (
      <div className="container mx-auto px-4 py-8 space-y-8">
        {/* Header para apoderados */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold flex items-center text-foreground">
              <Megaphone className="w-8 h-8 mr-3 text-red-500" />
              {translate('receivedCommunications') || 'Comunicaciones Recibidas'}
            </h1>
            <p className="text-muted-foreground mt-2">
              {translate('guardianCommunicationsSubtitle') || 'Mensajes y anuncios enviados a sus estudiantes'}
            </p>
          </div>
        </div>

        {/* Comunicaciones recibidas para apoderados */}
        <Card>
          <CardContent className="p-6">
            {receivedCommunications.length === 0 ? (
              <div className="text-center py-12">
                <Megaphone className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">
                  {translate('noReceivedCommunications') || 'No hay comunicaciones nuevas'}
                </h3>
                <p className="text-muted-foreground">
                  {translate('guardianNoCommSubtext') || 'Aquí aparecerán los mensajes enviados a sus estudiantes'}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {memoizedReceivedCommunications.map((communication: any, index) => {
                  // 🔧 CORRECCIÓN: Para apoderados, verificar con identificador compuesto por estudiante
                  const studentInfo = communication.studentInfo;
                  const readByKey = studentInfo?.id 
                    ? `${user.id}_forStudent_${studentInfo.id}` 
                    : user.id;
                  const isRead = communication.readBy?.includes(readByKey) || communication.readBy?.includes(user.id);
                  const senderInfo = getSenderInfo(communication.senderId);
                  
                  return (
                    <div
                      key={generateUniqueKey('guardian-received', communication.id, index, 'comm')}
                      className={`border rounded-lg p-4 hover:shadow-md transition-all cursor-pointer ${
                        !isRead
                          ? 'border-blue-200 bg-blue-50/50 dark:border-blue-500/50 dark:bg-blue-500/10'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                      }`}
                      onClick={() => handleViewCommunication(communication)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <h3 className="font-semibold text-lg">{communication.title}</h3>
                            {/* Badge del estudiante para apoderados con múltiples estudiantes */}
                            {studentInfo && (
                              <Badge 
                                variant="outline" 
                                className="text-xs px-2 py-0.5 bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700"
                              >
                                👤 {studentInfo.name}
                                {studentInfo.courseName && studentInfo.sectionName && (
                                  <span className="ml-1 text-purple-500">
                                    ({studentInfo.courseName} {studentInfo.sectionName})
                                  </span>
                                )}
                              </Badge>
                            )}
                            {isRead ? (
                              <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-700">
                                {translate('readCommunication') || 'Leído'}
                              </span>
                            ) : (
                              <span className="bg-blue-500 text-white text-xs px-2 py-1 rounded-full">
                                {translate('unreadCommunication') || 'Sin leer'}
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground mb-3 line-clamp-2">
                            {communication.content}
                          </p>
                          <div className="flex items-center space-x-4 text-sm text-muted-foreground flex-wrap gap-2">
                            <div className="flex items-center">
                              <UserCheck className="w-4 h-4 mr-1" />
                              {translate('sentBy') || 'Enviado por'}:
                              <Badge
                                variant="outline"
                                className="ml-2 mr-2 text-[10px] px-2 py-0.5 rounded-full border-blue-200 text-blue-700 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-700"
                              >
                                <Shield className="w-3 h-3 inline mr-1" />
                                {translate('teacherTitle') || 'Profesor'}
                              </Badge>
                              {senderInfo.name}
                            </div>
                            <div className="flex items-center">
                              <Calendar className="w-4 h-4 mr-1" />
                              {formatDateTimeOneLine(communication.createdAt)}
                            </div>
                            {communication.type === 'course' && !studentInfo && (
                              <div className="flex items-center">
                                <Users className="w-4 h-4 mr-1" />
                                {getCourseInfo(communication.targetCourse || '', communication.targetSection)}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="ml-4">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-foreground hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dialog para ver detalles de comunicación (apoderado) */}
        <Dialog open={showCommunicationDialog} onOpenChange={setShowCommunicationDialog}>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>
                {translate('communicationDetails') || 'Detalles de la Comunicación'}
              </DialogTitle>
            </DialogHeader>
            {selectedCommunication && (
              <div className="space-y-4 py-4">
                <div>
                  <h3 className="text-xl font-bold mb-2">{selectedCommunication.title}</h3>
                  {/* Información del estudiante para apoderados */}
                  {(selectedCommunication as any).studentInfo && (
                    <div className="mb-4 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-700">
                      <div className="flex items-center gap-2">
                        <span className="text-purple-600 dark:text-purple-300 font-medium">
                          👤 {translate('studentRecipient') || 'Estudiante destinatario'}:
                        </span>
                        <span className="font-semibold">{(selectedCommunication as any).studentInfo.name}</span>
                        {(selectedCommunication as any).studentInfo.courseName && (
                          <Badge variant="outline" className="text-xs">
                            {(selectedCommunication as any).studentInfo.courseName} {(selectedCommunication as any).studentInfo.sectionName}
                          </Badge>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-4 mb-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <strong>{translate('sentBy') || 'Enviado por'}:</strong><br />
                        <Badge
                          variant="outline"
                          className="mr-2 text-[10px] px-2 py-0.5 rounded-full border-blue-200 text-blue-700 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-700"
                        >
                          <Shield className="w-3 h-3 inline mr-1" />
                          {translate('teacherTitle') || 'Profesor'}
                        </Badge>
                        {getSenderInfo(selectedCommunication.senderId).name}
                      </div>
                      <div>
                        <strong>{translate('sentDate') || 'Fecha de envío'}:</strong><br />
                        {formatDateTimeOneLine(selectedCommunication.createdAt)}
                      </div>
                      <div>
                        <strong>{translate('readByYou') || 'Leído por ti'}:</strong><br />
                        {selectedCommunication.readAt?.[user.id]
                          ? formatDateTimeOneLine(selectedCommunication.readAt[user.id])
                          : '—'}
                      </div>
                      <div className="md:col-span-2">
                        <strong>{translate('targetAudience') || 'Dirigido a'}:</strong><br />
                        {selectedCommunication.type === 'course' 
                          ? getCourseInfo(selectedCommunication.targetCourse || '', selectedCommunication.targetSection)
                          : translate('specificStudent') || 'Estudiante específico'
                        }
                      </div>
                    </div>
                  </div>
                  <div className="prose max-w-none">
                    <div className="whitespace-pre-wrap text-gray-700 dark:text-gray-200">
                      {selectedCommunication.content}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end space-x-2">
                  <Button
                    variant="outline"
                    className="hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                    onClick={() => setShowCommunicationDialog(false)}
                  >
                    {translate('close') || 'Cerrar'}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center text-foreground">
            <Megaphone className="w-8 h-8 mr-3 text-red-500" />
            {translate('cardCommunicationsTitle') || 'Comunicaciones'}
          </h1>
          <p className="text-muted-foreground mt-2">
            {translate('communicationsDescription') || 'Envía mensajes a cursos completos o estudiantes específicos'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Formulario de creación */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Send className="w-5 h-5 mr-2" />
                {translate('createNewCommunication') || 'Crear Nueva Comunicación'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Título */}
                <div>
                  <Label htmlFor="title">
                    {translate('communicationTitle') || 'Título'} <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                    placeholder={translate('communicationTitlePlaceholder') || 'Ingresa el título del mensaje'}
                    className={errors.title ? 'border-red-500' : ''}
                  />
                  {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
                </div>

                {/* Tipo de destinatario */}
                <div>
                  <Label htmlFor="type">
                    {translate('recipientType') || 'Tipo de Destinatario'} <span className="text-red-500">*</span>
                  </Label>
                  <Select
                    key={`type-selector-${forceRenderKey}`}
                    value={formData.type}
                    onValueChange={(value: 'course' | 'student') => {
                      setFormData(prev => ({ 
                        ...prev, 
                        type: value,
                        targetCourse: '',
                        targetSection: '',
                        targetStudent: '',
                        selectedCourseForStudent: ''
                      }));
                      // Forzar re-render completo al cambiar tipo
                      setForceRenderKey(prev => prev + 1);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="course">
                        {translate('commCourse') || 'Curso'}
                      </SelectItem>
                      <SelectItem value="student">
                        {translate('specificStudent') || 'Estudiante Específico'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Selección de curso para estudiante específico */}
                {formData.type === 'student' && (
                  <div key={`student-course-container-${forceRenderKey}`}>
                    <Label htmlFor="courseForStudent">
                      {translate('commCourse') || 'Curso'} <span className="text-red-500">*</span>
                    </Label>
          <Select
                      key={`student-course-selector-${forceRenderKey}`}
                      value={formData.selectedCourseForStudent}
                      onValueChange={(value) => setFormData(prev => ({ 
                        ...prev, 
            selectedCourseForStudent: value,
            targetStudent: '', // Limpiar estudiante seleccionado al cambiar curso
            selectedStudents: [] // Limpiar múltiples seleccionados al cambiar curso
                      }))}
                    >
                      <SelectTrigger className={errors.selectedCourseForStudent ? 'border-red-500' : ''}>
                        <SelectValue placeholder={translate('commSelectCourse') || 'Selecciona un curso'} />
                      </SelectTrigger>
                      <SelectContent>
                        {memoizedCourseSections.length === 0 ? (
                          <div className="p-2 text-sm text-muted-foreground text-center">
                            No tienes cursos asignados
                          </div>
                        ) : (
                          memoizedCourseSections.map((courseSection, index) => {
                            const uniqueKey = `student-course-${courseSection.id}-${index}-${forceRenderKey}`;
                            return (
                              <SelectItem key={uniqueKey} value={courseSection.id}>
                                {courseSection.name}
                              </SelectItem>
                            );
                          })
                        )}
                      </SelectContent>
                    </Select>
                    {errors.selectedCourseForStudent && <p className="text-red-500 text-sm mt-1">{errors.selectedCourseForStudent}</p>}
                  </div>
                )}

                {/* Selección de curso */}
                {formData.type === 'course' && (
                  <div key={`course-container-${forceRenderKey}`}>
                    <Label htmlFor="course">
                      {translate('commCourse') || 'Curso-Sección'} <span className="text-red-500">*</span>
                    </Label>
                    <Select
                      key={`course-selector-${forceRenderKey}`}
                      value={formData.targetCourse && formData.targetSection ? `${formData.targetCourse}::${formData.targetSection}` : ''}
                      onValueChange={(value) => {
                        const [courseId, sectionId] = value.split('::');
                        setFormData(prev => ({ ...prev, targetCourse: courseId, targetSection: sectionId }));
                      }}
                    >
                      <SelectTrigger className={errors.targetCourse ? 'border-red-500' : ''}>
                        <SelectValue placeholder={translate('commSelectCourse') || 'Selecciona un curso-sección'} />
                      </SelectTrigger>
                      <SelectContent>
                        {memoizedCourseSections.length === 0 ? (
                          <div className="p-2 text-sm text-muted-foreground text-center">
                            {user?.role === 'teacher' 
                              ? 'No tienes asignaciones. Ve a Admin > Gestión de Usuarios'
                              : 'No hay cursos-sección disponibles'
                            }
                          </div>
                        ) : (
                          memoizedCourseSections.map((courseSection, index) => {
                            const uniqueKey = `course-section-${courseSection.id}-${index}-${forceRenderKey}`;
                            return (
                              <SelectItem key={uniqueKey} value={`${courseSection.courseId}::${courseSection.sectionId}`}>
                                {courseSection.name}
                              </SelectItem>
                            );
                          })
                        )}
                      </SelectContent>
                    </Select>
                    {errors.targetCourse && <p className="text-red-500 text-sm mt-1">{errors.targetCourse}</p>}
                  </div>
                )}

                {/* Selección de estudiante */}
                {formData.type === 'student' && (
                  <div key={`student-container-${forceRenderKey}`}>
                    <Label htmlFor="student">
                      {translate('commStudent') || 'Estudiante'} <span className="text-red-500">*</span>
                    </Label>
                    <Select
                      key={`student-selector-${forceRenderKey}`}
                      value={formData.targetStudent}
                      onValueChange={(value) => {
                        setFormData(prev => {
                          const already = prev.selectedStudents.includes(value);
                          return {
                            ...prev,
                            targetStudent: value,
                            selectedStudents: already ? prev.selectedStudents : [...prev.selectedStudents, value]
                          };
                        });
                      }}
                    >
                      <SelectTrigger 
                        disabled={!formData.selectedCourseForStudent}
                        className={`${errors.targetStudent ? 'border-red-500' : ''} ${!formData.selectedCourseForStudent ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <SelectValue 
                          placeholder={
                            !formData.selectedCourseForStudent
                              ? (translate('selectCourseFirst') || 'Selecciona un curso primero')
                              : (translate('commSelectStudent') || 'Selecciona un estudiante')
                          } 
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {memoizedAvailableStudents.map((student, index) => {
                          const uniqueKey = `student-${student.id}-${index}-${forceRenderKey}`;
                          return (
                            <SelectItem key={uniqueKey} value={student.id}>
                              {student.displayName} ({student.email})
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    {/* Chips de seleccionados */}
                    {formData.selectedStudents.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {formData.selectedStudents.map((id) => {
                          const s = students.find(st => st.id === id) || availableStudents.find(st => st.id === id);
                          const name = s?.displayName || id;
                          return (
                            <div key={`chip-${id}`} className="flex items-center gap-2 bg-muted px-2 py-1 rounded-full text-sm">
                              <span>{name}</span>
                              <button
                                type="button"
                                aria-label="Remove student"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => removeSelectedStudent(id)}
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {errors.targetStudent && <p className="text-red-500 text-sm mt-1">{errors.targetStudent}</p>}
                  </div>
                )}

                {/* Contenido */}
                <div>
                  <Label htmlFor="content">
                    {translate('messageContent') || 'Contenido del Mensaje'} <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    id="content"
                    value={formData.content}
                    onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                    placeholder={translate('messageContentPlaceholder') || 'Escribe el contenido de tu mensaje aquí...'}
                    className={`min-h-[120px] ${errors.content ? 'border-red-500' : ''}`}
                  />
                  {errors.content && <p className="text-red-500 text-sm mt-1">{errors.content}</p>}
                </div>

                <Button type="submit" className="w-full bg-red-500 hover:bg-red-600 text-white">
                  <Send className="w-4 h-4 mr-2" />
                  {translate('sendCommunication') || 'Enviar Comunicación'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Panel lateral con estadísticas */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {translate('communicationsStats') || 'Estadísticas'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {translate('totalCommunications') || 'Total enviadas'}
                </span>
                <Badge variant="secondary">
                  {filteredCommunications.length}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {translate('courseCommunications') || 'A cursos'}
                </span>
                <Badge variant="outline">
                  {filteredCommunications.filter(c => c.type === 'course').length}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {translate('studentCommunications') || 'A estudiantes'}
                </span>
                <Badge variant="outline">
                  {filteredCommunications.filter(c => c.type === 'student').length}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {translate('quickAccess') || 'Acceso Rápido'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full justify-start hover:bg-red-50 hover:border-red-300 hover:text-red-600"
                onClick={() => setFormData(prev => ({ ...prev, type: 'course' }))}
              >
                <Users className="w-4 h-4 mr-2" />
                {translate('messageToCourse') || 'Mensaje a Curso'}
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full justify-start hover:bg-red-50 hover:border-red-300 hover:text-red-600"
                onClick={() => setFormData(prev => ({ ...prev, type: 'student' }))}
              >
                <UserCheck className="w-4 h-4 mr-2" />
                {translate('messageToStudent') || 'Mensaje a Estudiante'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Historial de comunicaciones */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <Calendar className="w-5 h-5 mr-2" />
              {translate('communicationsHistory') || 'Historial de Comunicaciones'}
            </CardTitle>
            <div className="flex items-center space-x-2">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={translate('searchCommunications') || 'Buscar comunicaciones...'}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-64"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredCommunications.length === 0 ? (
            <div className="text-center py-8">
              <Megaphone className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                {searchTerm 
                  ? (translate('noSearchResults') || 'No se encontraron comunicaciones que coincidan con tu búsqueda')
                  : (translate('noCommunications') || 'No has enviado comunicaciones aún')
                }
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredCommunications
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map((communication, index) => {
                  // Para comunicaciones a estudiante, mostrar curso/sección
                  let studentCourseSection: string | null = null;
                  if (communication.type === 'student') {
                    // Primero intentar desde los datos guardados en la comunicación
                    if (communication.targetCourseName && communication.targetSectionName) {
                      studentCourseSection = `${communication.targetCourseName} ${communication.targetSectionName}`;
                    } else {
                      // Fallback: calcular desde estudiante
                      studentCourseSection = getStudentCourseSection(communication.targetStudent);
                    }
                  }
                  return (
                  <div
                    key={generateUniqueKey('sent', communication.id, index, 'history')}
                    className="border rounded-lg p-4 hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold text-lg mb-1">{communication.title}</h3>
                        <p className="text-muted-foreground mb-3 line-clamp-3">
                          {communication.content}
                        </p>
                        <div className="flex flex-col space-y-1 text-sm text-muted-foreground">
                          <div className="flex items-center">
                            {communication.type === 'course' ? (
                              <Users className="w-4 h-4 mr-1" />
                            ) : (
                              <UserCheck className="w-4 h-4 mr-1" />
                            )}
                            {getTargetInfo(communication)}
                          </div>
                          {studentCourseSection && (
                            <div className="flex items-center">
                              <Users className="w-4 h-4 mr-1" />
                              {studentCourseSection}
                            </div>
                          )}
                          <div className="flex items-center">
                            <Calendar className="w-4 h-4 mr-1" />
                            {formatDateTimeOneLine(communication.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2 ml-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="hover:bg-red-50 hover:text-red-600"
                          onClick={() => handleEdit(communication)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(communication.id)}
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );})
              }
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog de edición */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {translate('editCommunication') || 'Editar Comunicación'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Mismo formulario que el de creación */}
            <div>
              <Label htmlFor="edit-title">
                {translate('communicationTitle') || 'Título'} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-title"
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder={translate('communicationTitlePlaceholder') || 'Ingresa el título del mensaje'}
                className={errors.title ? 'border-red-500' : ''}
              />
              {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
            </div>

            <div>
              <Label htmlFor="edit-content">
                {translate('messageContent') || 'Contenido del Mensaje'} <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="edit-content"
                value={formData.content}
                onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                placeholder={translate('messageContentPlaceholder') || 'Escribe el contenido de tu mensaje aquí...'}
                className={`min-h-[120px] ${errors.content ? 'border-red-500' : ''}`}
              />
              {errors.content && <p className="text-red-500 text-sm mt-1">{errors.content}</p>}
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                variant="outline"
                onClick={() => setShowEditDialog(false)}
              >
                {translate('cancel') || 'Cancelar'}
              </Button>
              <Button onClick={handleUpdate}>
                {translate('saveChanges') || 'Guardar Cambios'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
