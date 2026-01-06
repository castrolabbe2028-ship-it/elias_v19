/**
 * Servicio para gestionar datos de usuarios desde el backend
 */

// Configuración del backend
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

// Interfaces para los tipos de datos
export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: 'student' | 'teacher' | 'admin';
  fullName?: string;
  activeCourses?: string[];
  activeCourseNames?: string[];
  teachingSubjects?: string[];
  enrolledCourses?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Course {
  id: string;
  name: string;
  level: string;
  subjects: string[];
  studentsCount: number;
  teacherId?: string;
}

export interface Subject {
  id: string;
  name: string;
  tag: string;
  colorClass: string;
  courseId: string;
}

// Clase principal del servicio
export class UserService {
  private static instance: UserService;
  
  static getInstance(): UserService {
    if (!UserService.instance) {
      UserService.instance = new UserService();
    }
    return UserService.instance;
  }

  /**
   * Obtener perfil completo del usuario por username
   */
  async getUserProfile(username: string): Promise<UserProfile | null> {
    try {
      console.log('🔄 [USER SERVICE] Obteniendo perfil para:', username);
      console.log('🔄 [USER SERVICE] API_BASE_URL:', API_BASE_URL);
      
      const response = await fetch(`${API_BASE_URL}/users/${username}/profile`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthToken(),
        },
      });

      if (!response.ok) {
        console.warn('⚠️ [USER SERVICE] Backend no disponible, usando localStorage como fallback');
        return this.getUserProfileFromLocalStorage(username);
      }

      const profile = await response.json();
      console.log('✅ [USER SERVICE] Perfil obtenido del backend:', profile);
      
      return profile;
    } catch (error) {
      console.warn('⚠️ [USER SERVICE] Error conectando con backend, usando localStorage:', error);
      return this.getUserProfileFromLocalStorage(username);
    }
  }

  /**
   * Obtener cursos asignados a un usuario
   */
  async getUserCourses(username: string): Promise<Course[]> {
    try {
      console.log('🔄 [USER SERVICE] Obteniendo cursos para:', username);
      console.log('🔄 [USER SERVICE] API_BASE_URL:', API_BASE_URL);
      
      const response = await fetch(`${API_BASE_URL}/users/${username}/courses`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthToken(),
        },
      });

      if (!response.ok) {
        console.warn('⚠️ [USER SERVICE] Backend no disponible para cursos');
        return this.getUserCoursesFromLocalStorage(username);
      }

      const courses = await response.json();
      console.log('✅ [USER SERVICE] Cursos obtenidos del backend:', courses);
      
      return courses;
    } catch (error) {
      console.warn('⚠️ [USER SERVICE] Error obteniendo cursos del backend:', error);
      return this.getUserCoursesFromLocalStorage(username);
    }
  }

  /**
   * Obtener asignaturas de un usuario
   */
  async getUserSubjects(username: string): Promise<Subject[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/users/${username}/subjects`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthToken(),
        },
      });

      if (!response.ok) {
        console.warn('⚠️ [USER SERVICE] Backend no disponible para asignaturas');
        return this.getUserSubjectsFromLocalStorage(username);
      }

      const subjects = await response.json();
      console.log('✅ [USER SERVICE] Asignaturas obtenidas del backend:', subjects);
      
      return subjects;
    } catch (error) {
      console.warn('⚠️ [USER SERVICE] Error obteniendo asignaturas del backend:', error);
      return this.getUserSubjectsFromLocalStorage(username);
    }
  }

  /**
   * Fallback: Obtener datos del usuario desde localStorage
   */
  private getUserProfileFromLocalStorage(username: string): UserProfile | null {
    try {
      // Intentar con la estructura actual de localStorage
      const storedUsers = localStorage.getItem('smart-student-users');
      if (storedUsers) {
        const users = JSON.parse(storedUsers);
        const user = users.find((u: any) => u.username === username);
        
        if (user) {
          console.log('📦 [USER SERVICE] Datos obtenidos del localStorage:', user);
          return {
            id: user.id || username,
            username: user.username,
            email: user.email || `${username}@smartstudent.com`,
            role: user.role || 'student',
            fullName: user.fullName || user.username,
            activeCourses: user.activeCourses || [],
            activeCourseNames: user.activeCourseNames || [],
            teachingSubjects: user.teachingSubjects || [],
            enrolledCourses: user.enrolledCourses || [],
          };
        }
      }

      // Fallback adicional: intentar con la estructura legacy
      const legacyUser = localStorage.getItem('user');
      if (legacyUser) {
        const user = JSON.parse(legacyUser);
        if (user.username === username) {
          console.log('📦 [USER SERVICE] Datos legacy del localStorage:', user);
          return {
            id: user.id || username,
            username: user.username,
            email: user.email || `${username}@smartstudent.com`,
            role: user.role || 'student',
            fullName: user.fullName || user.username,
            activeCourses: user.activeCourses || [],
            activeCourseNames: user.activeCourseNames || [],
            teachingSubjects: user.teachingSubjects || [],
            enrolledCourses: user.enrolledCourses || [],
          };
        }
      }

      return null;
    } catch (error) {
      console.error('❌ [USER SERVICE] Error accediendo localStorage:', error);
      return null;
    }
  }

  /**
   * Fallback: Obtener cursos desde localStorage
   */
  private getUserCoursesFromLocalStorage(username: string): Course[] {
    const profile = this.getUserProfileFromLocalStorage(username);
    if (!profile) return [];

    const courses: Course[] = [];
    
    // Para profesores, usar activeCourseNames
    if (profile.role === 'teacher' && profile.activeCourseNames) {
      profile.activeCourseNames.forEach((courseName, index) => {
        courses.push({
          id: `course-${index}`,
          name: courseName,
          level: this.extractLevelFromCourseName(courseName),
          subjects: profile.teachingSubjects || [],
          studentsCount: 0, // No disponible en localStorage
          teacherId: profile.id,
        });
      });
    }
    
    // Para estudiantes, usar activeCourses o enrolledCourses
    if (profile.role === 'student') {
      const studentCourses = profile.activeCourses || profile.enrolledCourses || [];
      studentCourses.forEach((courseName, index) => {
        courses.push({
          id: `course-${index}`,
          name: courseName,
          level: this.extractLevelFromCourseName(courseName),
          subjects: [], // Se obtendría del backend normalmente
          studentsCount: 0,
        });
      });
    }

    return courses;
  }

  /**
   * Fallback: Obtener asignaturas desde localStorage
   */
  private getUserSubjectsFromLocalStorage(username: string): Subject[] {
    const profile = this.getUserProfileFromLocalStorage(username);
    if (!profile) return [];

    const subjectMap: Record<string, { tag: string; colorClass: string }> = {
      'Matemáticas': { tag: "MAT", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300" },
      'Ciencias Naturales': { tag: "CIE", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
      'Historia': { tag: "HIS", colorClass: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
      'Lenguaje y Comunicación': { tag: "LEN", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
      'Lenguaje': { tag: "LEN", colorClass: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
      'Física': { tag: "FIS", colorClass: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300" },
      'Química': { tag: "QUI", colorClass: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300" },
      'Biología': { tag: "BIO", colorClass: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300" },
      'Inglés': { tag: "ING", colorClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300" },
    };

    const subjects: Subject[] = [];
    
    if (profile.role === 'teacher' && profile.teachingSubjects) {
      profile.teachingSubjects.forEach((subjectName, index) => {
        const subjectInfo = subjectMap[subjectName];
        if (subjectInfo) {
          subjects.push({
            id: `subject-${index}`,
            name: subjectName,
            tag: subjectInfo.tag,
            colorClass: subjectInfo.colorClass,
            courseId: '', // Se obtendría del backend
          });
        }
      });
    }

    return subjects;
  }

  /**
   * Extraer nivel del nombre del curso
   */
  private extractLevelFromCourseName(courseName: string): string {
    if (courseName.includes('Básico')) return 'Básico';
    if (courseName.includes('Medio')) return 'Medio';
    return 'Básico';
  }

  /**
   * Obtener token de autorización
   */
  private getAuthToken(): string {
    // En el futuro, esto vendría de un contexto de autenticación
    const token = localStorage.getItem('authToken');
    return token ? `Bearer ${token}` : '';
  }

  /**
   * Actualizar perfil de usuario
   */
  async updateUserProfile(username: string, updates: Partial<UserProfile>): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/users/${username}/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthToken(),
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        console.warn('⚠️ [USER SERVICE] No se pudo actualizar en backend, actualizando localStorage');
        return this.updateUserProfileInLocalStorage(username, updates);
      }

      console.log('✅ [USER SERVICE] Perfil actualizado en backend');
      return true;
    } catch (error) {
      console.warn('⚠️ [USER SERVICE] Error actualizando perfil en backend:', error);
      return this.updateUserProfileInLocalStorage(username, updates);
    }
  }

  /**
   * Actualizar preferencia de notificaciones por email del usuario
   */
  async updateUserEmailNotificationPreference(userId: string, enabled: boolean, email: string): Promise<boolean> {
    try {
      console.log('🔔 [USER SERVICE] Actualizando preferencia de notificaciones:', { userId, enabled, email });
      
      // Guardar en localStorage como respaldo
      localStorage.setItem(`emailNotifications_${userId}`, String(enabled));
      
      // Intentar guardar en backend/Firebase
      const response = await fetch(`${API_BASE_URL}/users/${userId}/notification-preferences`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthToken(),
        },
        body: JSON.stringify({ 
          emailNotificationsEnabled: enabled,
          notificationEmail: email,
          senderEmail: 'notificaciones@smartstudent.online'
        }),
      });

      if (!response.ok) {
        console.warn('⚠️ [USER SERVICE] Backend no disponible, preferencia guardada solo en localStorage');
        return true; // Retornamos true porque localStorage funcionó
      }

      console.log('✅ [USER SERVICE] Preferencia de notificaciones actualizada en backend');
      return true;
    } catch (error) {
      console.warn('⚠️ [USER SERVICE] Error guardando preferencia en backend, usando localStorage:', error);
      return true; // Retornamos true porque localStorage funcionó
    }
  }

  /**
   * Obtener preferencia de notificaciones por email del usuario
   */
  async getUserEmailNotificationPreference(userId: string): Promise<boolean> {
    try {
      // Primero intentar obtener de localStorage
      const localPref = localStorage.getItem(`emailNotifications_${userId}`);
      if (localPref !== null) {
        return localPref === 'true';
      }
      
      // Si no está en localStorage, intentar backend
      const response = await fetch(`${API_BASE_URL}/users/${userId}/notification-preferences`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.getAuthToken(),
        },
      });

      if (response.ok) {
        const data = await response.json();
        return data.emailNotificationsEnabled || false;
      }
      
      return false;
    } catch (error) {
      console.warn('⚠️ [USER SERVICE] Error obteniendo preferencia:', error);
      return false;
    }
  }

  /**
   * Fallback: Actualizar perfil en localStorage
   */
  private updateUserProfileInLocalStorage(username: string, updates: Partial<UserProfile>): boolean {
    try {
      const storedUsers = localStorage.getItem('smart-student-users');
      if (storedUsers) {
        const users = JSON.parse(storedUsers);
        const userIndex = users.findIndex((u: any) => u.username === username);
        
        if (userIndex !== -1) {
          users[userIndex] = { ...users[userIndex], ...updates };
          localStorage.setItem('smart-student-users', JSON.stringify(users));
          console.log('📦 [USER SERVICE] Perfil actualizado en localStorage');
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('❌ [USER SERVICE] Error actualizando localStorage:', error);
      return false;
    }
  }
}

// Exportar instancia singleton
export const userService = UserService.getInstance();
