// Sistema de notificaciones para tareas
export interface TaskNotification {
  id: string;
  type: 'new_task' | 'task_submission' | 'task_completed' | 'teacher_comment' | 'grade_received' | 'pending_grading' | 'evaluation_completed';
  taskId: string;
  taskTitle: string;
  targetUserRole: 'student' | 'teacher';
  targetUsernames: string[]; // usuarios específicos que deben recibir la notificación
  fromUsername: string;
  fromDisplayName: string;
  teacherName?: string; // Nombre del profesor para mostrar en las notificaciones
  course: string;
  subject: string;
  timestamp: string;
  read: boolean;
  readBy: string[]; // usuarios que han marcado como leída
  grade?: number; // Para notificaciones de calificación
  taskType?: 'assignment' | 'evaluation'; // Tipo de tarea
}

// Funciones para manejar notificaciones de tareas
export class TaskNotificationManager {
  private static STORAGE_KEY = 'smart-student-task-notifications';

  // Obtener todas las notificaciones
  static getNotifications(): TaskNotification[] {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  }

  // Guardar notificaciones
  static saveNotifications(notifications: TaskNotification[]): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(notifications));
    // Disparar evento personalizado para actualizar la UI en tiempo real
    window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
  }

  // Crear notificación cuando un profesor crea una nueva tarea
  static createNewTaskNotifications(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    teacherUsername: string,
    teacherDisplayName: string,
    taskType: 'assignment' | 'evaluation' = 'assignment'
  ): void {
    console.log('=== DEBUG createNewTaskNotifications ===');
    console.log('TaskId:', taskId);
    console.log('Course:', course);
    
    // 🔧 CORRECCIÓN: Obtener la tarea para verificar asignaciones específicas
    const tasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
    const currentTask = tasks.find((task: any) => task.id === taskId);
    
    let targetStudents: Array<{username: string, displayName: string}> = [];
    
    if (currentTask && currentTask.assignedTo === 'student' && currentTask.assignedStudentIds) {
      // 🎯 Tarea asignada a estudiantes específicos
      console.log('📋 Tarea asignada a estudiantes específicos:', currentTask.assignedStudentIds);
      
      // Obtener datos de usuarios para convertir IDs a usernames
      const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
      
      targetStudents = currentTask.assignedStudentIds
        .map((studentId: string) => {
          const user = users.find((u: any) => u.id === studentId);
          if (user && user.role === 'student') {
            return {
              username: user.username,
              displayName: user.displayName || user.username
            };
          }
          return null;
        })
        .filter((student: any) => student !== null);
      
      console.log('🎯 Estudiantes específicos encontrados:', targetStudents);
    } else {
      // 📚 Tarea asignada a todo el curso
      console.log('📚 Tarea asignada a todo el curso');
      targetStudents = this.getStudentsInCourse(course);
      console.log('Students found in course:', targetStudents);
    }
    
    if (targetStudents.length === 0) {
      console.log('No target students found, skipping notification creation');
      return;
    }

    const notifications = this.getNotifications();
    console.log('Current notifications count:', notifications.length);
    
    const newNotification: TaskNotification = {
      id: `new_task_${taskId}_${Date.now()}`,
      type: 'new_task',
      taskId,
      taskTitle,
      targetUserRole: 'student',
      targetUsernames: targetStudents.map(student => student.username),
      fromUsername: teacherUsername,
      fromDisplayName: teacherDisplayName,
      teacherName: teacherDisplayName,
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: [],
      taskType // 🔥 AGREGADO: Incluir el tipo de tarea
    };

    notifications.push(newNotification);
    console.log('New notification created:', newNotification);
    console.log('Target usernames:', newNotification.targetUsernames);
    console.log('Total notifications after creation:', notifications.length);
    
    this.saveNotifications(notifications);
    console.log('Notifications saved to localStorage');
    
    // Disparar evento para actualizar la UI
    window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
  }

  // Crear notificación pendiente para el profesor cuando crea una tarea/evaluación
  static createPendingGradingNotification(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    teacherUsername: string,
    teacherDisplayName: string,
    taskType: 'assignment' | 'evaluation' = 'assignment'
  ): void {
    console.log('=== DEBUG createPendingGradingNotification ===');
    console.log('Creating pending grading notification for teacher:', teacherUsername);
    
    const notifications = this.getNotifications();
    
    const newNotification: TaskNotification = {
      id: `pending_grading_${taskId}_${Date.now()}`,
      type: 'pending_grading',
      taskId,
      taskTitle,
      targetUserRole: 'teacher',
      targetUsernames: [teacherUsername],
      fromUsername: 'system', // ✅ CORREGIDO: Usar 'system' para notificaciones del sistema
      fromDisplayName: `${taskTitle} (${course})`, // ✅ CORRECCIÓN: Usar título de evaluación y curso
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: [],
      taskType
    };

    notifications.push(newNotification);
    console.log('Pending grading notification created:', newNotification);
    
    this.saveNotifications(notifications);
    console.log('Pending grading notification saved');
  }



  // Función helper para obtener nombre del curso
  static getCourseNameById(courseId: string): string {
    try {
      const coursesText = localStorage.getItem('smart-student-courses');
      const sectionsText = localStorage.getItem('smart-student-sections');
      
      if (!coursesText) {
        console.warn('[getCourseNameById] No courses found in localStorage');
        return courseId;
      }
      
      const courses = JSON.parse(coursesText);
      const sections = sectionsText ? JSON.parse(sectionsText) : [];
      
      // 🔧 CORRECCIÓN: Manejar IDs compuestos (curso-seccion)
      if (courseId && courseId.includes('-')) {
        const parts = courseId.split('-');
        if (parts.length >= 10) { // Dos UUIDs completos
          // Reconstruir los UUIDs correctos
          const cursoId = parts.slice(0, 5).join('-'); // Primer UUID completo
          const seccionId = parts.slice(5, 10).join('-'); // Segundo UUID completo
          
          console.log(`[getCourseNameById] Parsing compound ID: ${courseId}`);
          console.log(`[getCourseNameById] Curso ID: ${cursoId}`);
          console.log(`[getCourseNameById] Sección ID: ${seccionId}`);
          
          // Buscar curso y sección
          const curso = courses.find((c: any) => c.id === cursoId);
          const seccion = sections.find((s: any) => s.id === seccionId);
          
          if (curso && seccion) {
            const displayName = `${curso.name} ${seccion.name}`;
            console.log(`[getCourseNameById] Found compound: ${displayName}`);
            return displayName;
          }
          
          if (curso) {
            console.log(`[getCourseNameById] Found curso only from compound: ${curso.name}`);
            return curso.name;
          }
          
          console.warn(`[getCourseNameById] Curso/Sección not found for IDs: ${cursoId}/${seccionId}`);
        }
      }
      
      // 🔧 Buscar curso directamente si no es ID compuesto
      const course = courses.find((c: any) => c.id === courseId);
      if (course) {
        // 🆕 MEJORA: Buscar sección relacionada para el curso encontrado
        const relatedSection = sections.find((s: any) => 
          s.courseId === courseId || 
          s.course === courseId ||
          s.relatedCourse === courseId
        );
        
        if (relatedSection) {
          const displayName = `${course.name} ${relatedSection.name}`;
          console.log(`[getCourseNameById] Found course + related section: ${displayName}`);
          return displayName;
        }
        
        console.log(`[getCourseNameById] Found direct course: ${course.name}`);
        return course.name;
      }
      
      console.warn(`[getCourseNameById] Course not found for ID: ${courseId}`);
      return 'Curso no encontrado';
      
    } catch (error) {
      console.error('[getCourseNameById] Error:', error);
      return courseId;
    }
  }

  // Crear notificación cuando un profesor comenta en una tarea
  static createTeacherCommentNotifications(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    teacherUsername: string,
    teacherDisplayName: string,
    commentText: string
  ): void {
    console.log(`🔔 [createTeacherCommentNotifications] Iniciando para tarea "${taskTitle}" en curso "${course}"`);
    
    // 🚨 VALIDACIÓN CRÍTICA: Verificar que el courseId es válido para notificaciones precisas
    const courseData = this.getCourseDataFromCombinedId(course);
    if (!courseData) {
      console.error(`❌ [createTeacherCommentNotifications] No se puede crear notificación - courseId inválido: "${course}"`);
      console.error(`❌ [createTeacherCommentNotifications] Las notificaciones requieren IDs de curso válidos con sección específica`);
      return;
    }
    
    console.log(`✅ [createTeacherCommentNotifications] Curso válido - CourseId: ${courseData.courseId}, SectionId: ${courseData.sectionId}`);
    
    const studentsInCourse = this.getStudentsInCourse(course);
    
    if (studentsInCourse.length === 0) {
      console.warn(`⚠️ [createTeacherCommentNotifications] No se encontraron estudiantes en el curso "${course}"`);
      return;
    }

    console.log(`📊 [createTeacherCommentNotifications] Estudiantes encontrados en curso: ${studentsInCourse.length}`);

    // ✅ CORRECCIÓN REFORZADA: Filtrar solo estudiantes y excluir profesores
    const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
    const targetUsernames = studentsInCourse
      .map(student => student.username)
      .filter(username => {
        // Excluir al profesor que hace el comentario
        if (username === teacherUsername) {
          console.log(`[createTeacherCommentNotifications] ⚠️ Excluyendo profesor que comenta: ${username}`);
          return false;
        }
        
        // 🔥 NUEVA VALIDACIÓN: Verificar que el destinatario sea realmente un estudiante
        const targetUser = users.find((u: any) => u.username === username);
        if (!targetUser || targetUser.role !== 'student') {
          console.log(`[createTeacherCommentNotifications] ⚠️ Excluyendo destinatario no estudiante: ${username} (role: ${targetUser?.role || 'not found'})`);
          return false;
        }
        
        return true;
      });

    console.log(`[createTeacherCommentNotifications] Profesor: ${teacherUsername}, Destinatarios validados: ${targetUsernames.join(', ')}`);

    // ✅ VALIDACIÓN ADICIONAL: Usar función de validación específica
    if (!this.shouldCreateTeacherCommentNotification(teacherUsername, targetUsernames)) {
      console.log(`[createTeacherCommentNotifications] ⚠️ Validación adicional falló para profesor ${teacherUsername}`);
      return;
    }

    // ✅ VALIDACIÓN: Solo crear notificación si hay destinatarios válidos
    if (targetUsernames.length === 0) {
      console.log(`[createTeacherCommentNotifications] ⚠️ No hay destinatarios válidos para la notificación`);
      return;
    }

    const notifications = this.getNotifications();
    
    const newNotification: TaskNotification = {
      id: `teacher_comment_${taskId}_${Date.now()}`,
      type: 'teacher_comment',
      taskId,
      taskTitle,
      targetUserRole: 'student',
      targetUsernames, // ✅ Ya filtrado para excluir al profesor
      fromUsername: teacherUsername,
      fromDisplayName: teacherDisplayName,
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: []
    };

    console.log(`[createTeacherCommentNotifications] ✅ Creando notificación válida:`, {
      id: newNotification.id,
      fromUsername: newNotification.fromUsername,
      targetUsernames: newNotification.targetUsernames,
      taskTitle: newNotification.taskTitle,
      course: newNotification.course
    });

    notifications.push(newNotification);
    this.saveNotifications(notifications);
  }

  // Crear notificación cuando un estudiante entrega una tarea
  static createTaskSubmissionNotification(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    studentUsername: string,
    studentDisplayName: string,
    teacherUsername: string
  ): void {
    console.log('🔔 createTaskSubmissionNotification - Iniciando creación de notificación de entrega');
    console.log('📝 Datos:', { taskId, taskTitle, studentUsername, teacherUsername });
    
    const notifications = this.getNotifications();
    console.log('📋 Notificaciones actuales antes de agregar:', notifications.length);
    
    const newNotification: TaskNotification = {
      id: `submission_${taskId}_${studentUsername}_${Date.now()}`,
      type: 'task_submission',
      taskId,
      taskTitle,
      targetUserRole: 'teacher',
      targetUsernames: [teacherUsername],
      fromUsername: studentUsername,
      fromDisplayName: studentDisplayName,
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: []
    };

    notifications.push(newNotification);
    this.saveNotifications(notifications);
    
    console.log('✅ Notificación de entrega creada:', newNotification.id);
    console.log('📋 Total notificaciones después:', notifications.length);
    
    // 🔥 NUEVO: Disparar evento para actualizar notificaciones en tiempo real
    window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', {
      detail: { 
        type: 'task_submission',
        taskId,
        studentUsername,
        teacherUsername,
        timestamp: newNotification.timestamp
      }
    }));
    
    console.log('🚀 Evento taskNotificationsUpdated disparado para actualizar la campana del profesor');
  }

  // Crear notificación cuando una tarea se completa (todos los estudiantes entregaron)
  static createTaskCompletedNotification(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    teacherUsername: string,
    taskType: 'assignment' | 'evaluation' = 'assignment'
  ): void {
    console.log(`🚀 createTaskCompletedNotification: Iniciando para taskId=${taskId}, teacher=${teacherUsername}`);
    
    // 🔧 USAR FUNCIÓN CENTRALIZADA para verificar duplicados
    if (this.hasExistingTaskCompletedNotification(taskId, teacherUsername)) {
      console.log(`⚠️ [PROTECTED] Ya existe notificación task_completed para taskId: ${taskId}, teacher: ${teacherUsername}`);
      return; // No crear nueva notificación
    }
    
    const notifications = this.getNotifications();
    
    // 🔧 MEJORA: ID más específico para evitar colisiones de timing
    const newNotification: TaskNotification = {
      id: `completed_${taskId}_${teacherUsername}_${Date.now()}`,
      type: 'task_completed',
      taskId,
      taskTitle,
      targetUserRole: 'teacher',
      targetUsernames: [teacherUsername],
      fromUsername: 'system',
      fromDisplayName: 'Sistema',
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: [],
      taskType
    };

    notifications.push(newNotification);
    this.saveNotifications(notifications);
    
    console.log(`📢 Notificación de tarea completa creada para profesor: ${teacherUsername}`);
    console.log(`🎯 Notificación creada:`, {
      id: newNotification.id,
      type: newNotification.type,
      taskId: newNotification.taskId,
      taskTitle: newNotification.taskTitle,
      targetUsernames: newNotification.targetUsernames,
      taskType: newNotification.taskType,
      course: newNotification.course,
      subject: newNotification.subject,
      timestamp: newNotification.timestamp
    });
    
    console.log(`✅ Proceso de creación de notificación completado exitosamente`);
    
    // Disparar evento para actualizar la UI
    window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
  }

  // 🔧 NUEVA FUNCIÓN: Limpiar notificaciones duplicadas de tareas completadas
  static cleanupDuplicateTaskCompletedNotifications(): number {
    try {
      const notifications = this.getNotifications();
      let cleanedCount = 0;
      
      console.log(`🧹 [CLEANUP] Iniciando limpieza de notificaciones task_completed duplicadas...`);
      
      // Agrupar notificaciones task_completed por taskId y targetUsername
      const taskCompletedGroups: { [key: string]: TaskNotification[] } = {};
      
      notifications.forEach(notification => {
        if (notification.type === 'task_completed') {
          const key = `${notification.taskId}_${notification.targetUsernames[0]}`;
          if (!taskCompletedGroups[key]) {
            taskCompletedGroups[key] = [];
          }
          taskCompletedGroups[key].push(notification);
        }
      });
      
      // Identificar y limpiar duplicados
      const notificationsToKeep: TaskNotification[] = [];
      const notificationsToRemove: string[] = [];
      
      Object.entries(taskCompletedGroups).forEach(([key, groupNotifications]) => {
        if (groupNotifications.length > 1) {
          console.log(`🔍 [CLEANUP] Encontrados ${groupNotifications.length} duplicados para ${key}`);
          
          // Mantener la más antigua (primera), eliminar el resto
          const sorted = groupNotifications.sort((a, b) => 
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          
          notificationsToKeep.push(sorted[0]);
          sorted.slice(1).forEach(duplicate => {
            notificationsToRemove.push(duplicate.id);
            cleanedCount++;
          });
          
          console.log(`✅ [CLEANUP] Manteniendo: ${sorted[0].id}, eliminando: ${sorted.slice(1).map(n => n.id).join(', ')}`);
        } else {
          notificationsToKeep.push(groupNotifications[0]);
        }
      });
      
      if (cleanedCount > 0) {
        // Filtrar notificaciones eliminando los duplicados
        const cleanedNotifications = notifications.filter(n => 
          n.type !== 'task_completed' || !notificationsToRemove.includes(n.id)
        );
        
        this.saveNotifications(cleanedNotifications);
        console.log(`✅ [CLEANUP] ${cleanedCount} notificaciones duplicadas eliminadas`);
        
        // Disparar evento para actualizar la UI
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
      } else {
        console.log(`ℹ️ [CLEANUP] No se encontraron duplicados de task_completed`);
      }
      
      return cleanedCount;
    } catch (error) {
      console.error(`❌ [CLEANUP] Error limpiando duplicados:`, error);
      return 0;
    }
  }

  // 🔧 FUNCIÓN CENTRALIZADA: Verificar si ya existe notificación task_completed para una tarea
  private static hasExistingTaskCompletedNotification(
    taskId: string,
    teacherUsername: string,
    fromUsername?: string
  ): boolean {
    const notifications = this.getNotifications();
    
    // Buscar cualquier notificación task_completed para esta tarea y profesor
    const existingNotifications = notifications.filter(n => 
      n.type === 'task_completed' && 
      n.taskId === taskId &&
      n.targetUsernames.includes(teacherUsername)
    );
    
    if (existingNotifications.length === 0) {
      return false; // No hay notificaciones existentes
    }
    
    console.log(`🔍 [DUPLICATE_CHECK] Encontradas ${existingNotifications.length} notificaciones task_completed para tarea ${taskId}`);
    
    // Si hay más de una notificación, hay duplicados - limpiar
    if (existingNotifications.length > 1) {
      console.log(`🧹 [DUPLICATE_CHECK] Limpiando ${existingNotifications.length - 1} duplicados automáticamente...`);
      
      // Mantener solo la primera (más antigua)
      const toKeep = existingNotifications.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )[0];
      
      const toRemove = existingNotifications.filter(n => n.id !== toKeep.id);
      
      const cleanedNotifications = notifications.filter(n => 
        !toRemove.some(duplicate => duplicate.id === n.id)
      );
      
      this.saveNotifications(cleanedNotifications);
      console.log(`✅ [DUPLICATE_CHECK] ${toRemove.length} duplicados eliminados, mantenida: ${toKeep.id}`);
      
      // Disparar evento para actualizar la UI
      window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
    }
    
    // Si se especifica fromUsername, verificar si ya existe una notificación de ese usuario específico
    if (fromUsername) {
      const fromThisUser = existingNotifications.find(n => n.fromUsername === fromUsername);
      if (fromThisUser) {
        console.log(`⚠️ [DUPLICATE_CHECK] Ya existe notificación de ${fromUsername} para tarea ${taskId}: ${fromThisUser.id}`);
        return true;
      }
    }
    
    return existingNotifications.length > 0;
  }

  // Verificar si todos los estudiantes de un curso han entregado una tarea específica
  static checkAllStudentsSubmitted(
    taskId: string,
    course: string,
    comments?: any[]
  ): boolean {
    console.log('=== DEBUG checkAllStudentsSubmitted ===');
    console.log('TaskId:', taskId);
    console.log('Course:', course);
    
    // 🔧 USAR LA MISMA LÓGICA CORREGIDA QUE getStudentsInCourse
    const studentsInCourse = this.getStudentsInCourse(course);
    console.log('Students in course:', studentsInCourse);
    
    if (studentsInCourse.length === 0) {
      console.log('No students in course, marking as submitted');
      return true;
    }
    
    const allComments = comments || JSON.parse(localStorage.getItem('smart-student-task-comments') || '[]');
    console.log('All comments:', allComments);
    
    // Obtener todas las entregas para esta tarea
    const submissions = allComments.filter((comment: any) => 
      comment.taskId === taskId && comment.isSubmission
    );
    
    console.log('Submissions for this task:', submissions);
    
    // Verificar si cada estudiante del curso ha entregado
    const studentsWhoSubmitted = submissions.map((sub: any) => sub.studentUsername);
    const allStudentUsernames = studentsInCourse.map((student: any) => student.username);
    
    console.log('Students who submitted:', studentsWhoSubmitted);
    console.log('All student usernames in course:', allStudentUsernames);
    console.log('Total students in course:', allStudentUsernames.length);
    console.log('Total submissions:', studentsWhoSubmitted.length);
    
    // Todos los estudiantes han entregado si cada estudiante está en la lista de entregas
    const allSubmitted = allStudentUsernames.every((username: string) => 
      studentsWhoSubmitted.includes(username)
    );
    
    console.log('All students submitted?', allSubmitted);
    console.log('=== END DEBUG ===');
    
    return allSubmitted;
  }

  // Marcar una notificación como leída por un usuario específico
  static markAsReadByUser(notificationId: string, username: string): void {
    const notifications = this.getNotifications();
    const notification = notifications.find(n => n.id === notificationId);
    
    if (notification && !notification.readBy.includes(username)) {
      notification.readBy.push(username);
      // Si todos los usuarios objetivo han leído la notificación, marcarla como completamente leída
      if (notification.readBy.length >= notification.targetUsernames.length) {
        notification.read = true;
      }
      this.saveNotifications(notifications);
    }
  }

  // Ya no se marca automáticamente como leída la notificación de nueva tarea al entregar.
  // La notificación solo desaparecerá cuando la tarea esté en estado finalizada para el estudiante.


  // Ya no se eliminan automáticamente las notificaciones de evaluación al completar.
  // Permanecen hasta que la tarea/evaluación esté finalizada para el estudiante.

  // Verificar si un estudiante completó una evaluación específica
  static isEvaluationCompletedByStudent(taskId: string, studentUsername: string): boolean {
    try {
      console.log(`[isEvaluationCompletedByStudent] Checking completion for task ${taskId} by student ${studentUsername}`);
      
      // 🔧 CORREGIDO: Los resultados se almacenan como array, no como objeto
      const evaluationResultsArray = JSON.parse(localStorage.getItem('smart-student-evaluation-results') || '[]');
      console.log(`[isEvaluationCompletedByStudent] 📊 Found ${evaluationResultsArray.length} total evaluation results in localStorage`);
      
      // Buscar resultado específico para este estudiante y tarea  
      const studentResult = evaluationResultsArray.find((result: any) => 
        result.taskId === taskId && result.studentUsername === studentUsername
      );
      
      if (studentResult) {
        const isCompleted = studentResult.percentage !== undefined && studentResult.completedAt;
        console.log(`[isEvaluationCompletedByStudent] ✅ Found evaluation result for ${studentUsername} on task ${taskId}: completed=${isCompleted}, percentage=${studentResult.percentage}%`);
        return true;
      }
      
      // Método adicional: verificar en userTasks por si acaso
      const userTasksKey = `userTasks_${studentUsername}`;
      const userTasks = JSON.parse(localStorage.getItem(userTasksKey) || '[]');
      const task = userTasks.find((t: any) => t.id === taskId);
      const isCompletedInUserTasks = task && task.status === 'completed';
      
      if (isCompletedInUserTasks) {
        console.log(`[isEvaluationCompletedByStudent] ✅ Found completed status in userTasks for ${studentUsername} on task ${taskId}`);
        return true;
      }
      
      console.log(`[isEvaluationCompletedByStudent] ❌ No completion found for ${studentUsername} on task ${taskId}`);
      
      // 🔍 LOG DE DEBUG: Mostrar resultados disponibles
      const availableResults = evaluationResultsArray.map((r: any) => 
        `${r.studentUsername}:${r.taskId}(${r.percentage}%)`
      ).join(', ');
      console.log(`[isEvaluationCompletedByStudent] Available student results: [${availableResults}]`);
      
      return false;
    } catch (error) {
      console.error('Error checking evaluation completion:', error);
      return false;
    }
  }

  // 🔧 NUEVA FUNCIÓN: Verificar si una tarea de asignación ya fue calificada para un estudiante específico
  static isTaskAlreadyGraded(taskId: string, studentUsername: string): boolean {
    try {
      console.log(`[isTaskAlreadyGraded] Checking if assignment ${taskId} is already graded for student ${studentUsername}`);
      
      const comments = JSON.parse(localStorage.getItem('smart-student-task-comments') || '[]');
      console.log(`[isTaskAlreadyGraded] 📊 Found ${comments.length} total comments in localStorage`);
      
      // Buscar la entrega del estudiante específico
      const submission = comments.find((comment: any) =>
        comment.taskId === taskId &&
        comment.studentUsername === studentUsername &&
        comment.isSubmission === true
      );
      
      if (!submission) {
        console.log(`[isTaskAlreadyGraded] ❌ No submission found for ${studentUsername} on task ${taskId}`);
        return false;
      }
      
      // Verificar si tiene calificación
      const isGraded = submission.grade !== null && submission.grade !== undefined;
      console.log(`[isTaskAlreadyGraded] ${isGraded ? '✅' : '❌'} Assignment ${taskId} grading status for ${studentUsername}: ${isGraded ? 'GRADED' : 'NOT GRADED'} (grade: ${submission.grade})`);
      
      return isGraded;
    } catch (error) {
      console.error('Error checking task grading status:', error);
      return false;
    }
  }

  // Obtener notificaciones no leídas para un usuario específico
  static getUnreadNotificationsForUser(username: string, userRole: 'student' | 'teacher', userId?: string): TaskNotification[] {
    const notifications = this.getNotifications();
    
    console.log(`[TaskNotificationManager] getUnreadNotificationsForUser: ${username} (${userRole}) with ID: ${userId}`);
    console.log(`[TaskNotificationManager] Total notifications in storage: ${notifications.length}`);
    
    const filtered = notifications.filter(notification => {
      console.log(`[TaskNotificationManager] Checking notification: ${notification.type} from ${notification.fromUsername} to ${notification.targetUsernames.join(',')} (role: ${notification.targetUserRole})`);
      
      // 🔥 FILTRO MEJORADO: Verificar tanto username como userId
      const isTargetUser = notification.targetUsernames.includes(username) || 
                          (userId && notification.targetUsernames.includes(userId));
      
      console.log(`[TaskNotificationManager] 🎯 Target check - Username: ${notification.targetUsernames.includes(username)}, UserID: ${userId && notification.targetUsernames.includes(userId)}, Final: ${isTargetUser}`);
      
      // Filtros básicos
      let basicFilters = notification.targetUserRole === userRole &&
        isTargetUser &&
        !notification.readBy.includes(username) && 
        !notification.readBy.includes(userId || '');

      // 🔥 CORRECCIÓN ESPECÍFICA PARA PROFESORES: Evitar notificaciones cruzadas entre profesores
      if (userRole === 'teacher') {
        // 🚨 PROTECCIÓN PRINCIPAL: Los profesores NUNCA deben ver comentarios de otros profesores
        if (notification.type === 'teacher_comment') {
          // Excluir TODOS los comentarios que no sean dirigidos específicamente a estudiantes
          const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
          const fromUser = users.find((u: any) => u.username === notification.fromUsername);
          
          // Si el comentario es de un profesor (incluido él mismo), NO mostrarlo a profesores
          if (fromUser && fromUser.role === 'teacher') {
            basicFilters = false;
            console.log(`[TaskNotificationManager] ❌ BLOQUEANDO comentario de profesor ${notification.fromUsername} para profesor ${username}`);
            return false; // Retorno inmediato para mayor claridad
          }
        }
        // Permitir todas las demás notificaciones (task_submission, pending_grading, etc.)
      } else {
        // Para estudiantes: mantener la lógica original (excluir notificaciones propias excepto del sistema)
        basicFilters = basicFilters && (notification.fromUsername !== username || notification.fromUsername === 'system');
      }

      console.log(`[TaskNotificationManager] Basic filters for ${userRole} ${username}: ${basicFilters} (type: ${notification.type}, from: ${notification.fromUsername})`);

      if (!basicFilters) return false;

      // 🎯 NUEVO FILTRO DE PRIVACIDAD: Verificar asignación de estudiante a tarea específica
      if (userRole === 'student' && notification.taskId) {
        const isAssignedToTask = this.checkStudentAssignmentToTask(notification.taskId, userId || '', username);
        if (!isAssignedToTask) {
          console.log(`🚫 [TaskNotificationManager] Estudiante ${username} NO asignado a tarea ${notification.taskTitle} - Filtrando notificación`);
          return false;
        }
      }

      // 🔧 SOLUCIÓN: Filtrado específico por estudiante para evitar filtrado cruzado
      if (userRole === 'student' && notification.type === 'new_task') {
        // Para tareas de asignación: solo filtrar si EL MISMO estudiante ya entregó y fue calificado
        if (notification.taskType === 'assignment') {
          const isGraded = this.isTaskAlreadyGraded(notification.taskId, username);
          if (isGraded) {
            console.log(`[SOLUTION] Filtering graded assignment only for ${username}: ${notification.taskTitle}`);
            return false;
          }
        }
        
        // Para evaluaciones: solo filtrar si EL MISMO estudiante ya la completó
        if (notification.taskType === 'evaluation') {
          const isCompleted = this.isEvaluationCompletedByStudent(notification.taskId, username);
          if (isCompleted) {
            console.log(`[SOLUTION] Filtering completed evaluation only for ${username}: ${notification.taskTitle}`);
            return false;
          }
        }
      }

      console.log(`[TaskNotificationManager] Notification passed all filters: ${notification.type} - ${notification.taskTitle}`);
      return true;
    });
    
    console.log(`[TaskNotificationManager] Filtered notifications count: ${filtered.length}`);
    return filtered;
  }

  // Contar notificaciones no leídas para un usuario
  static getUnreadCountForUser(username: string, userRole: 'student' | 'teacher', userId?: string): number {
    const unreadNotifications = this.getUnreadNotificationsForUser(username, userRole, userId);
    
    // Para profesores, contar todas las notificaciones incluyendo pending_grading y task_completed
    if (userRole === 'teacher') {
      // 🔥 CORRECCIÓN: Incluir notificaciones de entregas de estudiantes (task_submission) y evaluaciones completadas
      const notificationCount = unreadNotifications.filter(n => 
        n.type === 'pending_grading' || 
        n.type === 'task_completed' || 
        n.type === 'task_submission' ||  // 🔥 NUEVO: Incluir entregas de estudiantes
        n.type === 'evaluation_completed' || // 🔥 NUEVO: Incluir evaluaciones completadas
        n.type === 'teacher_comment'
        // ✅ ELIMINADO: new_task no debería contarse para profesores ya que son notificaciones para estudiantes
      ).length;
      
      console.log(`[TaskNotificationManager] Teacher ${username} has ${notificationCount} notifications (including ${unreadNotifications.filter(n => n.type === 'pending_grading').length} pending_grading, ${unreadNotifications.filter(n => n.type === 'task_completed').length} task_completed, ${unreadNotifications.filter(n => n.type === 'task_submission').length} task_submission, and ${unreadNotifications.filter(n => n.type === 'evaluation_completed').length} evaluation_completed)`);
      
      return notificationCount;
    }
    
    // Para estudiantes, excluir notificaciones de comentarios (teacher_comment)
    // ya que estos se cuentan por separado en unreadCommentsCount para evitar duplicación
    if (userRole === 'student') {
      return unreadNotifications.filter(n => 
        n.type !== 'teacher_comment'
      ).length;
    }
    
    return unreadNotifications.length;
  }

  // Obtener estudiantes en un curso específico
  private static getStudentsInCourse(course: string): Array<{username: string, displayName: string}> {
    console.log(`🔍 [getStudentsInCourse] Searching for students in course: "${course}"`);
    
    // 🔧 USAR LA MISMA LÓGICA QUE EN LA PÁGINA DE TAREAS PARA COMPATIBILIDAD COMPLETA
    const allUsers: any[] = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
    const studentAssignments: any[] = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
    const currentYear = new Date().getFullYear();
    const studentsForYear: any[] = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
    
    console.log(`� [getStudentsInCourse] Total users in system: ${allUsers.length}`);
    console.log(`📋 [getStudentsInCourse] Total student assignments: ${studentAssignments.length}`);
    console.log(`📋 [getStudentsInCourse] Students for year ${currentYear}: ${studentsForYear.length}`);
    
    // 🔧 NUEVA LÓGICA: Usar getCourseDataFromCombinedId para manejar IDs combinados
    const courseData = this.getCourseDataFromCombinedId(course);
    
    if (!courseData) {
      console.error(`❌ [getStudentsInCourse] No se pudo parsear courseId: "${course}"`);
      return [];
    }
    
    const { courseId, sectionId } = courseData;
    console.log(`� [getStudentsInCourse] Parsed course - CourseId: ${courseId}, SectionId: ${sectionId}`);
    
    // 🆕 MÉTODO PRINCIPAL: Usar smart-student-students-{year} que tiene sectionId
    if (studentsForYear.length > 0 && sectionId) {
      let estudiantesEncontrados = studentsForYear.filter((s: any) => 
        String(s.sectionId) === String(sectionId)
      );
      console.log(`🎯 [MÉTODO PRINCIPAL] Estudiantes por sectionId "${sectionId}": ${estudiantesEncontrados.length}`);
      
      // Fallback: buscar por courseId
      if (estudiantesEncontrados.length === 0) {
        estudiantesEncontrados = studentsForYear.filter((s: any) => 
          String(s.courseId) === String(courseId)
        );
        console.log(`🔍 [MÉTODO PRINCIPAL] Fallback por courseId "${courseId}": ${estudiantesEncontrados.length}`);
      }
      
      if (estudiantesEncontrados.length > 0) {
        const resultado = estudiantesEncontrados.map((estudiante: any) => ({
          username: estudiante.username || estudiante.rut || `student-${estudiante.id}`,
          displayName: estudiante.displayName || estudiante.name || estudiante.username || 'Estudiante'
        }));
        
        console.log(`✅ [MÉTODO PRINCIPAL] Encontrados ${resultado.length} estudiantes por students-year`);
        resultado.forEach((e, i) => console.log(`   ${i + 1}. ${e.username} (${e.displayName})`));
        return resultado;
      }
    }
    
    // MÉTODO LEGACY: Obtener estudiantes asignados a este curso y sección específicos
    const assignedStudentIds = studentAssignments
      .filter((assignment: any) => 
        assignment.courseId === courseId && assignment.sectionId === sectionId
      )
      .map((assignment: any) => assignment.studentId);
    
    console.log(`🎯 [MÉTODO LEGACY] Student IDs assigned to course-section: ${assignedStudentIds.length}`, assignedStudentIds);
    
    // Obtener datos completos de los estudiantes asignados
    const studentsInCourse = assignedStudentIds
      .map((studentId: string) => {
        const user = allUsers.find((u: any) => u.id === studentId && u.role === 'student');
        if (user) {
          return {
            username: user.username,
            displayName: user.displayName || user.username
          };
        }
        return null;
      })
      .filter((student: any): student is {username: string, displayName: string} => student !== null);
    
    console.log(`🎯 [MÉTODO LEGACY] Students found in "${course}": ${studentsInCourse.length}`);
    studentsInCourse.forEach((student, index) => {
      console.log(`   ${index + 1}. ${student.username} (${student.displayName})`);
    });
    
    return studentsInCourse;
  }

  // 🔧 NUEVA FUNCIÓN AUXILIAR: Parsear IDs combinados como en la página de tareas
  private static getCourseDataFromCombinedId(combinedId: string): { courseId: string, sectionId: string } | null {
    if (!combinedId) {
      console.warn(`[getCourseDataFromCombinedId] ID vacío`);
      return null;
    }
    
    // 🔧 CORRECCIÓN CRÍTICA: Manejar tanto IDs simples como combinados
    const parts = combinedId.split('-');
    console.log(`[getCourseDataFromCombinedId] Split parts: ${parts.length}`, parts);
    
    if (parts.length >= 10) {
      // ID combinado (courseId-sectionId) - formato correcto y preferido
      const courseId = parts.slice(0, 5).join('-');
      const sectionId = parts.slice(5, 10).join('-');
      
      console.log(`[getCourseDataFromCombinedId] ✅ ID combinado detectado`);
      console.log(`   -> courseId: "${courseId}"`);
      console.log(`   -> sectionId: "${sectionId}"`);
      
      return { courseId, sectionId };
    } else if (parts.length === 5) {
      // ID simple (solo courseId) - PROBLEMA POTENCIAL
      console.log(`[getCourseDataFromCombinedId] ⚠️ ID simple detectado: "${combinedId}"`);
      console.warn(`[getCourseDataFromCombinedId] ⚠️ ID simple puede causar notificaciones incorrectas`);
      
      // 🆕 MÉTODO PRINCIPAL: Buscar en students-year primero
      const currentYear = new Date().getFullYear();
      const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
      
      if (studentsForYear.length > 0) {
        // Buscar secciones únicas para este courseId en students-year
        const studentsWithCourse = studentsForYear.filter((s: any) => 
          String(s.courseId) === String(combinedId)
        );
        
        if (studentsWithCourse.length > 0) {
          const uniqueSections = [...new Set(studentsWithCourse.map((s: any) => s.sectionId).filter(Boolean))];
          
          if (uniqueSections.length === 1) {
            const sectionId = uniqueSections[0] as string;
            console.log(`[getCourseDataFromCombinedId] ✅ [STUDENTS-YEAR] Solo una sección encontrada: "${sectionId}"`);
            return { courseId: combinedId, sectionId };
          } else if (uniqueSections.length > 1) {
            console.warn(`[getCourseDataFromCombinedId] ⚠️ Múltiples secciones en students-year: ${uniqueSections.join(', ')}`);
            // Usar la primera sección (puede no ser ideal pero permite continuar)
            const sectionId = uniqueSections[0] as string;
            return { courseId: combinedId, sectionId };
          }
        }
      }
      
      // MÉTODO LEGACY: Buscar en student-assignments
      const studentAssignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
      const assignmentsForCourse = studentAssignments.filter((assignment: any) => assignment.courseId === combinedId);
      
      if (assignmentsForCourse.length === 0) {
        console.error(`[getCourseDataFromCombinedId] ❌ No se encontraron asignaciones para courseId: "${combinedId}"`);
        return null;
      }
      
      // Verificar si todas las asignaciones son para la MISMA sección
      const uniqueSections = [...new Set(assignmentsForCourse.map((assignment: any) => assignment.sectionId))];
      
      if (uniqueSections.length === 1) {
        // ✅ Solo hay una sección para este curso, es seguro proceder
        const sectionId = uniqueSections[0] as string;
        console.log(`[getCourseDataFromCombinedId] ✅ Solo una sección encontrada: "${sectionId}"`);
        return { courseId: combinedId, sectionId };
      } else {
        // ❌ Múltiples secciones - no podemos determinar cuál usar
        console.error(`[getCourseDataFromCombinedId] ❌ Múltiples secciones para curso "${combinedId}": ${uniqueSections.length}`);
        console.error(`[getCourseDataFromCombinedId] Secciones: ${uniqueSections.join(', ')}`);
        console.error(`[getCourseDataFromCombinedId] No se puede crear notificación sin sección específica`);
        return null;
      }
    } else {
      console.error(`[getCourseDataFromCombinedId] ❌ Formato de ID inesperado. Partes: ${parts.length}, esperado 5 o 10+`);
      console.log(`[getCourseDataFromCombinedId] ID recibido: "${combinedId}"`);
      return null;
    }
  }

  // Crear notificación cuando un profesor califica una tarea
  static createGradeNotification(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    studentUsername: string,
    teacherUsername: string,
    teacherDisplayName: string,
    grade: number
  ): void {
    const notifications = this.getNotifications();
    
    const newNotification: TaskNotification = {
      id: `grade_${taskId}_${studentUsername}_${Date.now()}`,
      type: 'grade_received',
      taskId,
      taskTitle,
      targetUserRole: 'student',
      targetUsernames: [studentUsername],
      fromUsername: teacherUsername,
      fromDisplayName: teacherDisplayName,
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: [],
      grade
    };

    notifications.push(newNotification);
    this.saveNotifications(notifications);
    
    console.log(`[TaskNotificationManager] Created grade notification for student ${studentUsername}: ${grade}% on task "${taskTitle}"`);
  }

  // Marcar notificaciones de calificación como leídas cuando el estudiante entra a la pestaña de tareas
  static markGradeNotificationsAsReadOnTasksView(studentUsername: string): void {
    const notifications = this.getNotifications();
    let updated = false;
    
    const updatedNotifications = notifications.map(notification => {
      if (
        notification.type === 'grade_received' &&
        notification.targetUsernames.includes(studentUsername) &&
        !notification.readBy.includes(studentUsername)
      ) {
        updated = true;
        return {
          ...notification,
          readBy: [...notification.readBy, studentUsername],
          read: notification.readBy.length + 1 >= notification.targetUsernames.length
        };
      }
      return notification;
    });
    
    if (updated) {
      this.saveNotifications(updatedNotifications);
      console.log(`[TaskNotificationManager] Marked grade notifications as read for student ${studentUsername} on tasks view`);
    }
  }

  // Marcar todas las notificaciones de una tarea específica como leídas cuando el estudiante la revisa
  static markTaskNotificationsAsReadOnReview(taskId: string, studentUsername: string): void {
    const notifications = this.getNotifications();
    let updated = false;
    
    const updatedNotifications = notifications.map(notification => {
      if (
        notification.taskId === taskId &&
        notification.targetUsernames.includes(studentUsername) &&
        !notification.readBy.includes(studentUsername) &&
        // 🔥 MEJORA: Solo marcar como leídos los comentarios y notificaciones de tipo 'teacher_comment'
        // No marcar como leídas las notificaciones de tipo 'new_task' (para mantener las tareas/evaluaciones pendientes)
        (notification.type === 'teacher_comment')
      ) {
        updated = true;
        return {
          ...notification,
          readBy: [...notification.readBy, studentUsername],
          read: notification.readBy.length + 1 >= notification.targetUsernames.length
        };
      }
      return notification;
    });
    
    if (updated) {
      this.saveNotifications(updatedNotifications);
      console.log(`[TaskNotificationManager] Marked all comment notifications for task ${taskId} as read for student ${studentUsername}`);
      
      // 🔥 MEJORA: También marcar comentarios no leídos para esta tarea como leídos
      this.markCommentsAsReadForTask(taskId, studentUsername);
    }
  }

  // 🔥 NUEVA FUNCIÓN: Marcar comentarios de una tarea como leídos
  static markCommentsAsReadForTask(taskId: string, username: string): void {
    try {
      const storedComments = localStorage.getItem('smart-student-task-comments');
      if (!storedComments) return;
      
      const comments = JSON.parse(storedComments);
      let updated = false;
      
      console.log(`[TaskNotificationManager] Marking comments for task ${taskId} as read for ${username}`);
      
      // Marcar TODOS los comentarios de la tarea específica como leídos (no solo los no-submission)
      const updatedComments = comments.map((comment: any) => {
        if (
          comment.taskId === taskId && 
          comment.studentUsername !== username && // No marcar comentarios propios
          (!comment.readBy?.includes(username))
        ) {
          updated = true;
          console.log(`[TaskNotificationManager] Marking comment ${comment.id} as read for ${username}`);
          return {
            ...comment,
            isNew: false,
            readBy: [...(comment.readBy || []), username]
          };
        }
        return comment;
      });
      
      if (updated) {
        localStorage.setItem('smart-student-task-comments', JSON.stringify(updatedComments));
        console.log(`[TaskNotificationManager] ✅ Marked all comments for task ${taskId} as read for ${username}`);
        
        // Ahora también marcamos las notificaciones relacionadas como leídas
        const notifications = this.getNotifications();
        let notificationsUpdated = false;
        
        const updatedNotifications = notifications.map(notification => {
          // Si la notificación es de comentario (comment_added) para la tarea específica
          // y está dirigida al usuario actual, marcarla como leída
          if (
            notification.taskId === taskId && 
            notification.type === 'teacher_comment' &&
            notification.targetUsernames.includes(username) &&
            !notification.readBy.includes(username)
          ) {
            notificationsUpdated = true;
            console.log(`[TaskNotificationManager] Marking notification ${notification.id} as read`);
            return {
              ...notification,
              readBy: [...notification.readBy, username],
              read: notification.targetUsernames.length === 1 ? true : notification.read
            };
          }
          return notification;
        });
        
        if (notificationsUpdated) {
          this.saveNotifications(updatedNotifications);
          console.log(`[TaskNotificationManager] ✅ Marked all comment notifications for task ${taskId} as read by ${username}`);
        }
        
        // Disparar eventos para actualizar la UI
        document.dispatchEvent(new Event('commentsUpdated'));
        
        // 🔥 NUEVA MEJORA: También disparar evento específico para estudiantes
        if (username) {
          window.dispatchEvent(new CustomEvent('studentCommentsUpdated', { 
            detail: { 
              username: username,
              taskId: taskId,
              action: 'marked_as_read_bulk'
            } 
          }));
          
          // 🔥 NUEVA MEJORA: Disparar evento para actualizar dashboard
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('updateDashboardCounts', {
              detail: { userRole: 'student', action: 'task_opened' }
            }));
          }, 100);
        }
      }
    } catch (error) {
      console.error('Error marking task comments as read:', error);
    }
  }

  // Verificar si todos los estudiantes de una tarea han sido evaluados
  static checkAllStudentsGraded(taskId: string, course: string): boolean {
    console.log('=== DEBUG checkAllStudentsGraded ===');
    console.log('TaskId:', taskId, 'Course:', course);
    
    // 🔧 USAR LA MISMA LÓGICA CORREGIDA QUE getStudentsInCourse
    const studentsInCourse = this.getStudentsInCourse(course);
    console.log('Students in course:', studentsInCourse.length);
    
    if (studentsInCourse.length === 0) {
      console.log('No students in course, marking as graded');
      return true;
    }
    
    // Obtener todos los comentarios/entregas
    const allComments = JSON.parse(localStorage.getItem('smart-student-task-comments') || '[]');
    
    // Verificar si cada estudiante tiene una entrega calificada
    const gradedCount = studentsInCourse.filter(student => {
      const submission = allComments.find((comment: any) => 
        comment.taskId === taskId && 
        comment.studentUsername === student.username && 
        comment.isSubmission &&
        comment.grade !== undefined && 
        comment.grade !== null
      );
      
      console.log(`Student ${student.username} - has graded submission:`, !!submission);
      return !!submission;
    }).length;
    
    const allGraded = gradedCount === studentsInCourse.length;
    console.log(`Graded: ${gradedCount}/${studentsInCourse.length} - All graded:`, allGraded);
    
    return allGraded;
  }

  // Eliminar notificación pendiente de calificación cuando todos están evaluados
  static removePendingGradingNotification(taskId: string, teacherUsername: string): void {
    console.log('=== DEBUG removePendingGradingNotification ===');
    console.log('TaskId:', taskId, 'Teacher:', teacherUsername);
    
    const notifications = this.getNotifications();
    const initialCount = notifications.length;
    
    const filteredNotifications = notifications.filter(notification => 
      !(notification.type === 'pending_grading' && 
        notification.taskId === taskId && 
        notification.targetUsernames.includes(teacherUsername))
    );
    
    const removedCount = initialCount - filteredNotifications.length;
    console.log(`Removed ${removedCount} pending grading notifications`);
    
    if (removedCount > 0) {
      this.saveNotifications(filteredNotifications);
      console.log('Pending grading notifications removed and saved');
    }
  }

  // Verificar y actualizar el estado de calificación de una tarea
  static checkAndUpdateGradingStatus(taskId: string, course: string, teacherUsername: string): void {
    console.log('=== DEBUG checkAndUpdateGradingStatus ===');
    
    const allGraded = this.checkAllStudentsGraded(taskId, course);
    
    if (allGraded) {
      console.log('All students graded, removing pending notification');
      this.removePendingGradingNotification(taskId, teacherUsername);
    } else {
      console.log('Not all students graded yet, keeping pending notification');
    }
  }

  // Limpiar notificaciones antiguas (más de 30 días)
  static cleanupOldNotifications(): void {
    const notifications = this.getNotifications();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const filteredNotifications = notifications.filter(notification => 
      new Date(notification.timestamp) > thirtyDaysAgo
    );
    
    if (filteredNotifications.length < notifications.length) {
      this.saveNotifications(filteredNotifications);
    }
  }

  // NUEVA FUNCIÓN: Limpiar notificaciones propias inconsistentes
  static cleanupSelfNotifications(): void {
    console.log('[TaskNotificationManager] Iniciando limpieza de notificaciones propias...');
    const notifications = this.getNotifications();
    let cleaned = 0;
    
    // Filtrar notificaciones donde fromUsername !== targetUsername para cada targetUsername
    const cleanedNotifications = notifications.filter(notification => {
      // Si la notificación es del mismo usuario para él mismo, es inconsistente
      const hasSelfNotification = notification.targetUsernames.includes(notification.fromUsername);
      
      if (hasSelfNotification) {
        console.log(`[TaskNotificationManager] Removiendo notificación propia inconsistente:`, {
          id: notification.id,
          type: notification.type,
          fromUsername: notification.fromUsername,
          targetUsernames: notification.targetUsernames,
          taskTitle: notification.taskTitle
        });
        cleaned++;
        return false; // Remover esta notificación
      }
      
      return true; // Mantener esta notificación
    });
    
    if (cleaned > 0) {
      this.saveNotifications(cleanedNotifications);
      console.log(`[TaskNotificationManager] Limpieza completada: ${cleaned} notificaciones propias removidas`);
    } else {
      console.log('[TaskNotificationManager] No se encontraron notificaciones propias inconsistentes');
    }
  }

  // NUEVA FUNCIÓN: Reparar targetUsernames para excluir fromUsername
  static repairSelfNotifications(): void {
    console.log('[TaskNotificationManager] Iniciando reparación de notificaciones propias...');
    const notifications = this.getNotifications();
    let repaired = 0;
    
    const repairedNotifications = notifications.map(notification => {
      // Si fromUsername está en targetUsernames, removerlo
      if (notification.targetUsernames.includes(notification.fromUsername)) {
        console.log(`[TaskNotificationManager] Reparando notificación:`, {
          id: notification.id,
          type: notification.type,
          fromUsername: notification.fromUsername,
          originalTargets: [...notification.targetUsernames],
          taskTitle: notification.taskTitle
        });
        
        const repairedTargets = notification.targetUsernames.filter(
          username => username !== notification.fromUsername
        );
        
        repaired++;
        return {
          ...notification,
          targetUsernames: repairedTargets
        };
      }
      
      return notification;
    });
    
    if (repaired > 0) {
      this.saveNotifications(repairedNotifications);
      console.log(`[TaskNotificationManager] Reparación completada: ${repaired} notificaciones reparadas`);
    } else {
      console.log('[TaskNotificationManager] No se encontraron notificaciones que reparar');
    }
  }

  // NUEVA FUNCIÓN: Reparar notificaciones del sistema que tienen fromUsername incorrecto
  static repairSystemNotifications(): void {
    console.log('[TaskNotificationManager] Iniciando reparación de notificaciones del sistema...');
    const notifications = this.getNotifications();
    let repaired = 0;
    
    const repairedNotifications = notifications.map(notification => {
      // Reparar notificaciones pending_grading y task_completed que no sean del sistema
      if ((notification.type === 'pending_grading' || notification.type === 'task_completed') && 
          notification.fromUsername !== 'system') {
        console.log(`[TaskNotificationManager] Reparando notificación del sistema:`, {
          id: notification.id,
          type: notification.type,
          originalFromUsername: notification.fromUsername,
          taskTitle: notification.taskTitle
        });
        
        repaired++;
        return {
          ...notification,
          fromUsername: 'system',
          fromDisplayName: `${notification.taskTitle} (${notification.course})`
        };
      }
      
      return notification;
    });
    
    if (repaired > 0) {
      this.saveNotifications(repairedNotifications);
      console.log(`[TaskNotificationManager] Reparación del sistema completada: ${repaired} notificaciones reparadas`);
    } else {
      console.log('[TaskNotificationManager] No se encontraron notificaciones del sistema que reparar');
    }
  }

  // NUEVA FUNCIÓN ESPECÍFICA: Limpiar notificaciones de comentarios propios
  static cleanupOwnCommentNotifications(): void {
    console.log('[TaskNotificationManager] 🧹 Limpiando notificaciones de comentarios propios...');
    const notifications = this.getNotifications();
    let cleaned = 0;
    
    const cleanedNotifications = notifications.filter(notification => {
      // Eliminar notificaciones de teacher_comment donde el profesor es emisor Y receptor
      if (notification.type === 'teacher_comment' && 
          notification.targetUsernames.includes(notification.fromUsername)) {
        console.log(`[TaskNotificationManager] 🗑️ Eliminando notificación de comentario propio:`, {
          id: notification.id,
          type: notification.type,
          fromUsername: notification.fromUsername,
          targetUsernames: notification.targetUsernames,
          taskTitle: notification.taskTitle,
          timestamp: notification.timestamp
        });
        cleaned++;
        return false; // Eliminar esta notificación
      }
      
      return true; // Mantener esta notificación
    });
    
    if (cleaned > 0) {
      this.saveNotifications(cleanedNotifications);
      console.log(`[TaskNotificationManager] ✅ Limpieza completada: ${cleaned} notificaciones de comentarios propios eliminadas`);
    } else {
      console.log('[TaskNotificationManager] ✅ No se encontraron notificaciones de comentarios propios para eliminar');
    }
  }

  // FUNCIÓN ESPECÍFICA: Eliminar notificaciones de comentarios propios de profesores
  static removeTeacherOwnCommentNotifications(): void {
    console.log('[TaskNotificationManager] 🧹 Eliminando notificaciones de comentarios propios de profesores...');
    const notifications = this.getNotifications();
    let removed = 0;
    
    const filteredNotifications = notifications.filter(notification => {
      // Eliminar notificaciones de teacher_comment donde el profesor es emisor Y está en targetUsernames
      if (notification.type === 'teacher_comment' && 
          notification.targetUsernames.includes(notification.fromUsername)) {
        console.log(`[TaskNotificationManager] 🗑️ Eliminando comentario propio de profesor:`, {
          id: notification.id,
          fromUsername: notification.fromUsername,
          targetUsernames: notification.targetUsernames,
          taskTitle: notification.taskTitle,
          timestamp: notification.timestamp
        });
        removed++;
        return false; // Eliminar esta notificación
      }
      
      return true; // Mantener esta notificación
    });
    
    if (removed > 0) {
      this.saveNotifications(filteredNotifications);
      console.log(`[TaskNotificationManager] ✅ Eliminadas ${removed} notificaciones de comentarios propios de profesores`);
      
      // Disparar evento para actualizar la UI
      window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
    } else {
      console.log('[TaskNotificationManager] ✅ No se encontraron notificaciones de comentarios propios de profesores');
    }
  }

  // 🔥 NUEVA FUNCIÓN: Limpiar notificaciones cruzadas entre profesores
  static removeCrossTeacherNotifications(): void {
    console.log('[TaskNotificationManager] 🧹 Eliminando notificaciones cruzadas entre profesores...');
    
    const notifications = this.getNotifications();
    const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
    const teachers = users.filter((u: any) => u.role === 'teacher');
    let cleaned = 0;
    
    const cleanedNotifications = notifications.filter(notification => {
      if (notification.type === 'teacher_comment') {
        // Verificar si el emisor es profesor
        const fromUser = users.find((u: any) => u.username === notification.fromUsername);
        if (fromUser && fromUser.role === 'teacher') {
          
          // 🚨 SOLUCIÓN AGRESIVA: Eliminar TODAS las notificaciones teacher_comment 
          // que tengan profesores en targetUsernames
          const hasTeacherTargets = notification.targetUsernames.some(target => 
            teachers.some((t: any) => t.username === target || t.id === target)
          );
          
          if (hasTeacherTargets) {
            console.log(`[TaskNotificationManager] �️ ELIMINANDO notificación cruzada completa:`, {
              from: notification.fromUsername,
              targets: notification.targetUsernames,
              taskTitle: notification.taskTitle,
              reason: 'Contiene profesores como destinatarios'
            });
            cleaned++;
            return false; // Eliminar completamente
          }
          
          // Verificación adicional: Solo mantener si TODOS los targets son estudiantes
          const allTargetsAreStudents = notification.targetUsernames.every(target => {
            const targetUser = users.find((u: any) => u.username === target || u.id === target);
            return targetUser && targetUser.role === 'student';
          });
          
          if (!allTargetsAreStudents) {
            console.log(`[TaskNotificationManager] 🗑️ ELIMINANDO notificación con targets no válidos:`, {
              from: notification.fromUsername,
              targets: notification.targetUsernames,
              taskTitle: notification.taskTitle,
              reason: 'No todos los destinatarios son estudiantes'
            });
            cleaned++;
            return false; // Eliminar completamente
          }
        }
      }
      return true;
    });
    
    if (cleaned > 0) {
      this.saveNotifications(cleanedNotifications);
      console.log(`[TaskNotificationManager] ✅ ELIMINADAS ${cleaned} notificaciones cruzadas entre profesores`);
      
      // Disparar evento para actualizar la UI
      window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
    } else {
      console.log('[TaskNotificationManager] ✅ No se encontraron notificaciones cruzadas entre profesores');
    }
  }

  // FUNCIÓN ESPECÍFICA: Prevenir creación de notificaciones de comentarios propios
  static shouldCreateTeacherCommentNotification(teacherUsername: string, targetUsernames: string[]): boolean {
    // No crear notificación si el profesor está en la lista de destinatarios
    if (targetUsernames.includes(teacherUsername)) {
      console.log(`[TaskNotificationManager] ⚠️ Previniendo notificación propia para profesor ${teacherUsername}`);
      return false;
    }
    return true;
  }

  // 🔥 NUEVA FUNCIÓN: Crear notificación cuando un estudiante completa una evaluación
  static createEvaluationCompletedNotification(
    taskId: string,
    taskTitle: string,
    course: string,
    subject: string,
    studentUsername: string,
    studentDisplayName: string,
    teacherUsername: string,
    evaluationResults: {
      score: number;
      totalQuestions: number;
      completionPercentage: number;
      completedAt: string;
    }
  ): void {
    console.log('=== DEBUG createEvaluationCompletedNotification ===');
    console.log('Creating evaluation completion notification for teacher:', teacherUsername);
    console.log('Student:', studentUsername, 'Results:', evaluationResults);
    
    const notifications = this.getNotifications();
    
    // 🔧 USAR FUNCIÓN CENTRALIZADA para verificar duplicados - incluir verificación específica por estudiante
    // ✅ VERIFICAR AMBOS TIPOS: task_completed Y evaluation_completed
    const existingTaskCompleted = this.hasExistingTaskCompletedNotification(taskId, teacherUsername, studentUsername);
    const existingEvaluationCompleted = notifications.some(n => 
      n.type === 'evaluation_completed' && 
      n.taskId === taskId &&
      n.targetUsernames.includes(teacherUsername) &&
      n.fromUsername === studentUsername
    );
    
    if (existingTaskCompleted || existingEvaluationCompleted) {
      console.log(`⚠️ [PROTECTED] Ya existe notificación de evaluación completada para taskId: ${taskId}, teacher: ${teacherUsername}, student: ${studentUsername}`);
      return; // No crear nueva notificación
    }
    
    const newNotification: TaskNotification = {
      id: `eval_completed_${taskId}_${studentUsername}_${Date.now()}`,
      type: 'evaluation_completed',
      taskId,
      taskTitle,
      targetUserRole: 'teacher',
      targetUsernames: [teacherUsername],
      fromUsername: studentUsername,
      fromDisplayName: studentDisplayName,
      course,
      subject,
      timestamp: new Date().toISOString(),
      read: false,
      readBy: [],
      taskType: 'evaluation'
      // ✅ CORRECCIÓN CRÍTICA: Cambiar tipo a 'evaluation_completed' para separar de 'task_completed'
    };

    notifications.push(newNotification);
    console.log('Evaluation completion notification created:', newNotification);
    
    this.saveNotifications(notifications);
    console.log('Evaluation completion notification saved for teacher:', teacherUsername);
    
    // Disparar evento para actualizar la UI
    window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
  }

  // 🔧 FUNCIÓN DE MIGRACIÓN: Actualizar notificaciones existentes que muestran "Sistema"
  static migrateSystemNotifications(): void {
    console.log('[TaskNotificationManager] 🔄 Migrando notificaciones que muestran "Sistema"...');
    
    const notifications = this.getNotifications();
    let migrated = 0;
    
    // Obtener tareas para poder acceder a los títulos y cursos
    const globalTasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
    
    const updatedNotifications = notifications.map(notification => {
      if (notification.fromDisplayName === 'Sistema' || notification.fromDisplayName === 'system') {
        // Buscar la tarea correspondiente para obtener el título correcto
        const relatedTask = globalTasks.find((task: any) => task.id === notification.taskId);
        
        if (relatedTask) {
          console.log(`Migrando notificación de "${notification.fromDisplayName}" a "${relatedTask.title} (${relatedTask.course})"`);
          migrated++;
          return {
            ...notification,
            fromDisplayName: `${relatedTask.title} (${relatedTask.course})`
          };
        } else {
          // Si no se encuentra la tarea, usar información de la notificación
          const newDisplayName = `${notification.taskTitle} (${notification.course})`;
          console.log(`Migrando notificación de "${notification.fromDisplayName}" a "${newDisplayName}"`);
          migrated++;
          return {
            ...notification,
            fromDisplayName: newDisplayName
          };
        }
      }
      
      return notification;
    });
    
    if (migrated > 0) {
      this.saveNotifications(updatedNotifications);
      console.log(`[TaskNotificationManager] ✅ ${migrated} notificaciones migradas exitosamente`);
      
      // 🔧 MEJORA: Disparar múltiples eventos para asegurar actualización de UI
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
        window.dispatchEvent(new Event('storage')); // Para componentes que escuchan cambios de localStorage
        // Pequeño delay para asegurar que todos los eventos se propaguen
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('notificationsMigrated', { 
            detail: { migratedCount: migrated } 
          }));
        }, 100);
      }
    } else {
      console.log('[TaskNotificationManager] ℹ️ No se encontraron notificaciones que necesiten migración');
    }
  }

  // Verificar si una tarea está finalizada para un estudiante específico
  static isTaskFinalizedForStudent(taskId: string, studentUsername: string): boolean {
    try {
      // Obtenemos las tareas del estudiante del localStorage
      const userTasksKey = `userTasks_${studentUsername}`;
      const userTasks = JSON.parse(localStorage.getItem(userTasksKey) || '[]');
      
      // Verificamos si la tarea existe y está en estado 'finalizado'
      const task = userTasks.find((t: any) => t.id === taskId);
      return task && task.status === 'finalizado';
    } catch (error) {
      console.error('Error checking task finalization status:', error);
      return false;
    }
  }

  // Actualizar estado de notificación cuando una tarea cambia a finalizada
  static updateTaskStatusNotification(
    taskId: string,
    newStatus: 'pending' | 'submitted' | 'reviewed' | 'delivered',
    teacherUsername: string
  ): void {
    console.log('=== DEBUG updateTaskStatusNotification ===');
    console.log('TaskId:', taskId, 'New Status:', newStatus, 'Teacher:', teacherUsername);
    
    const notifications = this.getNotifications();
    let notificationUpdated = false;
    
    const updatedNotifications = notifications.map(notification => {
      // Buscar la notificación de tarea pendiente para este profesor y tarea
      if (notification.taskId === taskId && 
          notification.type === 'pending_grading' && 
          notification.targetUsernames.includes(teacherUsername)) {
        
        // Si la tarea está finalizada (todos los estudiantes han sido revisados)
        if (newStatus === 'reviewed') {
          // Marcar la notificación como leída/finalizada
          notification.read = true;
          notification.readBy = [...notification.readBy, teacherUsername];
          notification.fromDisplayName = `Tarea Finalizada: ${notification.taskTitle}`;
          notificationUpdated = true;
          console.log('✅ Notification marked as finalized:', notification.id);
        } else {
          // Mantener como pendiente con estado actualizado
          notification.fromDisplayName = `Tarea ${this.getStatusText(newStatus)}: ${notification.taskTitle}`;
          notificationUpdated = true;
          console.log('🔄 Notification status updated:', notification.id);
        }
      }
      return notification;
    });
    
    if (notificationUpdated) {
      this.saveNotifications(updatedNotifications);
      console.log('✅ Task status notification updated successfully');
    }
  }

  // Helper para obtener texto del estado
  static getStatusText(status: string): string {
    switch (status) {
      case 'pending': return 'Pendiente';
      case 'submitted': return 'Entregada';
      case 'delivered': return 'En Revisión';
      case 'reviewed': return 'Finalizada';
      default: return 'Pendiente';
    }
  }

  // 🔥 NUEVA: Función para limpiar notificaciones de tareas finalizadas
  static cleanupFinalizedTaskNotifications(): void {
    try {
      console.log('🧹 [CLEANUP] Iniciando limpieza de notificaciones de tareas finalizadas...');
      
      // Obtener tareas del localStorage
      const storedTasks = localStorage.getItem('smart-student-tasks');
      if (!storedTasks) {
        console.log('⚠️ [CLEANUP] No se encontraron tareas en localStorage');
        return;
      }

      const tasks = JSON.parse(storedTasks);
      const notifications = this.getNotifications();
      
      console.log(`📊 [CLEANUP] Total tareas: ${tasks.length}, Total notificaciones: ${notifications.length}`);
      
      // Encontrar tareas finalizadas (status: 'Finalizada' o 'reviewed')
      const finalizedTasks = tasks.filter((task: any) => 
        task.status === 'Finalizada' || task.status === 'reviewed'
      );
      const finalizedTaskIds = finalizedTasks.map((task: any) => task.id);
      
      console.log(`✅ [CLEANUP] Tareas finalizadas encontradas: ${finalizedTaskIds.length}`);
      finalizedTasks.forEach((task: any) => {
        console.log(`   - ${task.title} (ID: ${task.id}) - Status: ${task.status}`);
      });
      
      // Filtrar notificaciones que NO sean de tareas finalizadas
      // 🔥 CORRECCIÓN: NO eliminar notificaciones de evaluaciones completadas (task_completed + evaluation)
      // ya que los profesores necesitan verlas para revisar resultados
      const filteredNotifications = notifications.filter(notification => {
        const isFromFinalizedTask = finalizedTaskIds.includes(notification.taskId);
        
        // 🎯 NUEVO: Preservar notificaciones de evaluaciones completadas para profesores
        if (isFromFinalizedTask && notification.type === 'task_completed' && notification.taskType === 'evaluation') {
          console.log(`✅ [CLEANUP] Preservando notificación de evaluación completada: "${notification.taskTitle}" (profesor necesita ver resultados)`);
          return true; // NO eliminar evaluaciones completadas
        }
        
        const shouldRemove = isFromFinalizedTask && 
          (notification.type === 'pending_grading' || 
           notification.type === 'task_submission' ||
           notification.type === 'new_task' ||
           (notification.type === 'task_completed' && notification.taskType !== 'evaluation') || // Solo eliminar tareas, no evaluaciones
           notification.type === 'teacher_comment');
        
        if (shouldRemove) {
          console.log(`❌ [CLEANUP] Eliminando notificación: ${notification.type} para tarea "${notification.taskTitle}" (${notification.taskId})`);
        }
        
        return !shouldRemove;
      });
      
      const removedCount = notifications.length - filteredNotifications.length;
      console.log(`\n📈 [CLEANUP] Resumen:`);
      console.log(`   - Notificaciones eliminadas: ${removedCount}`);
      console.log(`   - Notificaciones restantes: ${filteredNotifications.length}`);
      
      // Guardar notificaciones filtradas si hubo cambios
      if (removedCount > 0) {
        this.saveNotifications(filteredNotifications);
        console.log('✅ [CLEANUP] Limpieza completada y guardada');
        
        // Disparar evento para actualizar la UI
        window.dispatchEvent(new CustomEvent('notificationsUpdated', {
          detail: { type: 'cleanup', removedCount }
        }));
      } else {
        console.log('ℹ️ [CLEANUP] No hay notificaciones para limpiar');
      }
      
    } catch (error) {
      console.error('❌ [CLEANUP] Error durante la limpieza de notificaciones:', error);
    }
  }

  // 🔥 NUEVA: Función para limpiar notificaciones específicas de una tarea
  static removeNotificationsForTask(taskId: string, notificationTypes?: string[]): void {
    try {
      console.log(`🗑️ [REMOVE] Eliminando notificaciones para tarea: ${taskId}`);
      
      const notifications = this.getNotifications();
      const typesToRemove = notificationTypes || ['pending_grading', 'task_submission', 'new_task'];
      
      const filteredNotifications = notifications.filter(notification => {
        const shouldRemove = notification.taskId === taskId && 
          typesToRemove.includes(notification.type);
        
        if (shouldRemove) {
          console.log(`❌ [REMOVE] Eliminando: ${notification.type} - ${notification.taskTitle}`);
        }
        
        return !shouldRemove;
      });
      
      const removedCount = notifications.length - filteredNotifications.length;
      
      if (removedCount > 0) {
        this.saveNotifications(filteredNotifications);
        console.log(`✅ [REMOVE] ${removedCount} notificaciones eliminadas para tarea ${taskId}`);
        
        // Disparar evento para actualizar la UI
        window.dispatchEvent(new CustomEvent('notificationsUpdated', {
          detail: { type: 'taskRemoval', taskId, removedCount }
        }));
      }
      
    } catch (error) {
      console.error(`❌ [REMOVE] Error eliminando notificaciones para tarea ${taskId}:`, error);
    }
  }

  // 🔥 NUEVA: Función para eliminar notificaciones de comentarios específicos
  static removeCommentNotifications(taskId: string, teacherUsername: string): void {
    try {
      console.log(`💬 [REMOVE_COMMENTS] Eliminando notificaciones de comentarios para tarea: ${taskId}`);
      
      const notifications = this.getNotifications();
      
      const filteredNotifications = notifications.filter(notification => {
        const shouldRemove = notification.taskId === taskId && 
          notification.type === 'teacher_comment' &&
          notification.targetUsernames.includes(teacherUsername);
        
        if (shouldRemove) {
          console.log(`❌ [REMOVE_COMMENTS] Eliminando comentario: ${notification.fromDisplayName}`);
        }
        
        return !shouldRemove;
      });
      
      const removedCount = notifications.length - filteredNotifications.length;
      
      if (removedCount > 0) {
        this.saveNotifications(filteredNotifications);
        console.log(`✅ [REMOVE_COMMENTS] ${removedCount} notificaciones de comentarios eliminadas`);
        
        // Disparar evento para actualizar la UI
        window.dispatchEvent(new CustomEvent('notificationsUpdated', {
          detail: { type: 'commentRemoval', taskId, removedCount }
        }));
      }
      
    } catch (error) {
      console.error(`❌ [REMOVE_COMMENTS] Error eliminando notificaciones de comentarios:`, error);
    }
  }

  // 🔥 NUEVA: Función para eliminar notificaciones de evaluaciones completadas cuando el profesor las ve
  static removeEvaluationCompletedNotifications(taskId: string, teacherUsername: string, teacherId?: string): void {
    try {
      console.log(`🎯 [REMOVE_EVAL_COMPLETED] Eliminando notificaciones de evaluaciones completadas para tarea: ${taskId}, profesor: ${teacherUsername}, ID: ${teacherId}`);
      
      const notifications = this.getNotifications();
      let removedCount = 0;
      
      const filteredNotifications = notifications.filter(notification => {
        const shouldRemove = notification.taskId === taskId && 
          ((notification.type === 'task_completed' && notification.taskType === 'evaluation') ||
           notification.type === 'evaluation_completed') &&
          (notification.targetUsernames.includes(teacherUsername) || 
           (teacherId && notification.targetUsernames.includes(teacherId))); // Verificar por username o ID
        
        if (shouldRemove) {
          console.log(`📭 [REMOVE_EVAL_COMPLETED] Eliminando notificación de evaluación completada:`, {
            id: notification.id,
            type: notification.type,
            taskType: notification.taskType,
            taskTitle: notification.taskTitle,
            fromUser: notification.fromUsername,
            targetUsers: notification.targetUsernames
          });
          removedCount++;
          return false; // Eliminar esta notificación
        }
        
        return true; // Mantener esta notificación
      });
      
      if (removedCount > 0) {
        this.saveNotifications(filteredNotifications);
        console.log(`✅ [REMOVE_EVAL_COMPLETED] ${removedCount} notificaciones de evaluaciones completadas eliminadas para tarea ${taskId}`);
        
        // Disparar eventos para actualizar la UI
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', {
          detail: { type: 'evaluationCompletedRemoval', taskId, removedCount }
        }));
        
        // También disparar evento para actualizar el contador
        window.dispatchEvent(new CustomEvent('notificationsUpdated', {
          detail: { type: 'evaluationCompletedRemoval', taskId, removedCount }
        }));
      } else {
        console.log(`ℹ️ [REMOVE_EVAL_COMPLETED] No se encontraron notificaciones de evaluaciones completadas para eliminar`);
      }
      
    } catch (error) {
      console.error(`❌ [REMOVE_EVAL_COMPLETED] Error eliminando notificaciones de evaluaciones completadas:`, error);
    }
  }

  // � FUNCIÓN DE MANTENIMIENTO: Reparar notificaciones marcadas incorrectamente como leídas
  static repairIncorrectlyMarkedNotifications(): number {
    try {
      const notifications = this.getNotifications();
      let repaired = 0;
      
      console.log(`[REPAIR] Iniciando reparación de notificaciones mal marcadas...`);
      
      const repairedNotifications = notifications.map(notification => {
        if (notification.type === 'new_task') {
          // Verificar cada estudiante individualmente
          const validReadBy = notification.readBy.filter(username => {
            // Solo mantener como "leído" si realmente entregó y fue calificado (para assignments)
            // o si completó la evaluación (para evaluations)
            if (notification.taskType === 'assignment') {
              const isGraded = this.isTaskAlreadyGraded(notification.taskId, username);
              return isGraded;
            } else if (notification.taskType === 'evaluation') {
              const isCompleted = this.isEvaluationCompletedByStudent(notification.taskId, username);
              return isCompleted;
            }
            return false; // Por defecto, quitar de readBy si no se puede verificar
          });
          
          if (validReadBy.length !== notification.readBy.length) {
            repaired++;
            console.log(`[REPAIR] Reparando notificación ${notification.id}: readBy ${notification.readBy.length} -> ${validReadBy.length}`);
            return {
              ...notification,
              readBy: validReadBy,
              read: validReadBy.length >= notification.targetUsernames.length
            };
          }
        }
        return notification;
      });
      
      if (repaired > 0) {
        this.saveNotifications(repairedNotifications);
        console.log(`🔧 [REPAIR] Reparadas ${repaired} notificaciones mal marcadas`);
        
        // Disparar evento para actualizar la UI
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
      } else {
        console.log(`ℹ️ [REPAIR] No se encontraron notificaciones que necesiten reparación`);
      }
      
      return repaired;
    } catch (error) {
      console.error(`❌ [REPAIR] Error reparando notificaciones:`, error);
      return 0;
    }
  }

  // �🔥 NUEVA: Función para eliminar notificaciones de tarea completada cuando el profesor califica
  static removeTaskCompletedNotifications(taskId: string): void {
    try {
      console.log(`🎯 [REMOVE_COMPLETED] Eliminando notificaciones 'task_completed' para tarea: ${taskId}`);
      
      const notifications = this.getNotifications();
      
      const filteredNotifications = notifications.filter(notification => {
        const shouldRemove = notification.taskId === taskId && 
          notification.type === 'task_completed';
        
        if (shouldRemove) {
          console.log(`❌ [REMOVE_COMPLETED] Eliminando notificación 'task_completed': ${notification.taskTitle}`);
        }
        
        return !shouldRemove;
      });
      
      const removedCount = notifications.length - filteredNotifications.length;
      
      if (removedCount > 0) {
        this.saveNotifications(filteredNotifications);
        console.log(`✅ [REMOVE_COMPLETED] ${removedCount} notificaciones 'task_completed' eliminadas para tarea ${taskId}`);
        
        // Disparar eventos para actualizar la UI
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', {
          detail: { type: 'taskCompletedRemoval', taskId, removedCount }
        }));
        
        // También disparar evento para actualizar el contador
        window.dispatchEvent(new CustomEvent('notificationsUpdated', {
          detail: { type: 'taskCompletedRemoval', taskId, removedCount }
        }));
      }
      
    } catch (error) {
      console.error(`❌ [REMOVE_COMPLETED] Error eliminando notificaciones 'task_completed':`, error);
    }
  }

  // 🎯 Función para verificar si un estudiante está asignado a una tarea específica
  static checkStudentAssignmentToTask(taskId: string, studentId: string, studentUsername: string): boolean {
    try {
      console.log(`🔍 [checkStudentAssignmentToTask] Verificando acceso para estudiante ${studentUsername} (ID: ${studentId}) a tarea ${taskId}`);
      
      // Obtener la tarea
      const storedTasks = localStorage.getItem('smart-student-tasks');
      if (!storedTasks) {
        console.log(`❌ [checkStudentAssignmentToTask] No hay tareas en localStorage`);
        return false;
      }
      
      const tasks = JSON.parse(storedTasks);
      const task = tasks.find((t: any) => t.id === taskId);
      
      if (!task) {
        console.log(`❌ [checkStudentAssignmentToTask] Tarea no encontrada: ${taskId}`);
        return false;
      }
      
      console.log(`📋 [checkStudentAssignmentToTask] Tarea "${task.title}" asignada a: ${task.assignedTo}, curso: ${task.course || task.courseSectionId}`);
      
      // Si la tarea está asignada a estudiantes específicos
      if (task.assignedTo === 'student' && task.assignedStudentIds) {
        const isDirectlyAssigned = task.assignedStudentIds.includes(studentId);
        console.log(`🎯 [checkStudentAssignmentToTask] Estudiante ${studentUsername} directamente asignado: ${isDirectlyAssigned ? '✅' : '❌'}`);
        return isDirectlyAssigned;
      }
      
      // Si la tarea está asignada a todo el curso
      if (task.assignedTo === 'course') {
        const taskCourseId = task.courseSectionId || task.course;
        
        if (!taskCourseId) {
          console.log(`⚠️ [checkStudentAssignmentToTask] Tarea sin courseId definido`);
          return false;
        }
        
        // Obtener información del estudiante
        const usersText = localStorage.getItem('smart-student-users');
        const allUsers = usersText ? JSON.parse(usersText) : [];
        const studentData = allUsers.find((u: any) => u.id === studentId || u.username === studentUsername);
        
        if (!studentData) {
          console.log(`❌ [checkStudentAssignmentToTask] Datos del estudiante no encontrados: ${studentUsername}`);
          return false;
        }
        
        // Verificar usando el sistema de asignaciones dinámicas
        const studentAssignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
        
        // Obtener cursos y secciones disponibles
        const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
        const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
        
        // Buscar los datos del curso de la tarea
        const availableCourses: any[] = [];
        courses.forEach((course: any) => {
          const courseSections = sections.filter((s: any) => s.courseId === course.id);
          courseSections.forEach((section: any) => {
            availableCourses.push({
              id: `${course.id}-${section.id}`,
              courseId: course.id,
              sectionId: section.id,
              name: `${course.name} Sección ${section.name}`
            });
          });
        });
        
        const taskCourseData = availableCourses.find((c: any) => c.id === taskCourseId);
        
        if (taskCourseData) {
          const { sectionId, courseId: actualCourseId } = taskCourseData;
          
          // Verificar si el estudiante está asignado al mismo curso Y sección
          const isAssignedToTaskSection = studentAssignments.some((assignment: any) => 
            assignment.studentId === studentId && 
            assignment.sectionId === sectionId && 
            assignment.courseId === actualCourseId
          );
          
          console.log(`🏫 [checkStudentAssignmentToTask] Verificando curso ${actualCourseId} sección ${sectionId}: ${isAssignedToTaskSection ? '✅' : '❌'}`);
          
          if (isAssignedToTaskSection) {
            return true;
          }
        }
        
        // Fallback: verificar por activeCourses (sistema legacy)
        const isInActiveCourses = studentData.activeCourses?.includes(taskCourseId) || false;
        console.log(`🔄 [checkStudentAssignmentToTask] Fallback activeCourses para ${studentUsername}: ${isInActiveCourses ? '✅' : '❌'}`);
        
        return isInActiveCourses;
      }
      
      // Compatibilidad con versiones anteriores
      if (task.assignedStudents && task.assignedStudents.includes(studentUsername)) {
        console.log(`🔄 [checkStudentAssignmentToTask] Fallback assignedStudents para ${studentUsername}: ✅`);
        return true;
      }
      
      console.log(`❌ [checkStudentAssignmentToTask] Estudiante ${studentUsername} no tiene acceso a la tarea "${task.title}"`);
      return false;
      
    } catch (error) {
      console.error(`❌ [checkStudentAssignmentToTask] Error verificando asignación:`, error);
      return false;
    }
  }
}
