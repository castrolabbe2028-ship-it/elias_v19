































"use client";

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/language-context';
import { 
  Plus, 
  Users, 
  UserPlus, 
  GraduationCap,
  Mail,
  Key,
  Edit2,
  Trash2,
  Save,
  X,
  Eye,
  EyeOff,
  Shield,
  Crown,
  CheckCircle,
  AlertTriangle,
  Users2
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { UserFormDialog } from './UserFormDialog';
import { Switch } from '@/components/ui/switch';
import { 
  EducationCodeGenerator, 
  LocalStorageManager, 
  FormValidation,
  UsernameGenerator,
  EducationAutomation
} from '@/lib/education-utils';
import { validateRut } from '@/lib/rut';
import { Student, Teacher, UserFormData, Guardian } from '@/types/education';
import { getAllAvailableSubjects, getSubjectsForLevel, SubjectColor } from '@/lib/subjects-colors';

export default function UserManagement() {
  const { toast } = useToast();
  const { translate } = useLanguage();
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [administrators, setAdministrators] = useState<any[]>([]);
  const [courses, setCourses] = useState<any[]>([]);
  const [sections, setSections] = useState<any[]>([]);
  const [studentAssignments, setStudentAssignments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Años disponibles y año seleccionado
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  
  // Form states
  const [showUserDialog, setShowUserDialog] = useState(false);
  const [userType, setUserType] = useState<'student' | 'teacher' | 'admin' | 'guardian'>('student');
  const [editingUser, setEditingUser] = useState<Student | Teacher | Guardian | any | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [autoGenerateCredentials, setAutoGenerateCredentials] = useState(true);

  // Form data
  const [userForm, setUserForm] = useState<UserFormData>({
    username: '',
    name: '',
    email: '',
    rut: '',
    password: '',
    confirmPassword: '',
    role: 'student',
    courseId: '',
    sectionId: '',
    phone: '',
    studentIds: [],
    relationship: 'tutor'
  });

  // Selected subjects for teachers
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);

  // Form validation errors
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Role filter state (for clickable statistic cards)
  const [activeRoleFilter, setActiveRoleFilter] = useState<'all' | 'student' | 'teacher' | 'admin' | 'guardian'>('all');
  const studentsSectionRef = useRef<HTMLDivElement | null>(null);
  const teachersSectionRef = useRef<HTMLDivElement | null>(null);
  const adminsSectionRef = useRef<HTMLDivElement | null>(null);
  const guardiansSectionRef = useRef<HTMLDivElement | null>(null);

  // Estado para selección de estudiantes en formulario de apoderado
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [guardianRelationship, setGuardianRelationship] = useState<'mother' | 'father' | 'tutor' | 'other'>('tutor');

  // Load persisted role filter (if any)
  useEffect(() => {
    try {
      const saved = (localStorage.getItem('user-mgmt-role-filter') || 'all') as 'all' | 'student' | 'teacher' | 'admin' | 'guardian';
      if (saved) setActiveRoleFilter(saved);
    } catch {}
  }, []);

  // Persist role filter changes
  useEffect(() => {
    try {
      localStorage.setItem('user-mgmt-role-filter', activeRoleFilter);
    } catch {}
  }, [activeRoleFilter]);

  // Load data on component mount: inicializa años y datos (preferir admin-selected-year; fallback 2025)
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem('admin-selected-year') || '');
      let years = LocalStorageManager.listYears();
      // Asegurar que 2025 esté disponible tras un reinicio aunque aún no existan catálogos
      if (!years.includes(2025)) years = [2025, ...years].sort((a,b)=>b-a);
      setAvailableYears(years);
      const initialYear = (Number.isFinite(saved) && saved > 0) ? saved : (years[0] || 2025);
      setSelectedYear(initialYear);
      loadData(initialYear);
    } catch (e) {
      // fallback fuerte
      setAvailableYears([2025]);
      setSelectedYear(2025);
      loadData(2025);
    }
  }, []);

  // Reload when year changes
  useEffect(() => {
    if (!selectedYear) return;
    loadData(selectedYear);
  }, [selectedYear]);

  // Listen for changes in teacher assignments to refresh data automatically
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      // Recargar datos cuando cambie algo del namespace smart-student del año seleccionado
      if (!e.key) return;
      const key = e.key;
      const y = String(selectedYear);
      if (key.startsWith('smart-student-') && (key.endsWith(`-${y}`) || !/-\d{4}$/.test(key))) {
        loadData(selectedYear);
      }
    };

    // Agregar listener para cambios en localStorage
    window.addEventListener('storage', handleStorageChange);

    // También detectar cambios en el mismo tab usando un custom event
    const handleCustomStorageChange = () => {
      loadData(selectedYear);
    };

  window.addEventListener('teacherAssignmentsChanged', handleCustomStorageChange);
  window.addEventListener('studentAssignmentsChanged', handleCustomStorageChange);
  window.addEventListener('usersUpdated', handleCustomStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('teacherAssignmentsChanged', handleCustomStorageChange);
  window.removeEventListener('studentAssignmentsChanged', handleCustomStorageChange);
  window.removeEventListener('usersUpdated', handleCustomStorageChange);
    };
  }, [selectedYear]);

  const loadData = (year?: number) => {
    try {
      const y = year ?? selectedYear;
      const studentsData = LocalStorageManager.getStudentsForYear(y);
      const teachersData = LocalStorageManager.getTeachersForYear(y);
      const guardiansData = LocalStorageManager.getGuardiansForYear(y);
      const coursesData = LocalStorageManager.getCoursesForYear(y);
      const sectionsData = LocalStorageManager.getSectionsForYear(y);
      
      // Load administrators from dedicated storage and main users array
      const adminsFromStorage = JSON.parse(localStorage.getItem('smart-student-administrators') || '[]');
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const adminsFromUsers = allUsers.filter((user: any) => user.role === 'admin');
      
      // Combine and deduplicate administrators
      const allAdmins = [...adminsFromStorage];
      adminsFromUsers.forEach((admin: any) => {
        if (!allAdmins.find(a => a.id === admin.id)) {
          allAdmins.push(admin);
        }
      });

      // Migrate administrators without uniqueCode
      const migratedAdmins = allAdmins.map(admin => {
        if (!admin.uniqueCode) {
          return {
            ...admin,
            uniqueCode: EducationCodeGenerator.generateAdminCode()
          };
        }
        return admin;
      });

      // Save migrated administrators back to storage
      if (migratedAdmins.some(admin => !allAdmins.find(a => a.id === admin.id && a.uniqueCode === admin.uniqueCode))) {
        localStorage.setItem('smart-student-administrators', JSON.stringify(migratedAdmins));
      }

  setStudents(studentsData);
  setTeachers(teachersData);
  setGuardians(guardiansData);
      setAdministrators(migratedAdmins);
  setCourses(coursesData);
  setSections(sectionsData);
  
      // Cargar asignaciones de estudiantes
      const assignmentsData = LocalStorageManager.getStudentAssignmentsForYear(y) || [];
      setStudentAssignments(assignmentsData);

      // Asegurar que las asignaciones de estudiantes existan y estén sincronizadas
      try {
        ensureStudentAssignmentsConsistency(studentsData, y);
      } catch (e) {
        console.warn('[UserManagement] No se pudo asegurar la consistencia de asignaciones:', e);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast({
        title: translate('userManagementError') || 'Error',
        description: translate('userManagementCouldNotLoadData') || 'Could not load data',
        variant: 'destructive'
      });
    }
  };

  // Garantiza que exista un registro en smart-student-student-assignments por cada estudiante con courseId+sectionId
  const ensureStudentAssignmentsConsistency = (studentsList: Student[], year: number) => {
    const existing: any[] = LocalStorageManager.getStudentAssignmentsForYear(year);
    const keySet = new Set(existing.map(a => `${a.studentId}:${a.sectionId}`));
    const toAdd: any[] = [];

    for (const s of studentsList) {
      if (!s?.id || !s.courseId || !s.sectionId) continue;
      const key = `${s.id}:${s.sectionId}`;
      if (!keySet.has(key)) {
        toAdd.push({
          id: `sa-${s.id}-${s.sectionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          studentId: s.id,
          courseId: s.courseId,
          sectionId: s.sectionId,
          isActive: true,
          assignedAt: new Date().toISOString(),
          source: 'user-management-auto'
        });
        keySet.add(key);
      }
    }

    if (toAdd.length > 0) {
      const next = [...existing, ...toAdd];
      LocalStorageManager.setStudentAssignmentsForYear(year, next);
      // Recalcular contadores de secciones si la automatización está disponible
      try {
        const result = EducationAutomation.recalculateSectionCounts?.(translate, year);
        if (result?.success) {
          const updatedSections = LocalStorageManager.getSectionsForYear(year);
          setSections(updatedSections);
        }
      } catch {}

      // Notificar a otros módulos para refrescar
      window.dispatchEvent(new CustomEvent('studentAssignmentsChanged', {
        detail: { action: 'auto-ensure', year, added: toAdd.length, timestamp: new Date().toISOString() }
      }));
    }
  };

  // Auto-generate credentials when name changes
  useEffect(() => {
    if (autoGenerateCredentials && userForm.name.trim()) {
      const username = UsernameGenerator.generateFromName(userForm.name, userForm.role);
      const password = UsernameGenerator.generateRandomPassword();
      
      setUserForm(prev => ({
        ...prev,
        username,
        password,
        confirmPassword: password
      }));
    }
  }, [userForm.name, userForm.role, autoGenerateCredentials]);

  // Get sections for selected course
  const getAvailableSections = () => {
    if (!userForm.courseId) return [];
    return sections.filter(s => s.courseId === userForm.courseId);
  };

  // Get all available subjects for teachers (from all courses)
  const getAvailableSubjects = () => {
    return getAllAvailableSubjects();
  };  // Handle subject selection for teachers
  const handleSubjectToggle = (subjectName: string) => {
    setSelectedSubjects(prev => {
      if (prev.includes(subjectName)) {
        return prev.filter(s => s !== subjectName);
      } else {
        return [...prev, subjectName];
      }
    });
  };

  // Validate form
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Name validation
    if (!userForm.name.trim()) {
      errors.name = translate('userManagementNameRequired') || 'El nombre es requerido';
    } else if (!FormValidation.validateName(userForm.name)) {
      errors.name = translate('userManagementNameInvalid') || 'El nombre debe tener al menos 2 caracteres y solo letras';
    }

    // Username validation
    if (!userForm.username.trim()) {
      errors.username = translate('userManagementUsernameRequired') || 'El nombre de usuario es requerido';
    } else if (!FormValidation.validateUsername(userForm.username)) {
      errors.username = translate('userManagementUsernameInvalid') || 'El usuario debe tener 3-20 caracteres alfanuméricos';
    } else {
      // Check if username exists
      const allUsers = [...students, ...teachers, ...administrators];
      const existingUser = allUsers.find(u => 
        u.username === userForm.username && (!editingUser || u.id !== editingUser.id)
      );
      if (existingUser) {
        errors.username = translate('userManagementUsernameExists') || 'Este nombre de usuario ya existe';
      }
    }

    // Email validation (optional)
    if (userForm.email.trim()) {
      // Only validate format if email is provided
      if (!FormValidation.validateEmail(userForm.email)) {
        errors.email = translate('userManagementEmailInvalid') || 'El formato del email no es válido';
      } else {
        // Check if email exists
        const allUsers = [...students, ...teachers, ...guardians, ...administrators];
        const existingUser = allUsers.find(u => 
          u.email === userForm.email && (!editingUser || u.id !== editingUser.id)
        );
        if (existingUser) {
          errors.email = translate('userManagementEmailExists') || 'Este email ya está registrado';
        }
      }
    }

    // RUT validation (required for all users)
    const cleanRut = userForm.rut.trim();
    if (!cleanRut) {
      errors.rut = translate('userManagementRutRequired') || 'El RUT es requerido';
    } else if (!validateRut(cleanRut)) {
      errors.rut = translate('userManagementRutInvalid') || 'RUT inválido';
    }

    // Password validation (only for new users)
    if (!editingUser) {
      if (!userForm.password) {
        errors.password = translate('userManagementPasswordRequired') || 'La contraseña es requerida';
      } else {
        const passwordValidation = FormValidation.validatePassword(userForm.password);
        if (!passwordValidation.isValid) {
          errors.password = passwordValidation.errors[0];
        }
      }

      if (userForm.password !== userForm.confirmPassword) {
        errors.confirmPassword = translate('userManagementPasswordsNoMatch') || 'Las contraseñas no coinciden';
      }
    }

    // Student-specific validations
    if (userForm.role === 'student') {
      if (!userForm.courseId) {
        errors.courseId = translate('userManagementCourseRequiredForStudents') || 'El curso es requerido para estudiantes';
      }
      if (!userForm.sectionId) {
        errors.sectionId = translate('userManagementSectionRequiredForStudents') || 'La sección es requerida para estudiantes';
      }
    }

    // Teacher-specific validations
    if (userForm.role === 'teacher') {
      if (selectedSubjects.length === 0) {
        errors.subjects = translate('userManagementSelectSubjectForTeacher') || 'Selecciona al menos una asignatura para el profesor';
      }
    }

    // Guardian-specific validations
    if (userForm.role === 'guardian') {
      if (selectedStudentIds.length === 0) {
        errors.studentIds = translate('userManagementSelectStudentForGuardian') || 'Selecciona al menos un estudiante para el apoderado';
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle user creation/update
  const handleSaveUser = async () => {
    if (!validateForm()) {
      toast({
        title: translate('userManagementValidationError') || 'Validation error',
        description: translate('userManagementFixFormErrors') || 'Please fix the errors in the form',
        variant: 'destructive'
      });
      return;
    }

    setIsLoading(true);
    try {
      if (editingUser) {
        await handleUpdateUser();
      } else {
        await handleCreateUser();
      }
    } catch (error) {
      toast({
        title: translate('userManagementError') || 'Error',
        description: translate('userManagementCouldNotSaveUser') || 'Could not save user',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateUser = async () => {
    const baseUser = {
      id: crypto.randomUUID(),
      username: userForm.username.trim(),
      name: userForm.name.trim(),
      email: userForm.email.trim(),
  rut: userForm.rut.trim(),
      role: userForm.role,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (userForm.role === 'student') {
  const newStudent: Student = {
        ...baseUser,
        uniqueCode: EducationCodeGenerator.generateStudentCode(),
        role: 'student',
        courseId: userForm.courseId,
        sectionId: userForm.sectionId
      };

      const updatedStudents = [...students, newStudent];
      setStudents(updatedStudents);
  LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);

      // Disparar evento para notificar cambios en estudiantes
      window.dispatchEvent(new CustomEvent('studentAssignmentsChanged'));

      // Update section student count
  const updatedSections = sections.map(s => 
        s.id === userForm.sectionId 
          ? { ...s, studentCount: s.studentCount + 1 }
          : s
      );
      setSections(updatedSections);
  LocalStorageManager.setSectionsForYear(selectedYear, updatedSections);

    } else if (userForm.role === 'teacher') {
      const newTeacher: Teacher = {
        ...baseUser,
        uniqueCode: EducationCodeGenerator.generateTeacherCode(),
        role: 'teacher',
        assignedSections: [],
        selectedSubjects: [...selectedSubjects]
      };

  const updatedTeachers = [...teachers, newTeacher];
      setTeachers(updatedTeachers);
  LocalStorageManager.setTeachersForYear(selectedYear, updatedTeachers);
    } else if (userForm.role === 'admin') {
      const newAdmin = {
        ...baseUser,
        uniqueCode: EducationCodeGenerator.generateAdminCode(),
        role: 'admin',
        displayName: userForm.name.trim(),
        activeCourses: [], // Admin has access to all courses
        password: userForm.password
      };

      const updatedAdministrators = [...administrators, newAdmin];
      setAdministrators(updatedAdministrators);
      localStorage.setItem('smart-student-administrators', JSON.stringify(updatedAdministrators));
    } else if (userForm.role === 'guardian') {
      const newGuardian: Guardian = {
        ...baseUser,
        uniqueCode: EducationCodeGenerator.generateGuardianCode(),
        role: 'guardian',
        phone: (userForm as any).phone || '',
        studentIds: [...selectedStudentIds],
        relationship: guardianRelationship
      };

      const updatedGuardians = [...guardians, newGuardian];
      setGuardians(updatedGuardians);
      LocalStorageManager.setGuardiansForYear(selectedYear, updatedGuardians);

      // Crear relaciones apoderado-estudiante
      const existingRelations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear);
      const newRelations = selectedStudentIds.map((studentId, index) => ({
        id: `gsr-${newGuardian.id}-${studentId}-${Date.now()}`,
        guardianId: newGuardian.id,
        studentId,
        relationship: guardianRelationship,
        isPrimary: index === 0, // El primero es el principal
        createdAt: new Date()
      }));
      LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, [...existingRelations, ...newRelations]);
      
      // Disparar evento para notificar cambios en apoderados
      window.dispatchEvent(new CustomEvent('guardiansUpdated'));
    }

    // Also save to main users array (for backward compatibility)
  const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
    const newUserForMain = {
      ...baseUser,
      password: userForm.password // In a real app, this should be hashed
    };
    const updatedAllUsers = [...allUsers, newUserForMain];
    localStorage.setItem('smart-student-users', JSON.stringify(updatedAllUsers));

    // � Activar notificaciones por email por defecto para el nuevo usuario
    localStorage.setItem(`emailNotifications_${baseUser.id}`, 'true');
    console.log(`📧 [USER MGMT] Notificaciones por email activadas por defecto para: ${baseUser.username}`);

    // �🔄 Disparar evento de sincronización para estudiantes específicos
    window.dispatchEvent(new CustomEvent('usersUpdated', {
      detail: { 
        action: 'create', 
        userType: userForm.role,
        year: selectedYear,
        timestamp: new Date().toISOString() 
      }
    }));

    // Si es un estudiante, disparar evento específico
    if (userForm.role === 'student') {
    window.dispatchEvent(new CustomEvent('studentAssignmentsUpdated', {
        detail: { 
          action: 'create', 
          source: 'user-management',
      year: selectedYear,
          timestamp: new Date().toISOString() 
        }
      }));
    }

    resetForm();
    setShowUserDialog(false);

    toast({
      title: translate('userManagementSuccess') || 'Success',
      description: `${
        userForm.role === 'student' ? translate('userManagementStudent') || 'Student' : 
        userForm.role === 'teacher' ? translate('userManagementTeacher') || 'Teacher' : 
        translate('userManagementAdministrator') || 'Administrator'
      } ${translate('userManagementCreatedSuccessfully') || 'created successfully'}`,
      variant: 'default'
    });
  };

  const handleUpdateUser = async () => {
    if (!editingUser) return;

    const updatedUserData = {
      ...editingUser,
      username: userForm.username.trim(),
      name: userForm.name.trim(),
      email: userForm.email.trim(),
  rut: userForm.rut.trim(),
      updatedAt: new Date()
    };

    // Update password if provided
  if (userForm.password) {
      // In a real app, password should be hashed
    }

    if (editingUser.role === 'student') {
      const studentData = updatedUserData as Student;
      
      // Update course/section if changed
      if (userForm.courseId !== studentData.courseId || userForm.sectionId !== studentData.sectionId) {
        // Update student's course and section
        studentData.courseId = userForm.courseId;
        studentData.sectionId = userForm.sectionId;

        // Update student data
        const updatedStudents = students.map(s => 
          s.id === editingUser.id ? studentData : s
        );
        setStudents(updatedStudents);
        LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);

        // Recalculate section counts automatically
        const recalculateResult = EducationAutomation.recalculateSectionCounts(translate, selectedYear);
        if (recalculateResult.success) {
          // Reload sections with updated counts
          const updatedSections = LocalStorageManager.getSectionsForYear(selectedYear);
          setSections(updatedSections);
        }

        // Disparar evento para notificar cambios en estudiantes
        window.dispatchEvent(new CustomEvent('studentAssignmentsChanged'));
      } else {
        // If no section change, just update the student
  const updatedStudents = students.map(s => 
          s.id === editingUser.id ? studentData : s
        );
        setStudents(updatedStudents);
  LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);

        // Disparar evento para notificar cambios en estudiantes
        window.dispatchEvent(new CustomEvent('studentAssignmentsChanged'));
      }
    } else if (editingUser.role === 'teacher') {
      // Update teacher data
      const teacherData = updatedUserData as Teacher;
      teacherData.preferredCourseId = userForm.courseId;
      teacherData.selectedSubjects = [...selectedSubjects];
      
      // 🔄 Si cambió el username, actualizar referencias en todos los datos relacionados
      const oldUsername = editingUser.username;
      const newUsername = userForm.username.trim();
      const oldId = editingUser.id;
      
      if (oldUsername !== newUsername) {
        console.log(`🔄 Actualizando referencias de profesor: ${oldUsername} -> ${newUsername}`);
        
        // Helper para actualizar arrays en localStorage
        const updateStorageArray = (key: string, updateFn: (item: any) => any) => {
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (!Array.isArray(data)) return;
            const updated = data.map(updateFn);
            localStorage.setItem(key, JSON.stringify(updated));
            console.log(`✅ Actualizado: ${key}`);
          } catch (e) { console.warn(`Error actualizando ${key}:`, e); }
        };
        
        // Obtener todos los años relevantes (buscar claves que terminen en -YYYY)
        const relevantYears: number[] = [];
        const currentYear = new Date().getFullYear();
        for (let y = currentYear - 5; y <= currentYear + 1; y++) {
          relevantYears.push(y);
        }
        
        // 1. Actualizar comunicaciones (createdBy) - clave única sin año
        updateStorageArray('smart-student-communications', (c: any) => {
          if (c.createdBy === oldUsername) {
            return { ...c, createdBy: newUsername };
          }
          return c;
        });
        
        // 2. Actualizar tareas (assignedBy, teacherUsername) - clave única sin año
        updateStorageArray('smart-student-tasks', (t: any) => {
          if (t.assignedBy === oldUsername || t.teacherId === oldId || t.teacherUsername === oldUsername) {
            return { 
              ...t, 
              assignedBy: t.assignedBy === oldUsername ? newUsername : t.assignedBy,
              teacherUsername: t.teacherUsername === oldUsername ? newUsername : t.teacherUsername,
              teacherId: t.teacherId === oldUsername ? newUsername : t.teacherId
            };
          }
          return t;
        });
        
        // 3. Actualizar calificaciones (teacherUsername, createdBy) - clave única sin año
        updateStorageArray('smart-student-grades', (g: any) => {
          if (g.teacherUsername === oldUsername || g.createdBy === oldUsername || g.teacherId === oldUsername) {
            return { 
              ...g, 
              teacherUsername: g.teacherUsername === oldUsername ? newUsername : g.teacherUsername,
              createdBy: g.createdBy === oldUsername ? newUsername : g.createdBy,
              teacherId: g.teacherId === oldUsername ? newUsername : g.teacherId
            };
          }
          return g;
        });
        
        // 4. Actualizar asistencia (teacherUsername, createdBy, recordedBy) - clave única sin año
        updateStorageArray('smart-student-attendance', (a: any) => {
          if (a.teacherUsername === oldUsername || a.createdBy === oldUsername || a.recordedBy === oldUsername || a.teacherId === oldUsername) {
            return { 
              ...a, 
              teacherUsername: a.teacherUsername === oldUsername ? newUsername : a.teacherUsername,
              createdBy: a.createdBy === oldUsername ? newUsername : a.createdBy,
              recordedBy: a.recordedBy === oldUsername ? newUsername : a.recordedBy,
              teacherId: a.teacherId === oldUsername ? newUsername : a.teacherId
            };
          }
          return a;
        });
        
        // 5. Actualizar asignaciones de profesor - LEGACY y POR AÑO
        const updateTeacherAssignment = (a: any) => {
          if (a.teacherUsername === oldUsername || a.teacherId === oldUsername || a.teacherId === oldId) {
            return { 
              ...a, 
              teacherUsername: a.teacherUsername === oldUsername ? newUsername : a.teacherUsername,
              teacherId: (a.teacherId === oldUsername || a.teacherId === oldId) ? (a.teacherId === oldUsername ? newUsername : a.teacherId) : a.teacherId
            };
          }
          return a;
        };
        
        // Legacy (sin año)
        updateStorageArray('smart-student-teacher-assignments', updateTeacherAssignment);
        
        // Por año
        relevantYears.forEach(year => {
          updateStorageArray(`smart-student-teacher-assignments-${year}`, updateTeacherAssignment);
        });
        
        // 6. Actualizar presentaciones/slides (createdBy)
        updateStorageArray('smart-student-slides', (s: any) => {
          if (s.createdBy === oldUsername) {
            return { ...s, createdBy: newUsername };
          }
          return s;
        });
        
        // 7. Actualizar test-grades por año (teacherUsername, createdBy)
        relevantYears.forEach(year => {
          updateStorageArray(`smart-student-test-grades-${year}`, (g: any) => {
            if (g.teacherUsername === oldUsername || g.createdBy === oldUsername || g.teacherId === oldUsername) {
              return { 
                ...g, 
                teacherUsername: g.teacherUsername === oldUsername ? newUsername : g.teacherUsername,
                createdBy: g.createdBy === oldUsername ? newUsername : g.createdBy,
                teacherId: g.teacherId === oldUsername ? newUsername : g.teacherId
              };
            }
            return g;
          });
        });
        
        // 8. Actualizar teachers por año (el propio registro del profesor)
        relevantYears.forEach(year => {
          const key = `smart-student-teachers-${year}`;
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return;
            const teachersList = JSON.parse(raw);
            if (!Array.isArray(teachersList)) return;
            const updated = teachersList.map((t: any) => {
              if (t.username === oldUsername || t.id === oldId) {
                return { ...t, username: newUsername };
              }
              return t;
            });
            localStorage.setItem(key, JSON.stringify(updated));
            console.log(`✅ Actualizado: ${key}`);
          } catch (e) { console.warn(`Error actualizando ${key}:`, e); }
        });
        
        console.log(`✅ Migración de referencias de ${oldUsername} -> ${newUsername} completada`);
      }
      
  const updatedTeachers = teachers.map(t => 
        t.id === editingUser.id ? teacherData : t
      );
      setTeachers(updatedTeachers);
  LocalStorageManager.setTeachersForYear(selectedYear, updatedTeachers);
    } else if (editingUser.role === 'admin') {
      // Update administrator data
      const adminData = {
        ...updatedUserData,
        displayName: userForm.name.trim()
      };
      
      const updatedAdministrators = administrators.map(a => 
        a.id === editingUser.id ? adminData : a
      );
      setAdministrators(updatedAdministrators);
    } else if (editingUser.role === 'guardian') {
      // Update guardian data
      const guardianData = updatedUserData as Guardian;
      guardianData.phone = (userForm as any).phone || guardianData.phone;
      guardianData.studentIds = [...selectedStudentIds];
      guardianData.relationship = guardianRelationship;
      
      const updatedGuardians = guardians.map(g => 
        g.id === editingUser.id ? guardianData : g
      );
      setGuardians(updatedGuardians);
      LocalStorageManager.setGuardiansForYear(selectedYear, updatedGuardians);

      // Actualizar relaciones apoderado-estudiante
      const existingRelations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear);
      // Eliminar relaciones anteriores de este apoderado
      const filteredRelations = existingRelations.filter((r: any) => r.guardianId !== editingUser.id);
      // Crear nuevas relaciones
      const newRelations = selectedStudentIds.map((studentId, index) => ({
        id: `gsr-${editingUser.id}-${studentId}-${Date.now()}`,
        guardianId: editingUser.id,
        studentId,
        relationship: guardianRelationship,
        isPrimary: index === 0,
        createdAt: new Date()
      }));
      LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, [...filteredRelations, ...newRelations]);
      
      // Disparar evento para notificar cambios en apoderados
      window.dispatchEvent(new CustomEvent('guardiansUpdated'));
    }

    // Update main users array - buscar por id para soportar cambio de username
    const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
    const updatedAllUsers = allUsers.map((u: any) => 
      u.id === editingUser.id || u.username === editingUser.username 
        ? { ...u, ...updatedUserData, password: userForm.password || u.password }
        : u
    );
    localStorage.setItem('smart-student-users', JSON.stringify(updatedAllUsers));

    // 🔄 Disparar evento de sincronización para estudiantes específicos
  window.dispatchEvent(new CustomEvent('usersUpdated', {
      detail: { 
        action: 'update', 
        userType: editingUser.role,
    year: selectedYear,
        timestamp: new Date().toISOString() 
      }
    }));

    // Si es un estudiante, disparar evento específico
    if (editingUser.role === 'student') {
    window.dispatchEvent(new CustomEvent('studentAssignmentsUpdated', {
        detail: { 
          action: 'update', 
          source: 'user-management',
      year: selectedYear,
          timestamp: new Date().toISOString() 
        }
      }));
    }

    resetForm();
    setShowUserDialog(false);

    toast({
      title: translate('userManagementSuccess') || 'Success',
      description: translate('userManagementUserUpdatedSuccessfully') || 'User updated successfully',
      variant: 'default'
    });
  };

  const handleDeleteUser = (user: Student | Teacher | any) => {
    try {
      if (user.role === 'student') {
        const student = user as Student;
        
        // Decrease section student count
        if (student.sectionId) {
          const updatedSections = sections.map(s => 
            s.id === student.sectionId 
              ? { ...s, studentCount: Math.max(0, s.studentCount - 1) }
              : s
          );
          setSections(updatedSections);
          LocalStorageManager.setSectionsForYear(selectedYear, updatedSections);
        }

        const updatedStudents = students.filter(s => s.id !== user.id);
        setStudents(updatedStudents);
        LocalStorageManager.setStudentsForYear(selectedYear, updatedStudents);

        // Disparar evento para notificar cambios en estudiantes
        window.dispatchEvent(new CustomEvent('studentAssignmentsChanged'));
      } else if (user.role === 'teacher') {
  const updatedTeachers = teachers.filter(t => t.id !== user.id);
        setTeachers(updatedTeachers);
  LocalStorageManager.setTeachersForYear(selectedYear, updatedTeachers);
      } else if (user.role === 'admin') {
        const updatedAdministrators = administrators.filter(a => a.id !== user.id);
        setAdministrators(updatedAdministrators);
      } else if (user.role === 'guardian') {
        const updatedGuardians = guardians.filter(g => g.id !== user.id);
        setGuardians(updatedGuardians);
        LocalStorageManager.setGuardiansForYear(selectedYear, updatedGuardians);
        
        // Eliminar relaciones apoderado-estudiante
        const existingRelations = LocalStorageManager.getGuardianStudentRelationsForYear(selectedYear);
        const filteredRelations = existingRelations.filter((r: any) => r.guardianId !== user.id);
        LocalStorageManager.setGuardianStudentRelationsForYear(selectedYear, filteredRelations);
        
        // Disparar evento para notificar cambios en apoderados
        window.dispatchEvent(new CustomEvent('guardiansUpdated'));
      }

      // Remove from main users array
      const allUsers = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      const updatedAllUsers = allUsers.filter((u: any) => u.username !== user.username);
      localStorage.setItem('smart-student-users', JSON.stringify(updatedAllUsers));

      // 🔄 Disparar evento de sincronización para estudiantes específicos
    window.dispatchEvent(new CustomEvent('usersUpdated', {
        detail: { 
          action: 'delete', 
          userType: user.role,
      year: selectedYear,
          timestamp: new Date().toISOString() 
        }
      }));

      // Si es un estudiante, disparar evento específico
      if (user.role === 'student') {
    window.dispatchEvent(new CustomEvent('studentAssignmentsUpdated', {
          detail: { 
            action: 'delete', 
            source: 'user-management',
      year: selectedYear,
            timestamp: new Date().toISOString() 
          }
        }));
      }

      toast({
        title: translate('userManagementSuccess') || 'Success',
        description: translate('userManagementUserDeletedSuccessfully') || 'User deleted successfully',
        variant: 'default'
      });
    } catch (error) {
      toast({
        title: translate('userManagementError') || 'Error',
        description: translate('userManagementCouldNotDeleteUser') || 'Could not delete user',
        variant: 'destructive'
      });
    }
  };

  const resetForm = () => {
    setUserForm({
      username: '',
      name: '',
      rut: '',
      email: '',
      password: '',
      confirmPassword: '',
      role: 'student',
      courseId: '',
      sectionId: '',
      phone: '',
      studentIds: [],
      relationship: 'tutor'
    });
    setSelectedSubjects([]);
    setSelectedStudentIds([]);
    setGuardianRelationship('tutor');
    setValidationErrors({});
    setEditingUser(null);
    setAutoGenerateCredentials(true);
  };

  const openEditDialog = (user: Student | Teacher | Guardian | any) => {
    setEditingUser(user);
    setUserForm({
      username: user.username,
      name: user.name || user.displayName,
  rut: (user as any).rut || '',
      email: user.email,
      password: '', // Always empty when editing
      confirmPassword: '', // Always empty when editing
      role: user.role,
      courseId: user.role === 'student' ? (user as Student).courseId || '' : '',
      sectionId: user.role === 'student' ? (user as Student).sectionId || '' : '',
      phone: user.role === 'guardian' ? (user as Guardian).phone || '' : ''
    } as any);
    
    // Load selected subjects for teachers
    if (user.role === 'teacher') {
      setSelectedSubjects((user as Teacher).selectedSubjects || []);
      setSelectedStudentIds([]);
    } else if (user.role === 'guardian') {
      setSelectedSubjects([]);
      setSelectedStudentIds((user as Guardian).studentIds || []);
      setGuardianRelationship((user as Guardian).relationship || 'tutor');
    } else {
      setSelectedSubjects([]);
    }
    
    setAutoGenerateCredentials(false); // Never auto-generate when editing
    setShowUserDialog(true);
  };

  const getCourseAndSectionName = (student: Student) => {
    const course = courses.find(c => c.id === student.courseId);
    const section = sections.find(s => s.id === student.sectionId);
    return {
  courseName: course?.name || (translate('userManagementNoCourseAssigned') || 'Sin curso asignado'),
  sectionName: section?.name || (translate('userManagementNoSectionAssigned') || 'Sin sección asignada')
    };
  };

  const getTeacherCourseInfo = (teacher: Teacher) => {
    // Obtener asignaciones de la pestaña Asignaciones
  const teacherAssignments = LocalStorageManager.getTeacherAssignmentsForYear(selectedYear);
    const teacherAssignmentsList = teacherAssignments.filter((assignment: any) => assignment.teacherId === teacher.id);
    
    if (teacherAssignmentsList.length > 0) {
      // Obtener información de las secciones asignadas agrupadas por sección
      const sectionAssignments = teacherAssignmentsList.reduce((acc: any, assignment: any) => {
        const section = sections.find(s => s.id === assignment.sectionId);
        const course = section ? courses.find(c => c.id === section.courseId) : null;
        
        if (section && course) {
          const sectionKey = `${course.name} - ${section.name}`;
          if (!acc[sectionKey]) {
            acc[sectionKey] = {
              courseName: course.name,
              sectionName: section.name,
              subjects: []
            };
          }
          acc[sectionKey].subjects.push(assignment.subjectName);
        }
        return acc;
      }, {});
      
      const assignedSectionNames = Object.keys(sectionAssignments);
      
      return {
        courseName: assignedSectionNames.length > 0 
          ? assignedSectionNames.join(', ')
          : (translate('userManagementNoSectionAssigned') || 'Sin sección asignada'),
        courseLevel: null,
        subjects: teacher.selectedSubjects || [],
        assignments: sectionAssignments,
        hasAssignments: assignedSectionNames.length > 0
      };
    }
    
    // Fallback a la implementación anterior si no hay asignaciones
    const course = courses.find(c => c.id === teacher.preferredCourseId);
    return {
      courseName: course?.name || (translate('userManagementNoCourseAssigned') || 'Sin curso asignado'),
      courseLevel: course?.level || null,
      subjects: teacher.selectedSubjects || [],
      assignments: {},
      hasAssignments: false
    };
  };

  // Obtener información de estudiantes a cargo de un apoderado
  const getGuardianStudentsInfo = (guardian: Guardian) => {
    const studentIds = guardian.studentIds || [];
    const studentsInfo = studentIds.map(studentId => {
      const student = students.find(s => s.id === studentId);
      if (!student) return null;
      const { courseName, sectionName } = getCourseAndSectionName(student);
      return {
        id: student.id,
        name: student.name,
        courseName,
        sectionName
      };
    }).filter(Boolean);
    return studentsInfo;
  };

  // Obtener texto de parentesco
  const getRelationshipText = (relationship?: string) => {
    switch (relationship) {
      case 'mother': return translate('relationshipMother') || 'Madre';
      case 'father': return translate('relationshipFather') || 'Padre';
      case 'tutor': return translate('relationshipTutor') || 'Tutor';
      case 'other': return translate('relationshipOther') || 'Otro';
      default: return translate('relationshipTutor') || 'Tutor';
    }
  };

  // Function to get role badge colors (matching configuration)
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
      case 'guardian': return <Users2 className="w-3 h-3 mr-1" />;
      default: return null;
    }
  };

  const handleSelectRoleFilter = (role: 'all' | 'student' | 'teacher' | 'admin' | 'guardian') => {
    setActiveRoleFilter(role);
    // Smooth scroll to the corresponding section (when visible)
    requestAnimationFrame(() => {
      const target = role === 'student' ? studentsSectionRef.current
        : role === 'teacher' ? teachersSectionRef.current
        : role === 'admin' ? adminsSectionRef.current
        : role === 'guardian' ? guardiansSectionRef.current
        : null;
      if (target) {
        try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center">
            <Users className="w-6 h-6 mr-2 text-blue-500" />
            {translate('userManagementMainTitle') || 'Gestión de Usuarios'}
          </h2>
          <p className="text-muted-foreground">
            {translate('userManagementCreateAndManage') || 'Crea y administra estudiantes y profesores'}
          </p>
        </div>
        
        <div className="flex flex-wrap gap-2">
          {/* Selector de año */}
          <div className="flex items-center gap-2">
            <Label className="text-sm text-muted-foreground">{translate('calendarYear') || 'Año'}</Label>
            <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(parseInt(v, 10))}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder={translate('selectYear') || 'Seleccionar año'} />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button 
            onClick={() => { resetForm(); setUserForm(prev => ({ ...prev, role: 'student' })); setShowUserDialog(true); }}
            className="bg-blue-600 hover:bg-blue-500 text-white"
          >
            <UserPlus className="w-4 h-4 mr-2" />
            {translate('userManagementNewUser') || 'Nuevo Usuario'}
          </Button>
          <UserFormDialog
            open={showUserDialog}
            onOpenChange={(open) => {
              if (!open) resetForm();
              setShowUserDialog(open);
            }}
            form={{
              name: userForm.name,
              rut: userForm.rut,
              email: userForm.email,
              username: userForm.username,
              password: userForm.password,
              confirmPassword: userForm.confirmPassword,
              role: userForm.role,
              autoGenerate: autoGenerateCredentials,
              courseId: userForm.courseId,
              sectionId: userForm.sectionId,
              selectedSubjects: selectedSubjects,
              phone: (userForm as any).phone || '',
              studentIds: selectedStudentIds,
              relationship: guardianRelationship,
            }}
            setForm={(updater) => {
              setUserForm(prev => {
                const withSel: any = { ...prev, selectedSubjects, studentIds: selectedStudentIds, relationship: guardianRelationship };
                const next: any = updater(withSel);
                if (JSON.stringify(next.selectedSubjects || []) !== JSON.stringify(selectedSubjects)) {
                  setSelectedSubjects(next.selectedSubjects || []);
                }
                if (JSON.stringify(next.studentIds || []) !== JSON.stringify(selectedStudentIds)) {
                  setSelectedStudentIds(next.studentIds || []);
                }
                if (next.relationship && next.relationship !== guardianRelationship) {
                  setGuardianRelationship(next.relationship);
                }
                const { selectedSubjects: _omit, section, studentIds: _omit2, relationship: _omit3, ...rest } = next;
                return { ...prev, ...rest };
              });
            }}
            validationErrors={validationErrors}
            onSubmit={handleSaveUser}
            isEditing={!!editingUser}
            availableCourses={courses}
            availableSections={sections}
            availableSubjects={getAllAvailableSubjects()}
            availableStudents={students}
            studentAssignments={studentAssignments}
            showAutoGenerate={!editingUser}
            autoGenerateChecked={autoGenerateCredentials}
            onToggleAutoGenerate={(checked) => setAutoGenerateCredentials(checked)}
          />
        </div>
      </div>

      {/* Statistics Cards (clickable filters) */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card
          onClick={() => handleSelectRoleFilter('student')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectRoleFilter('student'); }}
          className={`transition cursor-pointer hover:shadow ${activeRoleFilter === 'student' ? 'ring-2 ring-green-500' : ''}`}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <GraduationCap className="w-4 h-4 mr-2" />
              {translate('userManagementStudents') || 'Estudiantes'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{students.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {students.filter(s => s.isActive).length} {translate('userManagementActive') || 'activos'}
            </div>
          </CardContent>
        </Card>

        <Card
          onClick={() => handleSelectRoleFilter('teacher')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectRoleFilter('teacher'); }}
          className={`transition cursor-pointer hover:shadow ${activeRoleFilter === 'teacher' ? 'ring-2 ring-blue-500' : ''}`}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <Users className="w-4 h-4 mr-2" />
              {translate('userManagementTeachers') || 'Profesores'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{teachers.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {teachers.filter(t => t.isActive).length} {translate('userManagementActive') || 'activos'}
            </div>
          </CardContent>
        </Card>

        <Card
          onClick={() => handleSelectRoleFilter('admin')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectRoleFilter('admin'); }}
          className={`transition cursor-pointer hover:shadow ${activeRoleFilter === 'admin' ? 'ring-2 ring-red-500' : ''}`}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <Shield className="w-4 h-4 mr-2" />
              {translate('userManagementAdministrators') || 'Administradores'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{administrators.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {administrators.filter(a => a.isActive !== false).length} {translate('userManagementActive') || 'activos'}
            </div>
          </CardContent>
        </Card>

        <Card
          onClick={() => handleSelectRoleFilter('guardian')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectRoleFilter('guardian'); }}
          className={`transition cursor-pointer hover:shadow ${activeRoleFilter === 'guardian' ? 'ring-2 ring-purple-500' : ''}`}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center">
              <Users2 className="w-4 h-4 mr-2" />
              {translate('userManagementGuardians') || 'Apoderados'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{guardians.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {guardians.filter(g => g.isActive !== false).length} {translate('userManagementActive') || 'activos'}
            </div>
          </CardContent>
        </Card>

        <Card
          onClick={() => handleSelectRoleFilter('all')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectRoleFilter('all'); }}
          className={`transition cursor-pointer hover:shadow ${activeRoleFilter === 'all' ? 'ring-2 ring-gray-500' : ''}`}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              {translate('userManagementTotalUsers') || 'Total Usuarios'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{students.length + teachers.length + guardians.length + administrators.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {translate('userManagementInTheSystem') || 'En el sistema'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Active filter banner */}
      {activeRoleFilter !== 'all' && (
        <div className="flex items-center justify-between p-3 border rounded-md bg-muted/40">
          <div className="text-sm">
            {translate('filterShowing') || 'Mostrando'}{' '}
            <strong>
              {activeRoleFilter === 'student' ? (translate('userManagementStudents') || 'Estudiantes') :
               activeRoleFilter === 'teacher' ? (translate('userManagementTeachers') || 'Profesores') :
               activeRoleFilter === 'guardian' ? (translate('userManagementGuardians') || 'Apoderados') :
               (translate('userManagementAdministrators') || 'Administradores')}
            </strong>
          </div>
          <Button variant="outline" size="sm" onClick={() => handleSelectRoleFilter('all')}>
            {translate('clearFilter') || 'Quitar filtro'}
          </Button>
        </div>
      )}

      {/* Students Table */}
      {(activeRoleFilter === 'all' || activeRoleFilter === 'student') && (
      <Card ref={studentsSectionRef as any}>
        <CardHeader>
          <CardTitle className="flex items-center">
            <GraduationCap className="w-5 h-5 mr-2" />
            {translate('userManagementStudents') || 'Estudiantes'} ({students.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {students.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <GraduationCap className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{translate('userManagementNoStudentsRegistered') || 'No hay estudiantes registrados'}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {students.map(student => {
                const { courseName, sectionName } = getCourseAndSectionName(student);
                
                return (
                  <div
                    key={student.id}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <div>
                          <h4 className="font-medium">{student.name}</h4>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <span>@{student.username}</span>
                            <span>•</span>
                            <span>{student.email}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs dark:border-gray-600 dark:text-gray-200">
                              {student.uniqueCode}
                            </Badge>
                            <Badge className={`text-xs ${getRoleColor('student')}`}>
                              {getRoleIcon('student')}
                              {translate('userManagementStudent') || 'Estudiante'}
                            </Badge>
                            <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900 dark:text-blue-200 dark:border-blue-700">
                              {courseName} - {sectionName}
                            </Badge>
                            {student.isActive === false && (
                              <Badge variant="destructive" className="text-xs">
                                {translate('statusInactive') || 'Inactivo'}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEditDialog(student)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteUser(student)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Teachers Table */}
      {(activeRoleFilter === 'all' || activeRoleFilter === 'teacher') && (
      <Card ref={teachersSectionRef as any}>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Users className="w-5 h-5 mr-2" />
            {translate('userManagementTeachers') || 'Profesores'} ({teachers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {teachers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{translate('userManagementNoTeachersRegistered') || 'No hay profesores registrados'}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {teachers.map(teacher => {
                const teacherInfo = getTeacherCourseInfo(teacher);
                return (
                <div
                  key={teacher.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <div>
                        <h4 className="font-medium">{teacher.name}</h4>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span>@{teacher.username}</span>
                          <span>•</span>
                          <span>{teacher.email}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs dark:border-gray-600 dark:text-gray-200">
                            {teacher.uniqueCode}
                          </Badge>
                          <Badge className={`text-xs ${getRoleColor('teacher')}`}>
                            {getRoleIcon('teacher')}
                            {translate('userManagementTeacher') || 'Profesor'}
                          </Badge>
              {teacherInfo.hasAssignments ? (
                            <Badge variant="default" className="text-xs bg-green-500 hover:bg-green-600">
                <CheckCircle className="w-3 h-3 mr-1" />
                {translate('statusAssigned') || 'Asignado'}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                <AlertTriangle className="w-3 h-3 mr-1" />
                {translate('statusUnassigned') || 'No asignado'}
                            </Badge>
                          )}
                          {teacher.isActive === false && (
                            <Badge variant="destructive" className="text-xs">
                              {translate('statusInactive') || 'Inactivo'}
                            </Badge>
                          )}
                        </div>
                        
                        {/* Mostrar asignaciones específicas si las hay */}
                        {teacherInfo.hasAssignments && (
                          <div className="mt-2 space-y-2">
                            {Object.entries(teacherInfo.assignments).map(([sectionKey, info]: [string, any]) => (
                              <div key={sectionKey} className="flex flex-wrap items-center gap-2">
                                {/* Badge del curso y sección */}
                                <Badge variant="outline" className="text-xs font-semibold bg-blue-50 text-blue-700 border-blue-200">
                                  {info.courseName} - {info.sectionName}
                                </Badge>
                                
                                {/* Badges de las asignaturas */}
                                <div className="flex flex-wrap gap-1">
                                  {info.subjects.map((subjectName: string) => {
                                    const subjectColor = getAllAvailableSubjects()
                                      .find(s => s.name === subjectName);
                                    return (
                                      <Badge
                                        key={`${sectionKey}-${subjectName}`}
                                        className="text-xs font-bold border-0 px-2 py-1"
                                        style={{
                                          backgroundColor: subjectColor?.bgColor || '#e5e7eb',
                                          color: subjectColor?.textColor || '#374151'
                                        }}
                                        title={subjectName}
                                      >
                                        {subjectColor?.abbreviation || subjectName.substring(0, 3).toUpperCase()}
                                      </Badge>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        
                        {/* Subject badges */}
            {teacherInfo.subjects.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
              <span className="text-xs text-muted-foreground mr-1">{translate('userManagementTrainedIn') || 'Capacitado en:'}</span>
                            {teacherInfo.subjects.map(subjectName => {
                              const subjectColor = getAllAvailableSubjects()
                                .find(s => s.name === subjectName);
                              return (
                                <Badge
                                  key={subjectName}
                                  className="text-xs font-bold border-0 px-2 py-1"
                                  style={{
                                    backgroundColor: subjectColor?.bgColor || '#e5e7eb',
                                    color: subjectColor?.textColor || '#374151'
                                  }}
                                  title={subjectName}
                                >
                                  {subjectColor?.abbreviation || subjectName.substring(0, 3).toUpperCase()}
                                </Badge>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEditDialog(teacher)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteUser(teacher)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Administrators Table */}
      {(activeRoleFilter === 'all' || activeRoleFilter === 'admin') && (
      <Card ref={adminsSectionRef as any}>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Shield className="w-5 h-5 mr-2" />
            {translate('userManagementAdministrators') || 'Administradores'} ({administrators.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {administrators.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{translate('userManagementNoAdministratorsRegistered') || 'No hay administradores registrados'}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {administrators.map(admin => (
                <div
                  key={admin.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <div>
                        <h4 className="font-medium">{admin.name || admin.displayName}</h4>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span>@{admin.username}</span>
                          <span>•</span>
                          <span>{admin.email}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {admin.uniqueCode && (
                            <Badge variant="outline" className="text-xs dark:border-gray-600 dark:text-gray-200">
                              {admin.uniqueCode}
                            </Badge>
                          )}
                          <Badge className={`text-xs ${getRoleColor('admin')}`}>
                            {getRoleIcon('admin')}
                            {translate('userManagementAdministrator') || 'Administrador'}
                          </Badge>
                          {admin.isActive === false && (
                            <Badge variant="destructive" className="text-xs">
                              Inactivo
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEditDialog(admin)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteUser(admin)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Guardians (Apoderados) Table */}
      {(activeRoleFilter === 'all' || activeRoleFilter === 'guardian') && (
      <Card ref={guardiansSectionRef as any}>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Users2 className="w-5 h-5 mr-2" />
            {translate('userManagementGuardians') || 'Apoderados'} ({guardians.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {guardians.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users2 className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{translate('userManagementNoGuardiansRegistered') || 'No hay apoderados registrados'}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {guardians.map(guardian => {
                const studentsInfo = getGuardianStudentsInfo(guardian);
                return (
                <div
                  key={guardian.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <div>
                        <h4 className="font-medium">{guardian.name}</h4>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span>@{guardian.username}</span>
                          <span>•</span>
                          <span>{guardian.email}</span>
                          {guardian.phone && (
                            <>
                              <span>•</span>
                              <span>{guardian.phone}</span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs dark:border-gray-600 dark:text-gray-200">
                            {guardian.uniqueCode}
                          </Badge>
                          <Badge className={`text-xs ${getRoleColor('guardian')}`}>
                            {getRoleIcon('guardian')}
                            {translate('userManagementGuardian') || 'Apoderado'}
                          </Badge>
                          <Badge variant="secondary" className="text-xs bg-purple-50 text-purple-700 border border-purple-200 dark:bg-purple-900 dark:text-purple-200 dark:border-purple-700">
                            {getRelationshipText(guardian.relationship)}
                          </Badge>
                          {guardian.isActive === false && (
                            <Badge variant="destructive" className="text-xs">
                              {translate('statusInactive') || 'Inactivo'}
                            </Badge>
                          )}
                        </div>
                        
                        {/* Estudiantes a cargo */}
                        {studentsInfo.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <span className="text-xs text-muted-foreground">{translate('userManagementStudentsInCharge') || 'Estudiantes a cargo:'}</span>
                            <div className="flex flex-wrap gap-2">
                              {studentsInfo.map((student: any) => (
                                <Badge 
                                  key={student.id} 
                                  variant="outline" 
                                  className="text-xs bg-green-50 text-green-700 border-green-200 dark:bg-green-900 dark:text-green-200 dark:border-green-700"
                                >
                                  <GraduationCap className="w-3 h-3 mr-1" />
                                  {student.name} ({student.courseName} - {student.sectionName})
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        
                        {studentsInfo.length === 0 && (
                          <div className="mt-2">
                            <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              {translate('userManagementNoStudentsAssigned') || 'Sin estudiantes asignados'}
                            </Badge>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEditDialog(guardian)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteUser(guardian)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors dark:text-red-300 dark:hover:text-red-200 dark:hover:bg-red-900/40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
