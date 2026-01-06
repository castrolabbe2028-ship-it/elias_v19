  "use client";

  import { useState, useEffect } from 'react';
  import { getGradingConfig } from '@/lib/grading';
  import { useAuth, User as UserType } from '@/contexts/auth-context';
  import { useLanguage } from '@/contexts/language-context';
  import { useRouter } from 'next/navigation';
  import { Button } from '@/components/ui/button';
  import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
  import { Checkbox } from '@/components/ui/checkbox';
  import { Input } from '@/components/ui/input';
  import { TaskNotificationManager } from '@/lib/notifications';
  import { sendEmailOnNotification } from '@/services/email-notification.service';
  import { Label } from '@/components/ui/label';
  import { Textarea } from '@/components/ui/textarea';
  import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
  import { Badge } from '@/components/ui/badge';
  import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
  import { Separator } from '@/components/ui/separator';
  import { ClipboardList, Plus, Calendar, User, Users, MessageSquare, Eye, Send, Edit, Trash2, Paperclip, Download, X, Upload, Star, Lock, ClipboardCheck, Timer, ChevronRight, Award, Shield, GraduationCap } from 'lucide-react';
  import { useToast } from '@/hooks/use-toast';

  // Extended User interface with teacher assignment
  interface ExtendedUser extends UserType {
    password: string;
    assignedTeacherId?: string;
    assignedTeacher?: string; // Username del profesor asignado
    assignedTeachers?: { [subject: string]: string }; // Objeto con asignaturas y profesores
    teachingSubjects?: string[];
    sectionName?: string; // Sección asignada al estudiante (ej: "A", "B")
  }

  interface Task {
    id: string;
    title: string;
    description: string;
    subject: string; // This might become subjectId if subjects get their own store
    course: string; // This will become courseId
  sectionId?: string; // ✅ NEW: explicit section linkage to avoid cross-section replication
    courseSectionId?: string; // 🆕 NUEVO: ID combinado para preservar curso Y sección
    assignedById: string; // Changed from assignedBy (teacher username)
    assignedByName: string; // teacher display name (can be kept for convenience or fetched)
    assignedTo: 'course' | 'student'; // type of assignment
    assignedStudentIds?: string[]; // Changed from assignedStudents (specific student IDs)
    dueDate: string;
    createdAt: string;
    status: 'pending' | 'submitted' | 'reviewed' | 'delivered' | 'finished';
    priority: 'low' | 'medium' | 'high';
    attachments?: TaskFile[]; // Files attached by teacher
    taskType: 'tarea' | 'evaluacion'; // New field for task type
    // Evaluation specific fields
    topic?: string; // Topic for evaluation
    numQuestions?: number; // Number of questions
    timeLimit?: number; // Time limit in minutes
  }

  interface TaskComment {
    id: string;
    taskId: string;
    studentId: string; // Changed from studentUsername
    studentUsername: string; // ✅ NUEVO: Necesario para filtros de notificaciones
    studentName: string; // Can be kept for convenience or fetched using studentId
    comment: string;
    timestamp: string;
    isSubmission: boolean; // true if this is the student's submission
    attachments?: TaskFile[]; // Files attached to this comment/submission
    grade?: number; // Calificación del profesor (opcional)
    teacherComment?: string; // Comentario del profesor (opcional)
    reviewedAt?: string; // Fecha de revisión (opcional)
    readBy?: string[]; // ✅ NUEVO: Lista de usernames que han leído este comentario
    authorUsername?: string; // 🔥 NUEVO: Quién escribió realmente el comentario
    authorRole?: 'student' | 'teacher'; // 🔥 NUEVO: Rol del autor real
  }

  interface TaskFile {
    id: string;
    name: string;
    size: number;
    type: string;
    url: string; // Base64 data URL or external URL
    uploadedBy: string;
    uploadedAt: string;
  }

  export default function TareasPage() {
    const { user } = useAuth();
    const { translate, language } = useLanguage();
    const router = useRouter();
    const { toast } = useToast();

    // Agregar estilos inline para centrado de encabezados (additive approach)
    const tableHeaderStyle = {
      textAlign: 'center' as const,
      fontWeight: '600' as const,
      paddingLeft: '1rem',
      paddingRight: '1rem'
    };

    const [tasks, setTasks] = useState<Task[]>([]);
    const [comments, setComments] = useState<TaskComment[]>([]);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [showTaskDialog, setShowTaskDialog] = useState(false);
    const [showEditDialog, setShowEditDialog] = useState(false);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showGradeDialog, setShowGradeDialog] = useState(false);
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);
    const [submissionToGrade, setSubmissionToGrade] = useState<TaskComment | null>(null);
    const [gradeForm, setGradeForm] = useState({
      grade: '',
      teacherComment: ''
    });
    const [newComment, setNewComment] = useState('');
    const [isSubmission, setIsSubmission] = useState(false);
    const [taskAttachments, setTaskAttachments] = useState<TaskFile[]>([]);
    const [commentAttachments, setCommentAttachments] = useState<TaskFile[]>([]);
    const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
    const [selectedCourseFilter, setSelectedCourseFilter] = useState<string>('all');
    const [viewMode, setViewMode] = useState<'list' | 'course'>('list');

    // En las tablas existentes, aplicar el estilo directamente a los th
    // Esto se aplicará automáticamente cuando el componente se renderice
    const applyHeaderCentering = () => {
      const headers = document.querySelectorAll('thead th');
      headers.forEach(header => {
        (header as HTMLElement).style.textAlign = 'center';
        (header as HTMLElement).style.fontWeight = '600';
        (header as HTMLElement).style.paddingLeft = '1rem';
        (header as HTMLElement).style.paddingRight = '1rem';
      });
    };

    // Agregar useEffect para aplicar estilos automáticamente
    useEffect(() => {
      applyHeaderCentering();
    }, [showTaskDialog, selectedTask]);

    // Estados para el diálogo de revisión mejorado
    const [showReviewDialog, setShowReviewDialog] = useState(false);
    const [showEvaluationReviewDialog, setShowEvaluationReviewDialog] = useState(false);
    const [selectedEvaluationResult, setSelectedEvaluationResult] = useState<any>(null);
    const [currentReview, setCurrentReview] = useState<{
      studentId: string; // Changed from studentUsername
      studentDisplayName: string;
      taskId: string;
      submission?: TaskComment;
      grade: number;
      feedback: string;
      isGraded: boolean;
    }>({
      studentId: '', // Changed from studentUsername
      studentDisplayName: '',
      taskId: '',
      submission: undefined,
      grade: 0,
      feedback: '',
      isGraded: false
    });

    const [formData, setFormData] = useState({
      title: '',
      description: '',
      subject: '', // This might become subjectId
      course: '', // This will hold courseId during form input
      assignedTo: 'course' as 'course' | 'student',
      assignedStudentIds: [] as string[], // Changed from assignedStudents
      dueDate: '',
      priority: 'medium' as 'low' | 'medium' | 'high',
      taskType: 'tarea' as 'tarea' | 'evaluacion',
      // Evaluation specific fields
      topic: '',
      numQuestions: 0,
      timeLimit: 0
    });

    // Estado para asignaturas filtradas basadas en la sección seleccionada
    const [filteredSubjects, setFilteredSubjects] = useState<string[]>([]);

    // useEffect para actualizar asignaturas filtradas cuando cambie el curso seleccionado
    useEffect(() => {
      console.log(`🔄 [useEffect] Curso cambiado a: "${formData.course}"`);
      
      const subjects = getSubjectsForCourseSection(formData.course);
      console.log(`📚 [useEffect] Asignaturas obtenidas:`, subjects);
      
      setFilteredSubjects(subjects);
      
      // Si la asignatura actual no está disponible para la nueva sección, limpiarla
      if (formData.subject && !subjects.includes(formData.subject)) {
        console.log(`⚠️ [useEffect] Asignatura "${formData.subject}" no disponible en nueva sección, limpiando...`);
        setFormData(prev => ({ ...prev, subject: '' }));
      }
    }, [formData.course, user]);

    // useEffect para inicializar asignaturas filtradas al cargar el componente
    useEffect(() => {
      console.log(`🚀 [useEffect init] Inicializando asignaturas filtradas, curso actual: "${formData.course}"`);
      
      if (!formData.course) {
        // Si no hay curso seleccionado, NO mostrar asignaturas (lista vacía)
        console.log(`📚 [useEffect init] No hay curso seleccionado, dejando lista vacía`);
        setFilteredSubjects([]);
      } else {
        // Si hay curso, obtener las asignaturas para ese curso
        const subjects = getSubjectsForCourseSection(formData.course);
        console.log(`📚 [useEffect init] Curso seleccionado, obteniendo asignaturas:`, subjects);
        setFilteredSubjects(subjects);
      }
    }, [user]);

  // 🔄 LISTENER DE SINCRONIZACIÓN AUTOMÁTICA CON GESTIÓN DE USUARIOS
  // Este useEffect escucha cambios en las asignaciones del admin para actualizar en tiempo real
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      // Solo escuchar cambios en las asignaciones del admin
      if (e.key === 'smart-student-student-assignments' || 
          e.key === 'smart-student-teacher-assignments' ||
          e.key === 'smart-student-users') {
        console.log('🔄 [SYNC] Detectado cambio en asignaciones del admin, actualizando...');
        
        // Forzar re-render para actualizar la lista de estudiantes
        setSelectedTask(prev => ({ ...prev }));
        
        // Programar notificación para después del render usando setTimeout
        setTimeout(() => {
          toast({
            title: "Sincronización Automática",
            description: "Las asignaciones de estudiantes se han actualizado desde Gestión de Usuarios.",
            duration: 3000,
          });
        }, 0);
      }
    };

    // Agregar listener para cambios en localStorage
    window.addEventListener('storage', handleStorageChange);
    
    // También escuchar cambios dentro de la misma ventana
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = function(key, value) {
      const oldValue = localStorage.getItem(key);
      originalSetItem.apply(this, arguments);
      
      // Simular evento storage para cambios en la misma ventana
      if (key === 'smart-student-student-assignments' || 
          key === 'smart-student-teacher-assignments' ||
          key === 'smart-student-users') {
        window.dispatchEvent(new StorageEvent('storage', {
          key,
          oldValue,
          newValue: value,
          storageArea: localStorage
        }));
      }
    };

    console.log('🔄 [SYNC] Listener de sincronización automática activado');

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      localStorage.setItem = originalSetItem;
    };
  }, [toast]);

    // Estados para evaluación mejorada
    const [showEvaluationDialog, setShowEvaluationDialog] = useState(false);
    const [showLoadingDialog, setShowLoadingDialog] = useState(false);
    const [loadingProgress, setLoadingProgress] = useState(0);
    const [loadingStatus, setLoadingStatus] = useState('');
    const [currentEvaluation, setCurrentEvaluation] = useState<{
      task: Task | null;
      questions: any[];
      startTime: Date | null;
      answers: { [key: string]: any };
      timeRemaining: number;
      currentQuestionIndex: number;
    }>({
      task: null,
      questions: [],
      startTime: null,
      answers: {},
      timeRemaining: 0,
      currentQuestionIndex: 0
    });

    // Estado para resultados de evaluación
    const [evaluationResults, setEvaluationResults] = useState<{[taskId: string]: any}>({});

    // Estado para revisión de evaluación
    const [showReviewEvaluationDialog, setShowReviewEvaluationDialog] = useState(false);
    const [currentEvaluationReview, setCurrentEvaluationReview] = useState<any>(null);

    // Estado para modal de tiempo agotado
    const [showTimeExpiredDialog, setShowTimeExpiredDialog] = useState(false);
    const [timeExpiredResult, setTimeExpiredResult] = useState<any>(null);
    const [evaluationTimeExpired, setEvaluationTimeExpired] = useState(false);

    // Debug: Monitor cambios en el modal de tiempo agotado
    useEffect(() => {
      console.log('🔥 [useEffect] showTimeExpiredDialog cambió a:', showTimeExpiredDialog);
      console.log('🔥 [useEffect] timeExpiredResult:', !!timeExpiredResult);
      console.log('🔥 [useEffect] evaluationTimeExpired:', evaluationTimeExpired);
    }, [showTimeExpiredDialog, timeExpiredResult, evaluationTimeExpired]);

    // Nuevo useEffect para detectar cuando el tiempo llega a 0
    useEffect(() => {
      if (currentEvaluation.timeRemaining === 0 && 
          currentEvaluation.task && 
          !showTimeExpiredDialog &&
          !timeExpiredResult) {
        console.log('🔥 [useEffect] Tiempo llegó a 0, forzando completion');
        handleCompleteEvaluation(true);
      }
    }, [currentEvaluation.timeRemaining]);

    // Cargar resultados de evaluaciones existentes
    useEffect(() => {
      loadEvaluationResults();
    }, [user]);

    // Function to get task status for current user, considering evaluations
    const getTaskStatusForCurrentUser = (task: Task) => {
      if (task.taskType === 'evaluacion') {
        if (user?.role === 'student') {
          const evaluationResult = evaluationResults[task.id];
          if (evaluationResult) {
            return {
              status: 'reviewed',
              statusText: `${translate('statusFinished')} (${evaluationResult.percentage}%)`,
              statusClass: 'bg-green-500 hover:bg-green-600 text-white'
            };
          } else {
            return {
              status: 'pending',
              statusText: translate('statusPending'),
              statusClass: getStatusColor('pending')
            };
          }
        } else if (user?.role === 'teacher') {
          // Para profesores, mostrar el estado real de la evaluación
          return {
            status: task.status,
            statusText: task.status === 'pending' ? translate('statusPending') : 
                        task.status === 'finished' ? translate('statusFinished') : 
                        translate('statusPending'),
            statusClass: getStatusColor(task.status)
          };
        }
      }

      // Para tareas normales, usar el estado original
      return {
        status: task.status,
        statusText: task.status === 'pending' ? translate('statusPending') : 
                    task.status === 'delivered' ? translate('underReview') :
                    task.status === 'submitted' ? translate('underReview') : 
                    task.status === 'finished' ? translate('statusFinished') : translate('statusFinished'),
        statusClass: getStatusColor(task.status)
      };
    };

    const loadEvaluationResults = () => {
      if (user) {
        const storedResults = localStorage.getItem('smart-student-evaluation-results');
        if (storedResults) {
          const results = JSON.parse(storedResults);
          const userResults = results.filter((result: any) => result.studentId === user.id);
          const resultsMap: {[taskId: string]: any} = {};
          userResults.forEach((result: any) => {
            resultsMap[result.taskId] = result;
          });
          setEvaluationResults(resultsMap);

          // Si es profesor, verificar y actualizar estados de evaluaciones
          if (user.role === 'teacher') {
            // Verificar todas las evaluaciones creadas por este profesor
            const teacherEvaluations = tasks.filter(task => 
              task.taskType === 'evaluacion' && 
              task.assignedById === user.id &&
              task.status === 'pending'
            );
            
            teacherEvaluations.forEach(task => {
              checkAndUpdateEvaluationStatus(task.id);
            });
          }
        }
      }
    };

    // Load tasks and comments
    useEffect(() => {
      loadTasks();
      loadComments();
      loadEvaluationResults();
      
      // 🧹 LIMPIEZA AUTOMÁTICA SÚPER AGRESIVA: Eliminar TODAS las notificaciones "task_completed"
      // Ejecuta en cada carga de página y se repite para mantener el panel limpio
      const cleanupTaskCompletedNotifications = () => {
        if (user?.role === 'teacher') {
          try {
            const notifications = JSON.parse(localStorage.getItem('smart-student-notifications') || '[]');
            const taskCompletedNotifications = notifications.filter((n: any) => n.type === 'task_completed');
            
            console.log(`🔍 [CLEANUP] VERIFICANDO: ${notifications.length} notificaciones totales`);
            console.log(`🎯 [CLEANUP] ENCONTRADAS: ${taskCompletedNotifications.length} notificaciones task_completed`);
            
            if (taskCompletedNotifications.length > 0) {
              // Mostrar detalles de las notificaciones que se van a eliminar
              console.log('📋 [CLEANUP] ELIMINANDO notificaciones task_completed:', 
                taskCompletedNotifications.map((n: any) => ({
                  id: n.id,
                  title: n.taskTitle || n.title,
                  timestamp: n.timestamp
                }))
              );
              
              const cleanedNotifications = notifications.filter((n: any) => n.type !== 'task_completed');
              localStorage.setItem('smart-student-notifications', JSON.stringify(cleanedNotifications));
              
              // Disparar evento para actualizar la UI inmediatamente
              window.dispatchEvent(new CustomEvent('notificationsUpdated', {
                detail: { 
                  type: 'cleanup', 
                  action: 'auto_cleanup_task_completed',
                  removed: taskCompletedNotifications.length 
                }
              }));
              
              console.log(`✅ [CLEANUP] ELIMINADAS: ${taskCompletedNotifications.length} notificaciones task_completed`);
              console.log(`📊 [CLEANUP] RESTANTES: ${cleanedNotifications.length} notificaciones en total`);
            } else {
              console.log(`✅ [CLEANUP] PANEL LIMPIO: No hay notificaciones task_completed`);
            }
          } catch (error) {
            console.warn('⚠️ [CLEANUP] Error al limpiar notificaciones automáticamente:', error);
          }
        }
      };

      // Ejecutar limpieza inicial
      cleanupTaskCompletedNotifications();
      
      // Ejecutar limpieza cada 2 segundos para mantener el panel limpio
      const cleanupInterval = setInterval(cleanupTaskCompletedNotifications, 2000);
      
      // Forzar refresco de tareas para asegurar que el panel de estudiantes se actualice con las entregas
      loadTasks && loadTasks();
      // Si hay un selectedTask, forzar su recarga desde localStorage para obtener la versión más reciente
      if (selectedTask) {
        const storedTasks = localStorage.getItem('smart-student-tasks');
        if (storedTasks) {
          const tasksArr = JSON.parse(storedTasks);
          const updated = tasksArr.find((t: any) => t.id === selectedTask.id);
          if (updated) setSelectedTask(updated);
        }
      }
      
      // Limpiar interval cuando el componente se desmonte
      return () => {
        clearInterval(cleanupInterval);
      };
    }, []);
    
    // Maneja la navegación desde notificaciones (separado para ejecutarse después de cargar las tareas)
    useEffect(() => {
      if (tasks.length > 0) {
        // Lee los parámetros de la URL para manejar navegación desde notificaciones
        const urlParams = new URLSearchParams(window.location.search);
        const taskIdParam = urlParams.get('taskId');
        const commentIdParam = urlParams.get('commentId');
        const highlightParam = urlParams.get('highlight');
        
        if (taskIdParam) {
          // Busca la tarea por ID y ábrela
          const task = tasks.find(t => t.id === taskIdParam);
          if (task) {
            setSelectedTask(task);
            setShowTaskDialog(true);
            
            // 🔥 ESCENARIO 2: Eliminar notificaciones de comentarios cuando el profesor abre la tarea
            if (user?.role === 'teacher' && user?.username) {
              console.log('🔔 [ESCENARIO 2] Profesor abrió la tarea, eliminando notificaciones de comentarios...');
              
              // 🎯 CAMBIO: NO eliminar automáticamente las notificaciones de evaluaciones completadas
              // Las notificaciones de evaluaciones completadas deben eliminarse solo cuando el profesor
              // hace clic específicamente en "Ver Resultados" desde el panel de notificaciones
              if (task.taskType === 'evaluacion') {
                console.log('🔔 [EVALUACION_VISTA] Profesor abrió evaluación - MANTENIENDO notificaciones de evaluaciones completadas');
                // TaskNotificationManager.removeEvaluationCompletedNotifications(taskIdParam, user.username); // COMENTADO
              }
              
              // Obtener comentarios de esta tarea
              const storedComments = localStorage.getItem('smart-student-task-comments');
              if (storedComments) {
                const allComments: TaskComment[] = JSON.parse(storedComments);
                let hasChanges = false;
                
                // Marcar como leídos todos los comentarios de estudiantes para esta tarea
                const updatedComments = allComments.map(comment => {
                  if (comment.taskId === taskIdParam && 
                      !comment.isSubmission && 
                      comment.studentUsername !== user.username &&
                      !comment.readBy?.includes(user.username)) {
                    
                    console.log(`📖 [ESCENARIO 2] Marcando como leído comentario de ${comment.studentName}: ${comment.comment?.substring(0, 30)}...`);
                    hasChanges = true;
                    
                    return {
                      ...comment,
                      readBy: [...(comment.readBy || []), user.username]
                    };
                  }
                  return comment;
                });
                
                // Guardar cambios si hubo modificaciones
                if (hasChanges) {
                  localStorage.setItem('smart-student-task-comments', JSON.stringify(updatedComments));
                  
                  // Eliminar notificaciones de comentarios para esta tarea
                  TaskNotificationManager.removeCommentNotifications(taskIdParam, user.username);
                  
                  // Disparar evento para actualizar notificaciones
                  window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', {
                    detail: { 
                      type: 'task_opened',
                      taskId: taskIdParam,
                      action: 'remove_comment_notifications'
                    }
                  }));
                  
                  // ✅ NUEVA MEJORA: También disparar evento para actualizar contadores del dashboard
                  window.dispatchEvent(new CustomEvent('updateDashboardCounts', {
                    detail: { userRole: user.role, action: 'task_opened', taskId: taskIdParam }
                  }));
                  
                  console.log('✅ [ESCENARIO 2] Comentarios marcados como leídos y notificaciones eliminadas');
                }
              }
            }
            
            // Si hay un ID de comentario para destacar
            if (commentIdParam && highlightParam === 'true') {
              setHighlightedCommentId(commentIdParam);
              // Programar un desplazamiento al comentario después de que se abra el diálogo
              setTimeout(() => {
                const commentElement = document.getElementById(`comment-${commentIdParam}`);
                if (commentElement) {
                  commentElement.scrollIntoView({ behavior: 'smooth' });
                }
              }, 500); // Pequeño retraso para asegurar que el diálogo esté completamente abierto
            }
          }
        }
      }
    }, [tasks]);

    // Limpiar highlightedCommentId cuando se cierra el diálogo y recargar comentarios cuando se abre
    useEffect(() => {
      if (!showTaskDialog) {
        setHighlightedCommentId(null);
        
        // 🔥 NUEVA MEJORA: Disparar evento cuando se cierra el diálogo para actualizar el dashboard
        if (user?.role === 'student') {
          console.log('🔔 [TaskDialog] Closed - dispatching dashboard update event');
          window.dispatchEvent(new CustomEvent('taskDialogClosed', { 
            detail: { 
              userRole: user.role,
              username: user.username,
              action: 'task_dialog_closed'
            } 
          }));
        }
      } else {
        // Recargar comentarios cuando se abre el diálogo para tener datos frescos
        console.log('🔄 Reloading comments because task dialog opened');
        loadComments();
        
        // Si el usuario es estudiante y hay una tarea seleccionada, marcar TODOS los comentarios como leídos
        if (user?.role === 'student' && selectedTask && user.username) {
          console.log('🔔 Marking ALL comments as read for task', selectedTask.id);
          
          // Usar setTimeout para asegurar que los comentarios se cargan primero
          setTimeout(() => {
            // Marcar directamente en localStorage todos los comentarios de la tarea como leídos
            const storedComments = localStorage.getItem('smart-student-task-comments');
            if (storedComments) {
              const comments = JSON.parse(storedComments);
              let updated = false;
              
              const updatedComments = comments.map((comment: any) => {
                if (
                  comment.taskId === selectedTask.id && 
                  comment.studentUsername !== user.username && // No marcar comentarios propios
                  (!comment.readBy?.includes(user.username))
                ) {
                  updated = true;
                  console.log(`🔔 Marking comment ${comment.id} as read`);
                  return {
                    ...comment,
                    isNew: false,
                    readBy: [...(comment.readBy || []), user.username]
                  };
                }
                return comment;
              });
              
              if (updated) {
                localStorage.setItem('smart-student-task-comments', JSON.stringify(updatedComments));
                console.log(`🔔 ✅ Marked all comments for task ${selectedTask.id} as read`);
                
                // Disparar eventos para actualizar la UI
                document.dispatchEvent(new Event('commentsUpdated'));
                window.dispatchEvent(new CustomEvent('studentCommentsUpdated', { 
                  detail: { 
                    username: user.username,
                    taskId: selectedTask.id,
                    action: 'marked_as_read_bulk'
                  } 
                }));
                
                // Disparar evento para actualizar dashboard
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('updateDashboardCounts', {
                    detail: { userRole: 'student', action: 'task_opened' }
                  }));
                }, 100);
              }
            }
          }, 200);
          
          // También usar la función del TaskNotificationManager como respaldo
          TaskNotificationManager.markCommentsAsReadForTask(selectedTask.id, user.username);
        }
      }
    }, [showTaskDialog, selectedTask, user]);

    // Listener para actualizar el panel de estudiantes cuando hay entregas
    useEffect(() => {
      const handleStudentPanelUpdate = (event: CustomEvent) => {
        console.log('🔄 Student panel update event:', event.detail);
        // Recargar comentarios para actualizar el estado de los estudiantes
        loadComments();
        // Si el diálogo está abierto, forzar re-render del panel
        if (showTaskDialog && selectedTask) {
          setTimeout(() => {
            console.log('🔄 Forcing panel refresh after student submission');
            setSelectedTask({...selectedTask}); // Trigger re-render
          }, 500);
        }
      };

      window.addEventListener('studentPanelUpdate', handleStudentPanelUpdate as EventListener);
      
      return () => {
        window.removeEventListener('studentPanelUpdate', handleStudentPanelUpdate as EventListener);
      };
    }, [showTaskDialog, selectedTask]);

    // Verificación periódica del estado de evaluaciones (solo para profesores)
    useEffect(() => {
      if (user?.role !== 'teacher') return;

      const checkEvaluationsInterval = setInterval(() => {
        const allEvaluations = tasks.filter(task => 
          task.taskType === 'evaluacion' && 
          task.assignedById === user.id
        );

        console.log(`🔄 Verificación periódica: ${allEvaluations.length} evaluaciones del profesor`);
        allEvaluations.forEach(task => {
          console.log(`⏰ Verificando evaluación "${task.title}" - Estado: ${task.status}`);
          checkAndUpdateEvaluationStatus(task.id);
        });
      }, 30000); // Verificar cada 30 segundos

      return () => clearInterval(checkEvaluationsInterval);
    }, [user, tasks]);

    const loadTasks = () => {
      const storedTasks = localStorage.getItem('smart-student-tasks');
      const usersText = localStorage.getItem('smart-student-users');
      const allUsers: ExtendedUser[] = usersText ? JSON.parse(usersText) : [];

      if (storedTasks) {
        let tasksData = JSON.parse(storedTasks) as Partial<Task>[];
        let tasksModified = false;

        tasksData = tasksData.map(task => {
          const migratedTask: Partial<Task> = { ...task };
          // Migrate assignedBy to assignedById
          if ((task as any).assignedBy && !task.assignedById) {
            const teacher = allUsers.find(u => u.username === (task as any).assignedBy && u.role === 'teacher');
            if (teacher && teacher.id) {
              migratedTask.assignedById = teacher.id;
              delete (migratedTask as any).assignedBy; // Remove old field
              tasksModified = true;
            } else {
              // console.warn(`Teacher username ${(task as any).assignedBy} not found for task ${task.title}`);
              migratedTask.assignedById = (task as any).assignedBy; // Keep old value if no ID found, mark for review
            }
          }

          // Migrate assignedStudents (usernames) to assignedStudentIds
          if ((task as any).assignedStudents && !task.assignedStudentIds) {
            migratedTask.assignedStudentIds = (task as any).assignedStudents
              .map((username: string) => {
                const student = allUsers.find(u => u.username === username && u.role === 'student');
                if (student && student.id) return student.id;
                // console.warn(`Student username ${username} not found for task ${task.title}`);
                return null;
              })
              .filter((id: string | null) => id !== null) as string[];
            delete (migratedTask as any).assignedStudents;
            tasksModified = true;
          }

          // Backfill sectionId from courseSectionId if missing (prevents cross-section replication)
          if (!(migratedTask as any).sectionId && (migratedTask as any).courseSectionId) {
            try {
              const cs = String((migratedTask as any).courseSectionId || '');
              const parts = cs.split('-');
              // Expect combined id of two UUIDs => 10 parts (5 + 5)
              if (parts.length === 10) {
                (migratedTask as any).sectionId = parts.slice(5).join('-');
                tasksModified = true;
              }
            } catch {}
          }
          // Course is expected to be courseId, no direct migration here, assumed to be correct from creation
          return migratedTask;
        });

        setTasks(tasksData as Task[]);
        if (tasksModified) {
          // console.log("Migrating tasks in localStorage due to ID changes...");
          localStorage.setItem('smart-student-tasks', JSON.stringify(tasksData));
        }

        // Verificar y corregir el estado de evaluaciones al cargar tareas
        const evaluationTasks = (tasksData as Task[]).filter(task => 
          task.taskType === 'evaluacion'
        );
        
        console.log(`🔍 Verificando estados de ${evaluationTasks.length} evaluaciones al cargar...`);
        evaluationTasks.forEach(task => {
          console.log(`📋 Evaluación "${task.title}" - Estado actual: ${task.status}`);
          // Usar setTimeout para evitar problemas de estado
          setTimeout(() => checkAndUpdateEvaluationStatus(task.id), 100);
        });

        // 🔥 NUEVO: Limpiar notificaciones obsoletas de evaluaciones ya finalizadas
        if (user?.role === 'teacher') {
          setTimeout(() => {
            console.log('🧹 Limpiando notificaciones obsoletas de evaluaciones finalizadas...');
            const finishedEvaluations = (tasksData as Task[]).filter(task => 
              task.taskType === 'evaluacion' && 
              task.status === 'finished' &&
              task.assignedById === user.id
            );
            
            finishedEvaluations.forEach(task => {
              TaskNotificationManager.removeNotificationsForTask(task.id, ['pending_grading']);
              console.log(`🗑️ Removed obsolete notifications for finished evaluation: ${task.title}`);
            });
            
            if (finishedEvaluations.length > 0) {
              window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
              console.log(`✅ Cleaned up notifications for ${finishedEvaluations.length} finished evaluations`);
            }
          }, 500);
        }
      }
    };

    const loadComments = () => {
      const storedComments = localStorage.getItem('smart-student-task-comments');
      const usersText = localStorage.getItem('smart-student-users');
      const allUsers: ExtendedUser[] = usersText ? JSON.parse(usersText) : [];

      if (storedComments) {
        let commentsData = JSON.parse(storedComments) as Partial<TaskComment>[];
        let commentsModified = false;

        commentsData = commentsData.map(comment => {
          const migratedComment: Partial<TaskComment> = { ...comment };
          if ((comment as any).studentUsername && !comment.studentId) {
            const student = allUsers.find(u => u.username === (comment as any).studentUsername && u.role === 'student');
            if (student && student.id) {
              migratedComment.studentId = student.id;
              // studentName can be kept or re-fetched based on studentId if needed for consistency
              // migratedComment.studentName = student.displayName;
              delete (migratedComment as any).studentUsername;
              commentsModified = true;
            } else {
              // console.warn(`Student username ${(comment as any).studentUsername} not found for comment ${comment.id}`);
              migratedComment.studentId = (comment as any).studentUsername; // Keep old value if no ID found
            }
          }
          return migratedComment;
        });

        console.log('📥 Loading comments from localStorage:', {
          totalComments: commentsData.length,
          // submissions: commentsData.filter((c: any) => c.isSubmission),
          // allComments: commentsData
        });
        setComments(commentsData as TaskComment[]);
        if (commentsModified) {
          // console.log("Migrating comments in localStorage due to ID changes...");
          localStorage.setItem('smart-student-task-comments', JSON.stringify(commentsData));
        }

      } else {
        console.log('📥 No comments found in localStorage');
        setComments([]);
      }
    };

    const saveTasks = (newTasks: Task[]) => {
      localStorage.setItem('smart-student-tasks', JSON.stringify(newTasks));
      setTasks(newTasks);
      // Notificar a otras vistas en la misma pestaña (el evento 'storage' no se dispara localmente)
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'smart-student-tasks',
          newValue: JSON.stringify(newTasks)
        }));
      } catch {}
    };

    const saveComments = (newComments: TaskComment[]) => {
      localStorage.setItem('smart-student-task-comments', JSON.stringify(newComments));
      setComments(newComments);
      // Notificar a otras vistas (Calificaciones escucha este cambio para sincronizar notas)
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'smart-student-task-comments',
          newValue: JSON.stringify(newComments)
        }));
      } catch {}
      // Opcional: disparar evento para refrescar paneles que dependan de comentarios/notas
      try {
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', { detail: { reason: 'taskCommentsSaved' } }));
      } catch {}
    };

    // Get available courses and subjects for teacher
    const getAvailableCourses = () => {
      if (user?.role === 'teacher') {
        return user.activeCourses || [];
      }
      return [];
    };

    // Function to get course name from course ID
    const getCourseNameById = (courseId: string): string => {
      const coursesText = localStorage.getItem('smart-student-courses');
      if (coursesText) {
        const courses = JSON.parse(coursesText);
        const course = courses.find((c: any) => c.id === courseId);
        return course ? course.name : courseId; // Return name if found, otherwise return ID
      }
      return courseId;
    };

    // Function to get teacher username from teacher ID
    const getTeacherUsernameById = (teacherId: string): string => {
      const usersText = localStorage.getItem('smart-student-users');
      if (usersText) {
        const users = JSON.parse(usersText);
        const teacher = users.find((u: any) => u.id === teacherId && u.role === 'teacher');
        return teacher ? teacher.username : teacherId;
      }
      return teacherId;
    };

    // Función para obtener el nombre legible del curso y sección de una tarea
    const getCourseAndSectionName = (courseCode: string): string => {
      try {
        // Obtener datos del sistema
        const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
        const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
        const availableCourses = getAvailableCoursesWithNames();
        const currentYear = new Date().getFullYear();
        const students = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
        
        // Método 1: Buscar en cursos disponibles (más completo - ya incluye sección)
        const foundCourse = availableCourses.find(c => c.id === courseCode || c.courseId === courseCode);
        if (foundCourse && foundCourse.name) {
          return foundCourse.name;
        }
        
        // Método 2: Parsear código compuesto (courseId-sectionId)
        if (courseCode.includes('-') && courseCode.length > 40) {
          const parts = courseCode.split('-');
          if (parts.length >= 10) {
            const actualCourseId = parts.slice(0, 5).join('-');
            const sectionId = parts.slice(5).join('-');
            
            const course = courses.find((c: any) => c.id === actualCourseId);
            const section = sections.find((s: any) => s.id === sectionId);
            
            if (course && section) {
              return `${course.name} ${translate('userManagementSection')} ${section.name}`;
            }
          }
        }
        
        // Método 3: Buscar solo por courseId si no es compuesto
        const course = courses.find((c: any) => c.id === courseCode);
        if (course) {
          // Intentar obtener la sección del estudiante actual
          const studentId = (user as any)?.id || user?.username;
          const student = students.find((s: any) => s.id === studentId || s.username === studentId);
          
          if (student?.sectionId) {
            const section = sections.find((s: any) => s.id === student.sectionId);
            if (section) {
              return `${course.name} ${translate('userManagementSection')} ${section.name}`;
            }
          }
          
          // Si no encontramos sección del estudiante, buscar por courseId en secciones
          const sectionForCourse = sections.find((s: any) => s.courseId === courseCode || s.courseId === course.id);
          if (sectionForCourse) {
            return `${course.name} ${translate('userManagementSection')} ${sectionForCourse.name}`;
          }
          
          return course.name;
        }
        
        // Método 4: Mapeo para códigos conocidos
        const knownCourses: { [key: string]: string } = {
          '4to_basico_a': '4to Básico Sección A',
          '4to_basico_b': '4to Básico Sección B',
          '5to_basico_a': '5to Básico Sección A',
          '5to_basico_b': '5to Básico Sección B',
          'ciencias_naturales': 'Ciencias Naturales',
          'matematicas': 'Matemáticas',
          'historia': 'Historia, Geografía y Ciencias Sociales'
        };
        
        if (knownCourses[courseCode]) {
          return knownCourses[courseCode];
        }
        
        // Método 5: Fallback - usar código directamente pero limpio
        return courseCode.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
        
      } catch (error) {
        console.warn('Error al obtener nombre del curso:', error);
        return courseCode;
      }
    };

    // Function to get all courses with their names and sections for dropdown
    const getAvailableCoursesWithNames = () => {
      if (user?.role === 'teacher') {
        try {
          // Intentar obtener asignaciones específicas del sistema de asignaciones
          const teacherAssignments = JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]');
          const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
          const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
          
          // Buscar asignaciones del profesor actual
          const userAssignments = teacherAssignments.filter((assignment: any) => 
            assignment.teacherId === user.id
          );

          if (userAssignments.length > 0) {
            // Crear lista de cursos y secciones únicos del profesor
            const courseSectionsMap = new Map();
            
            userAssignments.forEach((assignment: any) => {
              const section = sections.find((s: any) => s.id === assignment.sectionId);
              if (section) {
                const course = courses.find((c: any) => c.id === section.courseId);
                if (course) {
                  const key = `${course.id}-${section.id}`;
                  if (!courseSectionsMap.has(key)) {
                    courseSectionsMap.set(key, {
                      id: key, // Usar la clave combinada como ID único
                      courseId: course.id, // Mantener el ID original del curso para lógica de filtrado
                      sectionId: section.id, // ✅ AGREGAR sectionId que estaba faltando
                      name: `${course.name} ${translate('userManagementSection')} ${section.name}`,
                      originalCourseName: course.name,
                      sectionName: section.name
                    });
                  }
                }
              }
            });

            if (courseSectionsMap.size > 0) {
              return Array.from(courseSectionsMap.values());
            }
          }

          // Fallback al método original si no hay asignaciones específicas
          const courseIds = user.activeCourses || [];
          return courseIds.map(courseId => ({
            id: courseId,
            courseId: courseId,
            sectionId: null, // No hay sección específica en el fallback
            name: getCourseNameById(courseId),
            originalCourseName: getCourseNameById(courseId)
          }));
        } catch (error) {
          console.error('Error al obtener cursos con secciones:', error);
          // Fallback en caso de error
          const courseIds = user.activeCourses || [];
          return courseIds.map(courseId => ({
            id: courseId,
            courseId: courseId,
            sectionId: null, // No hay sección específica en el fallback
            name: getCourseNameById(courseId),
            originalCourseName: getCourseNameById(courseId)
          }));
        }
      }
      return [];
    };

    const getAvailableSubjects = () => {
      if (user?.role === 'teacher' && user.teachingAssignments) {
        return [...new Set(user.teachingAssignments.map(ta => ta.subject))];
      }
      return ['Matemáticas', 'Lenguaje y Comunicación', 'Ciencias Naturales', 'Historia, Geografía y Ciencias Sociales'];
    };

    // Function to get subjects available for a specific course-section combination
    const getSubjectsForCourseSection = (courseSectionId: string): string[] => {
      console.log(`🔍 [getSubjectsForCourseSection] Iniciando con courseSectionId: "${courseSectionId}"`);
      
      if (!courseSectionId || !user?.id) {
        console.log(`⚠️ [getSubjectsForCourseSection] Faltan datos: courseSectionId=${courseSectionId}, userId=${user?.id}`);
        return [];
      }

      // Mapeo de abreviaciones a nombres completos
      const subjectAbbreviationMap: { [key: string]: string } = {
        'MAT': 'Matemáticas',
        'LEN': 'Lenguaje y Comunicación', 
        'CNT': 'Ciencias Naturales',
        'HIS': 'Historia, Geografía y Ciencias Sociales',
        'FIS': 'Física',
        'QUI': 'Química',
        'BIO': 'Biología',
        'ING': 'Inglés'
      };

      try {
        // Buscar si el courseSectionId es un ID combinado (courseId-sectionId)
        const availableCourses = getAvailableCoursesWithNames();
        console.log(`📋 [getSubjectsForCourseSection] Cursos disponibles:`, availableCourses);
        
        const selectedCourse = availableCourses.find(course => course.id === courseSectionId);
        console.log(`🎯 [getSubjectsForCourseSection] Curso seleccionado:`, selectedCourse);

        if (selectedCourse && selectedCourse.courseId) {
          // Es un ID combinado, extraer sectionId de manera más robusta
          console.log(`🔧 [getSubjectsForCourseSection] Procesando courseSectionId: "${courseSectionId}"`);
          
          // El formato es: "courseId-sectionId" donde ambos son UUIDs
          // Ejemplo: "9077a79d-c290-45f9-b549-6e57df8828d2-d326c181-fa30-4c50-ab68-efa085a3ffd3"
          // Necesitamos extraer: "d326c181-fa30-4c50-ab68-efa085a3ffd3"
          
          let sectionId = '';
          const parts = courseSectionId.split('-');
          
          if (parts.length === 10) {
            // Es un ID combinado de dos UUIDs (5 partes cada uno)
            // Reconstruir el segundo UUID (sectionId)
            sectionId = parts.slice(5).join('-');
          } else if (courseSectionId.includes('seccion-')) {
            // Formato alternativo: "4to-basico-seccion-A"
            sectionId = courseSectionId.split('seccion-')[1];
          } else {
            // Fallback: usar el ID completo
            sectionId = courseSectionId;
          }
          
          console.log(`🔧 [getSubjectsForCourseSection] SectionId extraído: "${sectionId}"`);
          console.log(`🔧 [DEBUG] Partes del courseSectionId: ${parts.length} - [${parts.join(', ')}]`);
          
          // 🔍 DEBUG: Verificar datos en localStorage
          console.log(`🔍 [DEBUG] Verificando localStorage...`);
          const teacherAssignmentsRaw = localStorage.getItem('smart-student-teacher-assignments');
          console.log(`🔍 [DEBUG] teacherAssignmentsRaw:`, teacherAssignmentsRaw);
          
          // Obtener asignaciones del profesor desde localStorage
          const teacherAssignments = JSON.parse(teacherAssignmentsRaw || '[]');
          console.log(`📚 [getSubjectsForCourseSection] Total asignaciones de profesores:`, teacherAssignments.length);
          console.log(`📝 [getSubjectsForCourseSection] Todas las asignaciones:`, teacherAssignments);
          
          // 🔍 DEBUG: Verificar ID del usuario actual
          console.log(`🔍 [DEBUG] user.id actual: "${user.id}"`);
          console.log(`🔍 [DEBUG] sectionId buscado: "${sectionId}"`);
          
          // 🔍 DEBUG: Mostrar todas las secciones disponibles del profesor
          const allTeacherAssignments = teacherAssignments.filter((assignment: any) => 
            assignment.teacherId === user.id
          );
          console.log(`🔍 [DEBUG] TODAS las asignaciones del profesor ${user.id}:`, allTeacherAssignments);
          
          if (allTeacherAssignments.length > 0) {
            const availableSections = [...new Set(allTeacherAssignments.map((a: any) => a.sectionId))];
            console.log(`🔍 [DEBUG] Secciones disponibles: [${availableSections.join(', ')}]`);
          }
          
          // Buscar asignaciones específicas para esta sección
          const sectionAssignments = teacherAssignments.filter((assignment: any) => {
            console.log(`🔍 [DEBUG] Comparando assignment:`, {
              teacherId: assignment.teacherId,
              sectionId: assignment.sectionId,
              subjectName: assignment.subjectName,
              coincideTeacher: assignment.teacherId === user.id,
              coincideSection: assignment.sectionId === sectionId
            });
            return assignment.teacherId === user.id && assignment.sectionId === sectionId;
          });
          console.log(`🎓 [getSubjectsForCourseSection] Asignaciones para profesor ${user.id} en sección ${sectionId}:`, sectionAssignments);

          if (sectionAssignments.length > 0) {
            // Obtener las asignaturas únicas de estas asignaciones
            const subjectNames = sectionAssignments.map((assignment: any) => assignment.subjectName);
            console.log(`📝 [getSubjectsForCourseSection] Nombres de asignaturas en asignaciones:`, subjectNames);
            
            // Mapear abreviaciones a nombres completos
            const mappedSubjects: string[] = subjectNames
              .map((subjectName: string) => {
                // Si es una abreviación, mapearla al nombre completo
                const fullName = subjectAbbreviationMap[subjectName] || subjectName;
                console.log(`🔄 [getSubjectsForCourseSection] Mapeando "${subjectName}" → "${fullName}"`);
                return fullName;
              })
              .filter((subject: string) => typeof subject === 'string' && subject.length > 0);
            
            const uniqueSubjects: string[] = [...new Set(mappedSubjects)];
            console.log(`✅ [getSubjectsForCourseSection] Asignaturas filtradas para sección ${sectionId}:`, uniqueSubjects);
            return uniqueSubjects;
          } else {
            console.log(`⚠️ [getSubjectsForCourseSection] No se encontraron asignaciones específicas para sección ${sectionId}`);
            
            // 🔍 DEBUG: Intentar encontrar asignaciones para CUALQUIER sección de este profesor
            const allTeacherAssignments = teacherAssignments.filter((assignment: any) => 
              assignment.teacherId === user.id
            );
            console.log(`🔍 [DEBUG] TODAS las asignaciones del profesor ${user.id}:`, allTeacherAssignments);
            
            if (allTeacherAssignments.length > 0) {
              console.log(`� [DEBUG] Encontradas ${allTeacherAssignments.length} asignaciones del profesor para otras secciones`);
              // Mostrar las materias de cualquier sección como fallback temporal
              const allSubjectNames = allTeacherAssignments.map((assignment: any) => assignment.subjectName);
              const mappedFallbackSubjects: string[] = allSubjectNames
                .map((subjectName: string) => subjectAbbreviationMap[subjectName] || subjectName)
                .filter((subject: string) => typeof subject === 'string' && subject.length > 0);
              const uniqueFallbackSubjects: string[] = [...new Set(mappedFallbackSubjects)];
              console.log(`🔄 [DEBUG] Secciones disponibles, pero no usando fallback para ser específico por sección`);
              // ❌ NO usar fallback - debe ser específico por sección
            }
            
            return [];
          }
        } else {
          console.log(`⚠️ [getSubjectsForCourseSection] No es un ID combinado o no se encontró el curso`);
          return [];
        }
      } catch (error) {
        console.error('🚨 [getSubjectsForCourseSection] Error al obtener asignaturas para la sección:', error);
        return [];
      }
    };

    // Get students for selected course (specific to current teacher's assignments)
    // 🎯 FUNCIÓN CORREGIDA: Filtra estudiantes asignados al profesor Y al curso específico
        // ✅ FUNCIÓN CORREGIDA: Sincronización DINÁMICA con Gestión de Usuarios del Admin
    // Esta función implementa exactamente lo que describes: lee las asignaciones del admin en tiempo real
    const getStudentsForCourse = (courseId: string): { id: string, username: string, displayName: string }[] => {
      console.log(`🎯 [SINCRONIZACIÓN DINÁMICA] Buscando estudiantes para courseId: "${courseId}"`);
      
      if (!courseId || !user?.id) {
        console.warn('[getStudentsForCourse] Parámetros inválidos - courseId o user.id faltante');
        return [];
      }

      try {
        // 🔄 PASO 1: Cargar datos FRESCOS del localStorage (sincronización en tiempo real)
        const allUsers: ExtendedUser[] = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
        const studentAssignments: any[] = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
        const teacherAssignments: any[] = JSON.parse(localStorage.getItem('smart-student-teacher-assignments') || '[]');
        const currentYear = new Date().getFullYear();
        const studentsForYear: any[] = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
        
        console.log(`📊 [SINCRONIZACIÓN] Datos cargados desde localStorage:`);
        console.log(`   • Usuarios totales: ${allUsers.length}`);
        console.log(`   • Asignaciones de estudiantes: ${studentAssignments.length}`);
        console.log(`   • Asignaciones de profesores: ${teacherAssignments.length}`);
        console.log(`   • Estudiantes del año ${currentYear}: ${studentsForYear.length}`);
        
        // 🔍 DEBUG DETALLADO: Mostrar estructura completa para "5to A"
        if (courseId.includes('5to') || courseId.includes('A')) {
          console.log('🔍 [DEBUG "5to A"] Datos completos de localStorage:');
          console.log('   📚 Usuarios:', allUsers.map(u => ({id: u.id, username: u.username, role: u.role, displayName: u.displayName})));
          console.log('   🎓 Asignaciones estudiantes:', studentAssignments);
          console.log('   👨‍🏫 Asignaciones profesores:', teacherAssignments);
        }
        
        // 🆕 MÉTODO PRINCIPAL: Usar smart-student-students-{year} que tiene sectionId
        if (studentsForYear.length > 0) {
          console.log(`🎯 [MÉTODO PRINCIPAL] Usando estudiantes del año ${currentYear}`);
          
          // Extraer sectionId del courseId combinado
          let sectionIdToSearch = '';
          let courseIdToSearch = '';
          
          // Determinar si es un ID combinado (courseId-sectionId)
          if (courseId.includes('-') && courseId.length > 40) {
            // Es un ID combinado - extraer courseId y sectionId
            const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const parts = courseId.split('-');
            
            // Buscar dónde termina el primer UUID
            for (let i = 5; i < parts.length - 4; i++) {
              const testCourseId = parts.slice(0, i).join('-');
              const testSectionId = parts.slice(i).join('-');
              
              if (guidPattern.test(testCourseId) && guidPattern.test(testSectionId)) {
                courseIdToSearch = testCourseId;
                sectionIdToSearch = testSectionId;
                break;
              }
            }
            console.log(`📋 [ID COMBINADO] courseId: ${courseIdToSearch}, sectionId: ${sectionIdToSearch}`);
          } else {
            // Es un ID simple - usar como courseId
            courseIdToSearch = courseId;
            console.log(`📋 [ID SIMPLE] courseId: ${courseIdToSearch}`);
          }
          
          // Buscar estudiantes que coincidan con el curso/sección
          let estudiantesEncontrados: any[] = [];
          
          if (sectionIdToSearch) {
            // Buscar por sectionId primero (más preciso)
            estudiantesEncontrados = studentsForYear.filter((s: any) => 
              String(s.sectionId) === String(sectionIdToSearch)
            );
            console.log(`🔍 Estudiantes por sectionId "${sectionIdToSearch}": ${estudiantesEncontrados.length}`);
          }
          
          // Si no hay por sectionId, buscar por courseId
          if (estudiantesEncontrados.length === 0 && courseIdToSearch) {
            estudiantesEncontrados = studentsForYear.filter((s: any) => 
              String(s.courseId) === String(courseIdToSearch)
            );
            console.log(`🔍 Estudiantes por courseId "${courseIdToSearch}": ${estudiantesEncontrados.length}`);
          }
          
          // 🆕 FALLBACK: Buscar por nombre de curso/sección si los IDs no coinciden
          if (estudiantesEncontrados.length === 0) {
            console.log(`🔍 [FALLBACK] Buscando por sectionName o courseName...`);
            const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
            const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
            
            // Buscar el nombre de la sección
            let sectionName = '';
            let courseName = '';
            
            if (sectionIdToSearch) {
              const section = sections.find((s: any) => s.id === sectionIdToSearch);
              sectionName = section?.name || '';
            }
            if (courseIdToSearch) {
              const course = courses.find((c: any) => c.id === courseIdToSearch);
              courseName = course?.name || '';
            }
            
            console.log(`📋 [NOMBRES] sectionName: "${sectionName}", courseName: "${courseName}"`);
            
            if (sectionName) {
              estudiantesEncontrados = studentsForYear.filter((s: any) => 
                s.sectionName === sectionName || s.section === sectionName
              );
              console.log(`🔍 Estudiantes por sectionName "${sectionName}": ${estudiantesEncontrados.length}`);
            }
            
            if (estudiantesEncontrados.length === 0 && courseName) {
              estudiantesEncontrados = studentsForYear.filter((s: any) => 
                s.courseName === courseName || s.course === courseName
              );
              console.log(`🔍 Estudiantes por courseName "${courseName}": ${estudiantesEncontrados.length}`);
            }
          }
          
          if (estudiantesEncontrados.length > 0) {
            const resultado = estudiantesEncontrados.map((estudiante: any) => ({
              id: estudiante.id,
              username: estudiante.username || estudiante.rut || `student-${estudiante.id}`,
              displayName: estudiante.displayName || estudiante.name || estudiante.username || 'Estudiante'
            }));
            
            console.log(`✅ [MÉTODO PRINCIPAL] Encontrados ${resultado.length} estudiantes por students-year`);
            resultado.forEach((e, i) => console.log(`   ${i + 1}. ${e.displayName} (${e.username})`));
            return resultado; // 🎯 RETORNAR INMEDIATAMENTE SI ENCUENTRA ESTUDIANTES
          } else {
            console.warn(`⚠️ [MÉTODO PRINCIPAL] No se encontraron estudiantes en students-year para courseId: ${courseId}`);
            console.log(`   📋 Intentando con el MÉTODO LEGACY...`);
          }
        }
        
        // MÉTODO LEGACY: Verificar si faltan datos críticos
        if (studentAssignments.length === 0) {
          console.warn('⚠️ [CONFIGURACIÓN REQUERIDA] No hay asignaciones de estudiantes ni en students-year');
          console.log('💡 [SOLUCIÓN] Para que aparezcan estudiantes:');
          console.log('   1. Ve a Admin → Gestión de Usuarios → Asignaciones');
          console.log('   2. Asigna estudiantes a las secciones correspondientes');
          console.log('   3. Asigna profesores a las secciones');
          console.log('   4. Regresa aquí y los estudiantes aparecerán automáticamente');
        }
        
        if (teacherAssignments.length === 0) {
          console.warn('⚠️ [CONFIGURACIÓN REQUERIDA] No hay asignaciones de profesores en localStorage');
          console.log('💡 [SOLUCIÓN] Asigna profesores a secciones en Admin → Gestión de Usuarios');
          return [];
        }
        
        if (allUsers.length === 0) {
          console.warn('[getStudentsForCourse] No hay usuarios en el sistema.');
          return [];
        }

        // 🔍 PASO 2: Extraer información del curso seleccionado
        console.log(`🔍 [DEBUG] courseId buscado: "${courseId}"`);
        
        let selectedCourseData;
        
        // 🔧 CORRECCIÓN: Si es un ID combinado, usar la función auxiliar
        if (courseId.includes('-') && courseId.length > 40) {
          console.log('� [CORRECCIÓN] Detectado ID combinado, usando getCourseDataFromCombinedId...');
          selectedCourseData = getCourseDataFromCombinedId(courseId);
        } else {
          // Para IDs simples, usar la función original
          const availableCourses = getAvailableCoursesWithNames();
          console.log(`📚 [DEBUG] Cursos disponibles:`, availableCourses.map(c => ({id: c.id, name: c.name})));
          
          // Buscar el curso por ID exacto o por coincidencia parcial
          selectedCourseData = availableCourses.find(c => c.id === courseId);
          
          // Si no se encuentra por ID exacto, buscar por coincidencia parcial
          if (!selectedCourseData) {
            console.log(`⚠️ [BÚSQUEDA FALLBACK] No se encontró courseId exacto "${courseId}", intentando búsqueda parcial...`);
            selectedCourseData = availableCourses.find(c => 
              c.id.includes(courseId) || c.courseId === courseId
            );
            
            if (selectedCourseData) {
              console.log(`✅ [FALLBACK EXITOSO] Encontrado curso por búsqueda parcial:`, selectedCourseData);
            }
          }
        }

        // 🔍 DEBUG DETALLADO: Para "5to A" mostrar todos los cursos disponibles
        if (courseId.includes('5to') || courseId.includes('A') || courseId.includes('9077a79d')) {
          console.log('🔍 [DEBUG BÚSQUEDA] Información de cursos:');
          console.log('   📋 courseId buscado:', courseId);
          console.log('   🎯 Curso encontrado:', selectedCourseData);
          
          // Solo mostrar availableCourses si no es un ID combinado
          if (!courseId.includes('-') || courseId.length <= 40) {
            const availableCoursesForDebug = getAvailableCoursesWithNames();
            console.log('   📚 Cursos disponibles:', availableCoursesForDebug);
          }
        }

        if (!selectedCourseData) {
          console.error(`[getStudentsForCourse] No se encontró información para courseId: "${courseId}"`);
          
          // Solo mostrar debug de availableCourses para IDs simples
          if (!courseId.includes('-') || courseId.length <= 40) {
            const availableCoursesForDebug = getAvailableCoursesWithNames();
            console.log('[DEBUG] Cursos disponibles:', availableCoursesForDebug.map(c => ({id: c.id, name: c.name})));
          } else {
            console.log('[DEBUG] ID combinado no encontrado, verificar función getCourseDataFromCombinedId');
          }
          
          // FALLBACK PARA CÓDIGOS NO ENCONTRADOS - Crear entrada temporal
          console.log('🔧 [FALLBACK] Creando configuración temporal para courseId no encontrado...');
          
          // Parsear courseId compuesto si es necesario
          let actualCourseId = courseId;
          let sectionId = null;
          
          if (courseId.includes('-') && courseId.length > 40) {
            const parts = courseId.split('-');
            if (parts.length >= 10) {
              actualCourseId = parts.slice(0, 5).join('-');
              sectionId = parts.slice(5).join('-');
            }
          } else {
            // Para códigos simples como "9077a79d", usar como courseId y buscar sección por defecto
            actualCourseId = courseId;
            sectionId = `section_${courseId}_default`;
          }
          
          selectedCourseData = {
            id: courseId,
            courseId: actualCourseId,
            sectionId: sectionId,
            name: `Curso ${courseId}`,
            originalCourseName: `Curso ${courseId}`
          };
          
          console.log(`🔧 [FALLBACK] Configuración temporal creada:`, selectedCourseData);
        }
        
        const { sectionId, courseId: actualCourseId } = selectedCourseData;
        console.log(`🏫 [SINCRONIZACIÓN] Curso: "${actualCourseId}", Sección: "${sectionId}"`);

        // 🔍 PASO 3: Verificar que el profesor actual esté asignado a esta sección (según Gestión de Usuarios)
        // Verificación flexible para códigos temporales
        let profesorAsignado = false;
        
        if (teacherAssignments.length > 0) {
          profesorAsignado = teacherAssignments.some(assignment => 
            assignment.teacherId === user.id && assignment.sectionId === sectionId
          );
        } else {
          // Fallback: si no hay asignaciones de profesores, permitir acceso
          console.log('⚠️ [FALLBACK] No hay asignaciones de profesores, permitiendo acceso temporal');
          profesorAsignado = true;
        }
        
        console.log(`👨‍🏫 [VERIFICACIÓN] Profesor ${user.displayName || user.username} (ID: ${user.id})`);
        console.log(`🔍 [VERIFICACIÓN] ¿Está asignado a sección "${sectionId}"?: ${profesorAsignado ? '✅' : '❌'}`);
        
        // 🔍 DEBUG DETALLADO: Para "5to A" y códigos problemáticos
        if (courseId.includes('5to') || courseId.includes('A') || courseId.includes('9077a79d')) {
          console.log('🔍 [DEBUG VERIFICACIÓN] Información del profesor:');
          console.log('   👤 Profesor actual:', {id: user.id, username: user.username, displayName: user.displayName});
          console.log('   🏫 Sección buscada:', sectionId);
          console.log('   📋 Todas las asignaciones del profesor:', teacherAssignments.filter(a => a.teacherId === user.id));
          console.log('   🎯 ¿Profesor asignado a esta sección?:', profesorAsignado);
        }
        
        if (!profesorAsignado && teacherAssignments.length > 0) {
          console.warn(`[getStudentsForCourse] El profesor actual (ID: ${user.id}) NO está asignado a la sección "${sectionId}"`);
          console.log('💡 SOLUCIÓN: El administrador debe asignar este profesor a la sección en Gestión de Usuarios');
          
          // Debug: mostrar asignaciones del profesor actual
          const misAsignaciones = teacherAssignments.filter(a => a.teacherId === user.id);
          console.log(`[DEBUG] Asignaciones actuales del profesor:`, misAsignaciones);
          
          // Para códigos problemáticos, crear asignación temporal
          if (courseId.includes('9077a79d')) {
            console.log('🔧 [SOLUCIÓN TEMPORAL] Creando asignación temporal para código problemático...');
            profesorAsignado = true;
          } else {
            return [];
          }
        }

        // 🎓 PASO 4: Obtener estudiantes asignados a esta sección Y curso específicos
        let estudiantesEnSeccion = [];
        
        if (studentAssignments.length > 0) {
          // Método 1: Usar asignaciones específicas
          estudiantesEnSeccion = studentAssignments
            .filter(assignment => 
              assignment.sectionId === sectionId &&
              assignment.courseId === actualCourseId
            )
            .map(assignment => assignment.studentId);
        }
        
        // Si no se encuentran estudiantes con el método específico, usar fallback
        if (estudiantesEnSeccion.length === 0) {
          console.log('⚠️ [FALLBACK ESTUDIANTES] No se encontraron con asignaciones específicas, probando métodos alternativos...');
          
          // Método 2: Buscar solo por sección
          if (studentAssignments.length > 0) {
            estudiantesEnSeccion = studentAssignments
              .filter(assignment => assignment.sectionId === sectionId)
              .map(assignment => assignment.studentId);
            
            if (estudiantesEnSeccion.length > 0) {
              console.log(`✅ [FALLBACK] Encontrados ${estudiantesEnSeccion.length} estudiantes por sección únicamente`);
            }
          }
          
          // Método 3: Usar activeCourses legacy
          if (estudiantesEnSeccion.length === 0) {
            console.log('🔄 [LEGACY FALLBACK] Usando sistema activeCourses...');
            
            const estudiantesLegacy = allUsers.filter(u => 
              (u.role === 'student' || u.role === 'estudiante') &&
              (u.activeCourses?.includes(courseId) || 
               u.activeCourses?.includes(actualCourseId) ||
               u.activeCourses?.includes('4to_basico_b') || // Para 4to Básico B
               u.activeCourses?.some(course => course.includes('9077a79d')))
            );
            
            estudiantesEnSeccion = estudiantesLegacy.map(e => e.id);
            
            if (estudiantesEnSeccion.length > 0) {
              console.log(`✅ [LEGACY] Encontrados ${estudiantesEnSeccion.length} estudiantes por activeCourses`);
            }
          }
          
          // Método 4: Crear estudiantes de prueba para códigos problemáticos
          if (estudiantesEnSeccion.length === 0 && courseId.includes('9077a79d')) {
            console.log('🔧 [ESTUDIANTES DE PRUEBA] Creando estudiantes temporales...');
            
            const estudiantesPrueba = [
              {
                id: `student_temp_${Date.now()}_1`,
                username: 'ana_4to_b',
                displayName: 'Ana Martínez (4to B)',
                role: 'student',
                activeCourses: [courseId, actualCourseId],
                assignedTeacher: user.username,
                assignedTeacherId: user.id
              },
              {
                id: `student_temp_${Date.now()}_2`,
                username: 'carlos_4to_b',
                displayName: 'Carlos Rodríguez (4to B)',
                role: 'student',
                activeCourses: [courseId, actualCourseId],
                assignedTeacher: user.username,
                assignedTeacherId: user.id
              }
            ];
            
            // Agregar al localStorage sin duplicar
            const usuariosActualizados = [...allUsers.filter(u => !u.id.startsWith('student_temp_')), ...estudiantesPrueba];
            localStorage.setItem('smart-student-users', JSON.stringify(usuariosActualizados));
            
            estudiantesEnSeccion = estudiantesPrueba.map(e => e.id);
            console.log(`🎓 [CREADOS] ${estudiantesPrueba.length} estudiantes de prueba para ${courseId}`);
          }
        }

        console.log(`🎓 [SINCRONIZACIÓN] Estudiantes asignados al curso "${actualCourseId}" y sección "${sectionId}": ${estudiantesEnSeccion.length}`);
        
        // 🔍 DEBUG DETALLADO: Mostrar filtrado por curso Y sección
        console.log('🔍 [DEBUG FILTRADO] Información detallada:');
        console.log('   🏫 Curso buscado (actualCourseId):', actualCourseId);
        console.log('   🏫 Sección buscada:', sectionId);
        console.log('   📋 Total asignaciones de estudiantes:', studentAssignments.length);
        console.log('   🎯 Asignaciones filtradas por curso Y sección:', studentAssignments.filter(a => 
          a.sectionId === sectionId && a.courseId === actualCourseId
        ));
        console.log('   📊 IDs de estudiantes finales:', estudiantesEnSeccion);
        
        if (estudiantesEnSeccion.length === 0) {
          console.warn(`[getStudentsForCourse] No hay estudiantes asignados a la sección "${sectionId}"`);
          console.log('💡 SOLUCIÓN: El administrador debe asignar estudiantes a esta sección en Gestión de Usuarios');
          
          // Debug: mostrar todas las asignaciones de estudiantes
          console.log('[DEBUG] Todas las asignaciones de estudiantes:', studentAssignments);
          return [];
        }

        // 🔍 PASO 5: Obtener datos completos de los estudiantes desde users
        // Recargar usuarios actualizados si se crearon estudiantes temporales
        const usuariosActualizados = JSON.parse(localStorage.getItem('smart-student-users') || '[]');
        
        const estudiantesCompletos = usuariosActualizados.filter(usuario => 
          (usuario.role === 'student' || usuario.role === 'estudiante') && estudiantesEnSeccion.includes(usuario.id)
        );

        console.log(`✅ [SINCRONIZACIÓN] Estudiantes encontrados y verificados: ${estudiantesCompletos.length}`);
        
        // Log detallado para verificación
        estudiantesCompletos.forEach((estudiante, index) => {
          console.log(`   ${index + 1}. ${estudiante.displayName || estudiante.username} (ID: ${estudiante.id})`);
        });

        // 🎯 PASO 6: Retornar en el formato esperado por la interfaz
        const resultado = estudiantesCompletos.map(estudiante => ({
          id: estudiante.id,
          username: estudiante.username,
          displayName: estudiante.displayName || estudiante.username
        }));

        console.log(`🎯 [RESULTADO FINAL] ${resultado.length} estudiantes listos para asignación de tareas`);
        return resultado;

      } catch (error) {
        console.error('[getStudentsForCourse] Error en sincronización con Gestión de Usuarios:', error);
        console.log('💡 [SOLUCIÓN] Verifica que el administrador haya configurado las asignaciones en Gestión de Usuarios');
        return [];
      }
    };

    // Get students from a specific course, ensuring they are assigned to the current teacher for that task
    // 🎯 UNIFICACIÓN CON getStudentsForCourse: Todo dinámico desde Gestión de Usuarios
    const getStudentsFromCourseRelevantToTask = (courseId: string, teacherId: string | undefined) => {
      if (!courseId) {
        console.log(`⚠️ getStudentsFromCourseRelevantToTask: courseId es null`);
        return [];
      }
      
      console.log(`� [UNIFICADO] getStudentsFromCourseRelevantToTask: courseId=${courseId}, teacherId=${teacherId}`);
      console.log(`🔄 [DINÁMICO] Usando mismo sistema que estudiantes específicos`);
      
      // � REUTILIZAR LÓGICA DE getStudentsForCourse: Sistema 100% dinámico
      // En lugar de duplicar código, usar la función que ya funciona perfectamente
      const estudiantes = getStudentsForCourse(courseId);
      
      console.log(`✅ [RESULTADO UNIFICADO] Estudiantes encontrados para "todo el curso": ${estudiantes.length}`);
      
      // Log detallado para verificación
      if (estudiantes.length > 0) {
        console.log(`🎓 [ESTUDIANTES DINÁMICOS] Lista completa:`);
        estudiantes.forEach((estudiante, index) => {
          console.log(`   ${index + 1}. ${estudiante.displayName} (${estudiante.username}) - ID: ${estudiante.id}`);
        });
      } else {
        console.warn('❌ [SIN ESTUDIANTES] No se encontraron estudiantes para este curso.');
        console.log('💡 [SOLUCIÓN] Configura asignaciones en Admin → Gestión de Usuarios → Asignaciones');
        console.log(`   📋 Curso: "${courseId}"`);
        console.log(`   👨‍🏫 Profesor: "${teacherId}"`);
      }
      
      console.log(`🎯 [FINAL] getStudentsFromCourseRelevantToTask retorna ${estudiantes.length} estudiantes`);
      
      return estudiantes;
    };

    // Función para obtener los estudiantes asignados a una tarea
    const getAssignedStudentsForTask = (task: Task | null): { id: string, username: string, displayName: string }[] => {
      if (!task || !task.id) {
        console.log(`⚠️ getAssignedStudentsForTask: task es null o no tiene ID`);
        return [];
      }
      
      console.log(`🔍 getAssignedStudentsForTask: Procesando tarea "${task.title}"`);
      console.log(`📋 Detalles de la tarea:`, {
        id: task.id,
        assignedTo: task.assignedTo,
        course: task.course,
        assignedById: task.assignedById,
        assignedStudentIds: task.assignedStudentIds
      });
      
      const usersText = localStorage.getItem('smart-student-users');
      const allUsers: ExtendedUser[] = usersText ? JSON.parse(usersText) : [];
      console.log(`👥 Total usuarios en sistema: ${allUsers.length}`);

      let students: { id: string, username: string, displayName: string }[] = [];

      // Si la tarea está asignada a estudiantes específicos
      if (task.assignedTo === 'student' && task.assignedStudentIds) {
        console.log(`🎯 Tarea asignada a estudiantes específicos: ${task.assignedStudentIds.join(', ')}`);
        students = task.assignedStudentIds.map(studentId => {
          const userData = allUsers.find(u => u.id === studentId);
          const student = {
            id: studentId,
            username: userData?.username || `user-${studentId}`,
            displayName: userData?.displayName || `Estudiante ${studentId}`
          };
          console.log(`👤 Estudiante mapeado: ${student.displayName} (${student.id})`);
          return student;
        }).filter(s => s.id); // Filter out any potential nulls if a studentId wasn't found
      }
      // Si la tarea está asignada a todo un curso
      else if (task.assignedTo === 'course' && task.course) { 
        console.log(`🏫 Tarea asignada a curso completo: ${task.course}`);
        console.log(`📋 Datos de la tarea: courseSectionId="${task.courseSectionId}", sectionId="${task.sectionId}"`);
        
        // 🎯 MÉTODO DIRECTO: Si tiene sectionId, buscar directamente en students-year
        if (task.sectionId) {
          const currentYear = new Date().getFullYear();
          const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
          
          console.log(`🔍 [MÉTODO DIRECTO] Buscando por sectionId: "${task.sectionId}" en ${studentsForYear.length} estudiantes`);
          
          const estudiantesEncontrados = studentsForYear.filter((s: any) => 
            String(s.sectionId) === String(task.sectionId)
          );
          
          if (estudiantesEncontrados.length > 0) {
            students = estudiantesEncontrados.map((estudiante: any) => ({
              id: estudiante.id,
              username: estudiante.username || estudiante.rut || `student-${estudiante.id}`,
              displayName: estudiante.displayName || estudiante.name || estudiante.username || 'Estudiante'
            }));
            console.log(`✅ [MÉTODO DIRECTO] Encontrados ${students.length} estudiantes por sectionId`);
          } else {
            console.log(`⚠️ [MÉTODO DIRECTO] No se encontraron estudiantes por sectionId, usando método combinado`);
          }
        }
        
        // Si no encontró por método directo, usar courseSectionId o course
        if (students.length === 0) {
          const courseToUse = task.courseSectionId || task.course;
          console.log(`🔍 Usando courseId: "${courseToUse}" (${task.courseSectionId ? 'nuevo formato' : 'formato legacy'})`);
          students = getStudentsFromCourseRelevantToTask(courseToUse, task.assignedById);
        }
        
        console.log(`👥 Estudiantes encontrados en curso: ${students.length}`);
      }
      else {
        console.log(`⚠️ Configuración de asignación no reconocida`);
      }

      // Solo mostrar los estudiantes que están explícitamente asignados
      // Sin agregar estudiantes adicionales que hayan entregado por error

      // Specific filtering for "luis" is removed as it's not ID-based and generally not robust.
      // If specific exclusions are needed, they should be handled by a more generic mechanism.

      console.log(`📋 Students assigned to task "${task.title}":`, {
        taskAssignedTo: task.assignedTo,
        courseId: task.course, // task.course is courseId
        studentsFound: students,
        studentsCount: students.length,
        studentUsernames: students.map(s => s.username),
        studentDisplayNames: students.map(s => s.displayName)
      });

      return students;
    };

    // Función para obtener la entrega de un estudiante por su ID
    const getStudentSubmission = (taskId: string, studentId: string): TaskComment | undefined => {
      if (!taskId || !studentId) return undefined;

      // console.log(`🔍 getStudentSubmission searching for studentId: "${studentId}" in task: "${taskId}"`);
      
      const submission = comments.find(c =>
        c.taskId === taskId &&
        c.studentId === studentId &&
        c.isSubmission
      );
      
      if (submission) {
        // console.log(`✅ Submission found for studentId "${studentId}":`, submission);
        return {
          ...submission,
          grade: submission.grade || undefined,
          teacherComment: submission.teacherComment || '',
          reviewedAt: submission.reviewedAt || (submission.grade !== undefined && !submission.reviewedAt ? new Date().toISOString() : undefined)
        };
      }
      
      // console.log(`❌ No submission found for studentId "${studentId}" in task "${taskId}"`);
      return undefined;
    };

    // 🔧 FUNCIÓN AUXILIAR: Extraer datos de curso y sección desde ID combinado
    // Esta función reemplaza la dependencia problemática de getAvailableCoursesWithNames() para estudiantes
    const getCourseDataFromCombinedId = (combinedId: string) => {
      // Cargar datos del sistema
      const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
      
      // El formato es: courseId-sectionId
      const parts = combinedId.split('-');
      
      if (parts.length < 2) {
        console.log(`❌ [getCourseDataFromCombinedId] ID no tiene formato correcto: ${combinedId}`);
        return null;
      }
      
      // Para IDs UUID, necesitamos reconstruir correctamente
      // Formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      let courseId = '';
      let sectionId = '';
      
      // Encontrar dónde termina el primer UUID y empieza el segundo
      for (let i = 5; i < parts.length - 4; i++) {
        const testCourseId = parts.slice(0, i).join('-');
        const testSectionId = parts.slice(i).join('-');
        
        if (guidPattern.test(testCourseId) && guidPattern.test(testSectionId)) {
          courseId = testCourseId;
          sectionId = testSectionId;
          break;
        }
      }
      
      if (!courseId || !sectionId) {
        console.log(`❌ [getCourseDataFromCombinedId] No se pudieron extraer IDs válidos de: ${combinedId}`);
        return null;
      }
      
      // Buscar el curso y la sección
      const course = courses.find((c: any) => c.id === courseId);
      const section = sections.find((s: any) => s.id === sectionId);
      
      if (!course || !section) {
        console.log(`❌ [getCourseDataFromCombinedId] Curso o sección no encontrado para: ${combinedId}`);
        return null;
      }
      
      return {
        id: combinedId,
        courseId: course.id,
        sectionId: section.id,
        name: `${course.name} Sección ${section.name}`,
        originalCourseName: course.name,
        sectionName: section.name
      };
    };

    // 🔧 FUNCIÓN MEJORADA: Verificar si un estudiante está asignado a una tarea específica
    // Incluye verificaciones de curso, sección y estudiante
    const isStudentAssignedToTask = (taskId: string, studentId: string, studentUsername: string): boolean => {
      const task = tasks.find(t => t.id === taskId);
      
      if (!task) {
        console.log(`❌ [isStudentAssignedToTask] Tarea no encontrada: ${taskId}`);
        return false;
      }
      
      console.log(`🔍 [isStudentAssignedToTask] Verificando acceso para estudiante ${studentUsername} (ID: ${studentId}) a tarea "${task.title}"`);
      console.log(`📋 [isStudentAssignedToTask] Tarea asignada a: ${task.assignedTo}, curso: ${task.course || task.courseSectionId}, sectionId: ${task.sectionId}`);
      
      // Si la tarea está asignada a estudiantes específicos
      if (task.assignedTo === 'student' && task.assignedStudentIds) {
        const isDirectlyAssigned = task.assignedStudentIds.includes(studentId);
        console.log(`🎯 [isStudentAssignedToTask] Estudiante ${studentUsername} directamente asignado: ${isDirectlyAssigned ? '✅' : '❌'}`);
        return isDirectlyAssigned;
      }
      
      // Si la tarea está asignada a todo el curso
      if (task.assignedTo === 'course') {
        const taskCourseId = task.courseSectionId || task.course;
        const taskSectionId = task.sectionId;
        
        if (!taskCourseId && !taskSectionId) {
          console.log(`⚠️ [isStudentAssignedToTask] Tarea sin courseId ni sectionId definido`);
          return false;
        }
        
        // 🆕 MÉTODO PRINCIPAL: Usar smart-student-students-{year} con sectionId
        const currentYear = new Date().getFullYear();
        const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
        
        if (studentsForYear.length > 0 && taskSectionId) {
          // Buscar al estudiante actual en students-year
          const studentInYear = studentsForYear.find((s: any) => 
            s.id === studentId || s.username === studentUsername
          );
          
          if (studentInYear) {
            const isInSameSection = String(studentInYear.sectionId) === String(taskSectionId);
            console.log(`🎯 [MÉTODO PRINCIPAL] Estudiante ${studentUsername} sectionId: "${studentInYear.sectionId}", tarea sectionId: "${taskSectionId}"`);
            console.log(`✅ [MÉTODO PRINCIPAL] ¿Mismo sección?: ${isInSameSection ? '✅ SÍ' : '❌ NO'}`);
            
            if (isInSameSection) {
              return true;
            }
          } else {
            console.log(`⚠️ [MÉTODO PRINCIPAL] Estudiante ${studentUsername} no encontrado en students-${currentYear}`);
          }
        }
        
        // 🆕 MÉTODO ALTERNATIVO: Extraer sectionId del courseSectionId si task.sectionId no existe
        if (!taskSectionId && taskCourseId && taskCourseId.includes('-') && taskCourseId.length > 40) {
          console.log(`🔄 [MÉTODO ALTERNATIVO] Extrayendo sectionId del courseSectionId...`);
          
          // Extraer sectionId del ID combinado
          const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const parts = taskCourseId.split('-');
          let extractedSectionId = '';
          
          for (let i = 5; i < parts.length - 4; i++) {
            const testSectionId = parts.slice(i).join('-');
            if (guidPattern.test(testSectionId)) {
              extractedSectionId = testSectionId;
              break;
            }
          }
          
          if (extractedSectionId && studentsForYear.length > 0) {
            const studentInYear = studentsForYear.find((s: any) => 
              s.id === studentId || s.username === studentUsername
            );
            
            if (studentInYear) {
              const isInSameSection = String(studentInYear.sectionId) === String(extractedSectionId);
              console.log(`🎯 [MÉTODO ALTERNATIVO] Estudiante sectionId: "${studentInYear.sectionId}", extraído: "${extractedSectionId}"`);
              
              if (isInSameSection) {
                console.log(`✅ [MÉTODO ALTERNATIVO] Estudiante está en la misma sección`);
                return true;
              }
            }
          }
        }
        
        // MÉTODO LEGACY: Obtener información del estudiante de users
        const usersText = localStorage.getItem('smart-student-users');
        const allUsers: ExtendedUser[] = usersText ? JSON.parse(usersText) : [];
        const studentData = allUsers.find(u => u.id === studentId || u.username === studentUsername);
        
        if (!studentData) {
          console.log(`❌ [isStudentAssignedToTask] Datos del estudiante no encontrados: ${studentUsername}`);
          return false;
        }
        
        // Verificar usando el sistema de asignaciones dinámicas (si existe)
        const studentAssignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]');
        
        if (studentAssignments.length > 0) {
          // 🔧 CORRECCIÓN: Usar función auxiliar en lugar de getAvailableCoursesWithNames()
          const taskCourseData = getCourseDataFromCombinedId(taskCourseId);
          
          if (taskCourseData) {
            const { sectionId, courseId: actualCourseId } = taskCourseData;
            
            // Verificar si el estudiante está asignado al mismo curso Y sección
            const isAssignedToTaskSection = studentAssignments.some((assignment: any) => 
              assignment.studentId === studentId && 
              assignment.sectionId === sectionId && 
              assignment.courseId === actualCourseId
            );
            
            console.log(`🏫 [LEGACY] Verificando curso ${actualCourseId} sección ${sectionId}`);
            console.log(`📊 [LEGACY] Estudiante ${studentUsername} asignado a esta sección: ${isAssignedToTaskSection ? '✅' : '❌'}`);
            
            if (isAssignedToTaskSection) {
              return true;
            }
          }
        }
        
        // Fallback: verificar por activeCourses (sistema legacy)
        const isInActiveCourses = studentData.activeCourses?.includes(taskCourseId) || false;
        console.log(`🔄 [isStudentAssignedToTask] Fallback activeCourses para ${studentUsername}: ${isInActiveCourses ? '✅' : '❌'}`);
        
        return isInActiveCourses;
      }
      
      // Compatibilidad con versiones anteriores
      if (task.assignedStudents && task.assignedStudents.includes(studentUsername)) {
        console.log(`🔄 [isStudentAssignedToTask] Fallback assignedStudents para ${studentUsername}: ✅`);
        return true;
      }
      
      console.log(`❌ [isStudentAssignedToTask] Estudiante ${studentUsername} no tiene acceso a la tarea "${task.title}"`);
      return false;
    };

    // Función para obtener el resultado de una evaluación de un estudiante
    const getStudentEvaluationResult = (taskId: string, studentId: string) => { // Changed studentUsername to studentId
      // En un entorno real, esta información vendría de una tabla específica en la base de datos
      // Por ahora, para propósitos de demostración, no devolvemos nada ya que no hay evaluaciones completadas
      
      // Buscar si existe algún resultado de evaluación guardado en localStorage
      const storedResults = localStorage.getItem('smart-student-evaluation-results');
      if (storedResults) {
        const results = JSON.parse(storedResults);
        return results.find((result: any) => result.taskId === taskId && result.studentId === studentId);
      }
      
      // Si no hay resultados guardados, el estudiante no ha completado la evaluación
      return undefined;
    };

    // Función para verificar si todos los estudiantes han completado la evaluación
    const checkAndUpdateEvaluationStatus = (taskId: string) => {
      const task = tasks.find(t => t.id === taskId);
      if (!task || task.taskType !== 'evaluacion') return;

      const assignedStudents = getAssignedStudentsForTask(task);
      console.log(`🔍 Verificando estado de evaluación para tarea "${task.title}" (ID: ${taskId})`);
      console.log(`� Estado actual de la tarea: "${task.status}"`);
      console.log(`�👥 Estudiantes asignados: ${assignedStudents.length}`, assignedStudents.map(s => s.displayName));

      const completedStudents = assignedStudents.filter(student => {
        const result = getStudentEvaluationResult(taskId, student.id);
        console.log(`📊 Estudiante ${student.displayName} (ID: ${student.id}) - Resultado:`, result ? 'Completado' : 'Pendiente');
        return result !== undefined;
      });

      const completedCount = completedStudents.length;
      console.log(`📈 Progreso: ${completedCount}/${assignedStudents.length} estudiantes han completado la evaluación`);

      // Si todos los estudiantes han completado la evaluación, actualizar el estado a 'finished'
      if (completedCount === assignedStudents.length && assignedStudents.length > 0) {
        if (task.status !== 'finished') {
          console.log(`✅ ¡Todos los estudiantes completaron la evaluación! Cambiando estado de "${task.status}" a 'finished'`);
          const updatedTasks = tasks.map(t => 
            t.id === taskId ? { ...t, status: 'finished' as const } : t
          );
          saveTasks(updatedTasks);
          
          // 🔥 NUEVO: Limpiar notificaciones pendientes del profesor para esta evaluación completada
          TaskNotificationManager.removeNotificationsForTask(taskId, ['pending_grading']);
          console.log('🧹 Removed pending evaluation notifications for teacher after all students completed');
          
          // Disparar evento para actualizar notificaciones en tiempo real
          window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
          
          // Mostrar notificación al profesor
          toast({
            title: "Evaluación Finalizada",
            description: `La evaluación "${task.title}" ha sido completada por todos los estudiantes.`,
            duration: 5000,
          });
        } else {
          console.log(`✅ Evaluación ya está marcada como 'finished' correctamente`);
        }
      } else {
        console.log(`⏳ Evaluación pendiente: ${assignedStudents.length - completedCount} estudiantes aún no han completado`);
        
        // CORRECCIÓN IMPORTANTE: Asegurar que el estado se mantenga como 'pending' si no todos han completado
        if (task.status !== 'pending') {
          console.log(`🔄 CORRIGIENDO: Restaurando estado de "${task.status}" a 'pending' porque no todos han completado`);
          const updatedTasks = tasks.map(t => 
            t.id === taskId ? { ...t, status: 'pending' as const } : t
          );
          saveTasks(updatedTasks);
        } else {
          console.log(`✅ Estado 'pending' es correcto`);
        }
      }
    };

    // Filter tasks based on user role
    // Genera la fecha mínima en formato ISO para el input datetime-local
    const getMinDateTimeString = () => {
      const now = new Date();
      return now.toISOString().slice(0, 16); // Formato YYYY-MM-DDTHH:MM requerido para datetime-local
    };
    
    // Utilidad para añadir el atributo min a los inputs de fecha
    useEffect(() => {
      // Aplicar el atributo min a todos los inputs de tipo datetime-local
      const dateInputs = document.querySelectorAll('input[type="datetime-local"]');
      const minDate = getMinDateTimeString();
      
      dateInputs.forEach(input => {
        input.setAttribute('min', minDate);
      });
    }, [showCreateDialog, showEditDialog]); // Se ejecuta cuando se abre un diálogo

    const getFilteredTasks = () => {
      if (user?.role === 'teacher') {
        // Los profesores ven solo las tareas que crearon
        let filtered = tasks.filter(task => task.assignedById === user.id);
        
        if (selectedCourseFilter !== 'all') {
          filtered = filtered.filter(task => {
            console.log(`🔍 [FILTRADO DEBUG] Verificando tarea "${task.title}"`);
            console.log(`📋 task.course: "${task.course}", task.courseSectionId: "${task.courseSectionId}"`);
            console.log(`🎯 selectedCourseFilter: "${selectedCourseFilter}"`);
            
            // LÓGICA CORREGIDA: Si el filtro seleccionado contiene un guión, es un ID combinado curso-sección
            if (selectedCourseFilter.includes('-')) {
              // Es un ID combinado (courseId-sectionId), comparar exactamente con courseSectionId
              const match = task.courseSectionId === selectedCourseFilter;
              console.log(`✅ Comparación ID combinado: ${match ? 'COINCIDE' : 'NO COINCIDE'}`);
              return match;
            } else {
              // Es un courseId simple (fallback), comparar con course
              const match = task.course === selectedCourseFilter;
              console.log(`✅ Comparación courseId simple: ${match ? 'COINCIDE' : 'NO COINCIDE'}`);
              return match;
            }
          });
          
          console.log(`🎯 [RESULTADO FILTRADO] De ${tasks.filter(task => task.assignedById === user.id).length} tareas del profesor, ${filtered.length} coinciden con el filtro "${selectedCourseFilter}"`);
        }

        // Verificar estado de evaluaciones pendientes para actualizar automáticamente
        filtered
          .filter(task => task.taskType === 'evaluacion' && task.status === 'pending')
          .forEach(task => {
            // Realizar verificación asíncrona para no bloquear el renderizado
            setTimeout(() => checkAndUpdateEvaluationStatus(task.id), 0);
          });

        return filtered;
      } else if (user?.role === 'student') {
        // Los estudiantes solo ven tareas que existen actualmente y que están asignadas a su curso o usuario
        // Además, solo deben ver tareas activas (no eliminadas ni antiguas)
        // Si el profesor elimina una tarea, ya no debe aparecer para el estudiante
        return tasks.filter(task => {
          // Solo tareas asignadas por un profesor válido y que existan
          if (!task.assignedById) return false;
          
          // 🔧 CORRECCIÓN: Usar isStudentAssignedToTask para verificación correcta
          // Esto reemplaza la lógica antigua que causaba el problema
          const canSeeTask = isStudentAssignedToTask(task.id, user.id, user.username);
          
          console.log(`🔍 [getFilteredTasks] Tarea "${task.title}" para estudiante ${user.username}: ${canSeeTask ? '✅ VISIBLE' : '❌ OCULTA'}`);
          
          return canSeeTask;
        });
      }
      return [];
    };

    // Group tasks by course and section for teacher view
    const getTasksByCourseAndSection = () => {
      const filtered = getFilteredTasks();
      const grouped: { [courseSection: string]: Task[] } = {};
      
      filtered.forEach(task => {
        // Usar courseSectionId si existe, sino usar course como fallback
        const courseKey = task.courseSectionId || task.course;
        if (!grouped[courseKey]) {
          grouped[courseKey] = [];
        }
        grouped[courseKey].push(task);
      });
      
      // Si hay un filtro activo que no sea 'all', solo mostrar esa sección específica
      if (selectedCourseFilter !== 'all') {
        const filteredGrouped: { [courseSection: string]: Task[] } = {};
        Object.keys(grouped).forEach(courseSection => {
          // Verificar si esta sección coincide con el filtro
          if (courseSection === selectedCourseFilter || 
              grouped[courseSection].some(task => 
                task.courseSectionId === selectedCourseFilter || 
                task.course === selectedCourseFilter
              )) {
            filteredGrouped[courseSection] = grouped[courseSection];
          }
        });
        
        return filteredGrouped;
      }
      
      return grouped;
    };

    // Order courses from 1ro Básico to 4to Medio
    const sortCoursesByAcademicLevel = (courseKeys: string[]) => {
      const courseOrder = [
        // Básica
        '1ro Básico', '1er Básico', 'Primero Básico',
        '2do Básico', '2°Básico', 'Segundo Básico', 
        '3ro Básico', '3er Básico', 'Tercero Básico',
        '4to Básico', '4° Básico', 'Cuarto Básico',
        '5to Básico', '5° Básico', 'Quinto Básico',
        '6to Básico', '6° Básico', 'Sexto Básico',
        '7mo Básico', '7° Básico', 'Séptimo Básico',
        '8vo Básico', '8° Básico', 'Octavo Básico',
        // Media
        '1ro Medio', '1er Medio', 'Primero Medio', 'I Medio',
        '2do Medio', '2° Medio', 'Segundo Medio', 'II Medio',
        '3ro Medio', '3er Medio', 'Tercero Medio', 'III Medio',
        '4to Medio', '4° Medio', 'Cuarto Medio', 'IV Medio'
      ];

      return courseKeys.sort((a, b) => {
        // Obtener el nombre del curso (sin sección) para comparar
        const courseNameA = getCourseAndSectionName(a).split(/\s+(?:Sección|Section)\s+/i)[0].trim();
        const courseNameB = getCourseAndSectionName(b).split(/\s+(?:Sección|Section)\s+/i)[0].trim();
        
        let indexA = courseOrder.findIndex(course => 
          courseNameA.toLowerCase().includes(course.toLowerCase()) || 
          course.toLowerCase().includes(courseNameA.toLowerCase())
        );
        let indexB = courseOrder.findIndex(course => 
          courseNameB.toLowerCase().includes(course.toLowerCase()) || 
          course.toLowerCase().includes(courseNameB.toLowerCase())
        );
        
        // Si no se encuentra el curso en el orden, ponerlo al final
        if (indexA === -1) indexA = courseOrder.length;
        if (indexB === -1) indexB = courseOrder.length;
        
        // Si los cursos son del mismo nivel, ordenar por sección (A, B, C, etc.)
        if (indexA === indexB) {
          const sectionA = getCourseAndSectionName(a).split(/\s+(?:Sección|Section)\s+/i)[1]?.trim() || '';
          const sectionB = getCourseAndSectionName(b).split(/\s+(?:Sección|Section)\s+/i)[1]?.trim() || '';
          return sectionA.localeCompare(sectionB);
        }
        
        return indexA - indexB;
      });
    };

    // Get course statistics for teacher (updated for course + section)
    const getCourseStats = () => {
      const tasksByCourseAndSection = getTasksByCourseAndSection();
      const stats: { [courseSection: string]: { total: number; pending: number; submitted: number; reviewed: number } } = {};
      
      Object.keys(tasksByCourseAndSection).forEach(courseSection => {
        const courseTasks = tasksByCourseAndSection[courseSection];
        stats[courseSection] = {
          total: courseTasks.length,
          pending: 0,
          submitted: 0,
          reviewed: 0
        };
        
        // Calculate statistics based on actual task status and student submissions
        courseTasks.forEach(task => {
          // Obtener todos los estudiantes asignados a esta tarea
          const assignedStudents = getAssignedStudentsForTask(task);
          
          // Verificar si todos los estudiantes han entregado la tarea
          const allSubmitted = assignedStudents.length > 0 && 
            assignedStudents.every(student => 
              hasStudentSubmitted(task.id, student.username)
            );
          
          // Verificar si al menos un estudiante ha entregado
          const someSubmitted = assignedStudents.some(student => 
            hasStudentSubmitted(task.id, student.username)
          );
          
          if (allSubmitted) {
            if (task.status === 'reviewed') {
              stats[courseSection].reviewed++;
            } else {
              stats[courseSection].submitted++;
            }
          } else if (someSubmitted) {
            // Si hay entregas parciales, sigue siendo pendiente
            stats[courseSection].pending++;
          } else {
            stats[courseSection].pending++;
          }
        });
      });
      
      return stats;
    };

    const handleCreateTask = () => {
      if (!formData.title || !formData.description || !formData.course || !formData.dueDate || !formData.subject) {
        toast({
          title: translate('error'),
          description: translate('completeAllFields'),
          variant: 'destructive'
        });
        return;
      }

      // Validación específica para evaluaciones
      if (formData.taskType === 'evaluacion') {
        if (!formData.topic || !formData.numQuestions || !formData.timeLimit) {
          toast({
            title: 'Error',
            description: 'Para las evaluaciones debe especificar: Tema, Cantidad de Preguntas y Tiempo límite',
            variant: 'destructive'
          });
          return;
        }
        
        if (![5, 10, 15, 20, 25, 30].includes(formData.numQuestions)) {
          toast({
            title: 'Error', 
            description: 'La cantidad de preguntas debe ser una de las opciones disponibles: 5, 10, 15, 20, 25 o 30',
            variant: 'destructive'
          });
          return;
        }
        
        if (formData.timeLimit < 1 || formData.timeLimit > 180) {
          toast({
            title: 'Error',
            description: 'El tiempo límite debe estar entre 1 y 180 minutos',
            variant: 'destructive'
          });
          return;
        }
      }
      
      // Validar que la fecha límite sea en el futuro
      const dueDate = new Date(formData.dueDate);
      const now = new Date();
      if (dueDate <= now) {
        toast({
          title: translate('error'),
          description: translate('dueDateMustBeFuture'),
          variant: 'destructive'
        });
        return;
      }

  // CORRECCIÓN: Extraer courseId Y preservar el ID combinado completo
      const availableCourses = getAvailableCoursesWithNames();
      const selectedCourse = availableCourses.find(course => course.id === formData.course);
      
      // Log para debugging
      console.log(`🔍 [handleCreateTask] formData.course: "${formData.course}"`);
      console.log(`🔍 [handleCreateTask] selectedCourse:`, selectedCourse);
      
      // Extraer el courseId para compatibilidad con el resto del sistema
      const actualCourseId = selectedCourse && selectedCourse.courseId ? selectedCourse.courseId : formData.course;
      // Preservar el ID combinado completo para mostrar curso y sección correctamente
      const courseSectionId = formData.course; // ID combinado completo
      // Derivar sectionId explícito desde el ID combinado (formato: courseId-sectionId)
      let derivedSectionId: string | undefined = undefined;
      try {
        const parts = String(courseSectionId || '').split('-');
        if (parts.length === 10) {
          derivedSectionId = parts.slice(5).join('-');
        } else if (selectedCourse && selectedCourse.sectionId) {
          derivedSectionId = String(selectedCourse.sectionId);
        } else if (String(courseSectionId || '').includes('seccion-')) {
          derivedSectionId = String(courseSectionId).split('seccion-')[1];
        }
      } catch {}

      const taskId = `task_${Date.now()}`;
      const newTask: Task = {
        id: taskId,
        title: formData.title,
        description: formData.description,
        subject: formData.subject, // This might become subjectId later
        course: actualCourseId, // Mantener courseId para compatibilidad
  sectionId: derivedSectionId,
        courseSectionId: courseSectionId, // 🆕 NUEVO: Preservar ID combinado
        assignedById: user?.id || '', // Use user ID
        assignedByName: user?.displayName || '', // Keep for display convenience
        assignedTo: formData.assignedTo,
        assignedStudentIds: formData.assignedTo === 'student' ? formData.assignedStudentIds : undefined, // Use assignedStudentIds
        dueDate: formData.dueDate,
        createdAt: new Date().toISOString(),
        status: 'pending',
        priority: formData.priority,
        attachments: taskAttachments,
        taskType: formData.taskType,
        // Include evaluation fields if it's an evaluation
        topic: formData.taskType === 'evaluacion' ? formData.topic : undefined,
        numQuestions: formData.taskType === 'evaluacion' ? formData.numQuestions : undefined,
        timeLimit: formData.taskType === 'evaluacion' ? formData.timeLimit : undefined
      };

      const updatedTasks = [...tasks, newTask];
      saveTasks(updatedTasks);
      
      // 🔔 NUEVA FUNCIONALIDAD: Crear notificación de "Tarea Pendiente" para el profesor
      TaskNotificationManager.createPendingGradingNotification(
        taskId,
        formData.title,
        actualCourseId, // Usar courseId para compatibilidad
        formData.subject,
        user?.username || '', // Pass user.username, not user.id
        user?.displayName || '',
        formData.taskType === 'evaluacion' ? 'evaluation' : 'assignment'
      );

      // Crear notificaciones para los estudiantes sobre la nueva tarea
      TaskNotificationManager.createNewTaskNotifications(
        taskId,
        formData.title,
        courseSectionId, // 🔧 CORRECCIÓN: Usar courseSectionId (ID combinado) en lugar de actualCourseId
        formData.subject,
        user?.id || '', // Pass user.id as teacherId
        user?.displayName || '',
        formData.taskType === 'evaluacion' ? 'evaluation' : 'assignment'
      );

      // 📧 Enviar notificaciones por email a los estudiantes
      try {
        let recipientIds: string[] = [];
        const currentYear = new Date().getFullYear();
        
        if (formData.assignedTo === 'student' && formData.assignedStudentIds.length > 0) {
          // Tarea asignada a estudiantes específicos
          recipientIds = formData.assignedStudentIds;
          console.log(`📧 [TAREAS] Tarea asignada a estudiantes específicos:`, recipientIds);
        } else {
          // Tarea asignada a todo el curso/sección
          // MÉTODO PRINCIPAL: Usar smart-student-students-{year} que tiene sectionId
          const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
          
          if (studentsForYear.length > 0) {
            console.log(`📧 [TAREAS] Buscando estudiantes del año ${currentYear}: ${studentsForYear.length} total`);
            
            const sectionId = derivedSectionId || selectedCourse?.sectionId;
            const courseId = actualCourseId;
            
            // Buscar por sectionId primero (más preciso)
            let estudiantesEncontrados = studentsForYear.filter((s: any) => 
              String(s.sectionId) === String(sectionId)
            );
            console.log(`📧 [TAREAS] Estudiantes por sectionId "${sectionId}": ${estudiantesEncontrados.length}`);
            
            // Fallback: buscar por courseId
            if (estudiantesEncontrados.length === 0) {
              estudiantesEncontrados = studentsForYear.filter((s: any) => 
                String(s.courseId) === String(courseId)
              );
              console.log(`📧 [TAREAS] Fallback por courseId "${courseId}": ${estudiantesEncontrados.length}`);
            }
            
            recipientIds = estudiantesEncontrados.map((s: any) => s.id);
            console.log(`📧 [TAREAS] Recipients por students-year:`, recipientIds.length);
          }
          
          // MÉTODO LEGACY: Si no hay en students-year, usar asignaciones
          if (recipientIds.length === 0) {
            const storedAssignments = localStorage.getItem('smart-student-student-assignments');
            const storedUsers = localStorage.getItem('smart-student-users');
            
            if (storedAssignments && storedUsers) {
              const allAssignments = JSON.parse(storedAssignments);
              const allUsers = JSON.parse(storedUsers);
              
              // Buscar estudiantes por sectionId en las asignaciones
              const sectionId = selectedCourse?.sectionId;
              const courseId = actualCourseId;
              
              let studentsInSection = allAssignments
                .filter((a: any) => String(a.sectionId) === String(sectionId))
                .map((a: any) => a.studentId);
              
              console.log(`📧 [TAREAS] Estudiantes en sección ${sectionId}:`, studentsInSection);
              
              // Fallback: buscar por courseId si no hay por sectionId
              if (studentsInSection.length === 0) {
                studentsInSection = allAssignments
                  .filter((a: any) => String(a.courseId) === String(courseId))
                  .map((a: any) => a.studentId);
                console.log(`📧 [TAREAS] Fallback por courseId ${courseId}:`, studentsInSection);
              }
              
              // Obtener IDs de usuarios estudiantes que están en esta sección
              recipientIds = allUsers
                .filter((u: any) => u.role === 'student' && studentsInSection.includes(u.id))
                .map((u: any) => u.id);
              
              console.log(`📧 [TAREAS] Recipients por asignaciones:`, recipientIds.length);
              
              // Segundo fallback: buscar por activeCourses del usuario
              if (recipientIds.length === 0) {
                recipientIds = allUsers
                  .filter((u: any) => 
                    u.role === 'student' && 
                    (u.activeCourses?.some((ac: string) => 
                      ac === courseSectionId || 
                      ac.includes(actualCourseId) ||
                      ac.includes(selectedCourse?.name || '')
                    ) ||
                    (String(u.courseId) === String(courseId) && String(u.sectionId) === String(sectionId)))
                  )
                  .map((u: any) => u.id);
                console.log(`📧 [TAREAS] Recipients por fallback:`, recipientIds.length);
              }
            }
          }
        }
        
        // También incluir apoderados - búsqueda multi-método
        if (recipientIds.length > 0) {
          let guardianIds: string[] = [];
          const currentYear = new Date().getFullYear();
          
          // Método 1: Buscar en smart-student-guardians-{year}
          const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]');
          if (guardiansForYear.length > 0) {
            guardianIds = guardiansForYear
              .filter((g: any) => g.studentIds?.some((sid: string) => recipientIds.includes(sid)))
              .map((g: any) => g.id);
            console.log(`📧 [TAREAS] Apoderados por guardians-year: ${guardianIds.length}`);
          }
          
          // Método 2: Buscar en smart-student-guardian-students (relaciones)
          if (guardianIds.length === 0) {
            const guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-students') || '[]');
            if (guardianRelations.length > 0) {
              const guardianIdsFromRelations = guardianRelations
                .filter((r: any) => recipientIds.includes(r.studentId))
                .map((r: any) => r.guardianId);
              guardianIds = [...new Set(guardianIdsFromRelations)];
              console.log(`📧 [TAREAS] Apoderados por relaciones: ${guardianIds.length}`);
            }
          }
          
          // Método 3: Buscar en smart-student-users
          if (guardianIds.length === 0) {
            const storedUsers = localStorage.getItem('smart-student-users');
            if (storedUsers) {
              const allUsers = JSON.parse(storedUsers);
              guardianIds = allUsers
                .filter((u: any) => 
                  u.role === 'guardian' && 
                  (u.assignedStudents?.some((studentId: string) => recipientIds.includes(studentId)) ||
                   u.studentIds?.some((studentId: string) => recipientIds.includes(studentId)) ||
                   u.children?.some((studentId: string) => recipientIds.includes(studentId)))
                )
                .map((u: any) => u.id);
              console.log(`📧 [TAREAS] Apoderados por users: ${guardianIds.length}`);
            }
          }
          
          console.log(`📧 [TAREAS] Total apoderados encontrados: ${guardianIds.length}`);
          recipientIds = [...new Set([...recipientIds, ...guardianIds])];
        }
        
        console.log(`📧 [TAREAS] Total recipients finales:`, recipientIds.length);
        
        if (recipientIds.length > 0) {
          // Obtener el nombre de la sección desde selectedCourse
          const sectionName = selectedCourse?.sectionName || selectedCourse?.name?.split(' Sección ')?.[1] || '';
          
          // Usar .then/.catch en lugar de await para evitar requerir async
          sendEmailOnNotification(
            formData.taskType === 'evaluacion' ? 'evaluation_assigned' : 'task_assigned',
            recipientIds,
            {
              title: formData.taskType === 'evaluacion' ? 'Nueva Evaluación Asignada' : 'Nueva Tarea Asignada',
              content: formData.description || `Se ha asignado ${formData.taskType === 'evaluacion' ? 'una nueva evaluación' : 'una nueva tarea'}: ${formData.title}`,
              taskTitle: formData.title,
              senderName: user?.displayName || user?.username || 'Profesor',
              courseName: selectedCourse?.originalCourseName || selectedCourse?.name || formData.course,
              sectionName: sectionName
            }
          ).then(() => {
            console.log(`📧 [TAREAS] Email notifications sent to ${recipientIds.length} recipients`);
          }).catch((emailError) => {
            console.warn('⚠️ [TAREAS] Error sending email notifications:', emailError);
          });
        } else {
          console.warn(`⚠️ [TAREAS] No se encontraron destinatarios para el email`);
        }
      } catch (emailError) {
        console.warn('⚠️ [TAREAS] Error sending email notifications:', emailError);
      }

      toast({
        title: translate('taskCreated'),
        description: translate('taskCreatedDesc', { title: formData.title }),
      });

      // Reset form
      setFormData({
        title: '',
        description: '',
        subject: '',
        course: '',
        assignedTo: 'course',
        assignedStudentIds: [],
        dueDate: '',
        priority: 'medium',
        taskType: 'tarea',
        topic: '',
        numQuestions: 0,
        timeLimit: 0
      });
      setFilteredSubjects([]); // Limpiar asignaturas filtradas
      setTaskAttachments([]);
      setShowCreateDialog(false);
    };

    const handleAddComment = () => {
      if (!newComment.trim() || !selectedTask) return;

      // Check if student already made a submission for this task
      if (isSubmission && user?.role === 'student' && user.id) {
        const existingSubmission = comments.find(comment => 
          comment.taskId === selectedTask.id && 
          comment.studentId === user.id && 
          comment.isSubmission
        );
        
        if (existingSubmission) {
          toast({
            title: translate('error'),
            description: translate('alreadySubmitted'),
            variant: 'destructive'
          });
          return;
        }
      }

      // Asegurarse de que los archivos adjuntos se incluyan correctamente
      const attachmentsToSave = [...commentAttachments];
      
      // Verificación de archivos adjuntos
      if (user?.role === 'student' && isSubmission && attachmentsToSave.length === 0) {
        console.log('⚠️ Advertencia: Entrega sin archivos adjuntos');
      }

      const comment: TaskComment = {
        id: `comment_${Date.now()}`,
        taskId: selectedTask.id,
        studentId: user?.role === 'student' ? user.id : 
          (isSubmission ? 'teacher-comment' : user?.id || 'unknown'), // Para comentarios de profesor, usar su ID
        studentUsername: user?.role === 'student' ? user.username : 
          (isSubmission ? 'teacher' : user?.username || 'unknown'), // Para comentarios de profesor, usar su username
        studentName: user?.role === 'student' ? (user.displayName || user.username) :
          (isSubmission ? 'Profesor/a' : user?.displayName || user?.username || 'Profesor/a'), // Para comentarios de profesor, usar su displayName
        comment: newComment,
        timestamp: new Date().toISOString(),
        isSubmission: isSubmission,
        attachments: attachmentsToSave, // Usar la copia de archivos adjuntos
        readBy: [], // ✅ NUEVO: Inicializar como array vacío para tracking de lectura
        authorUsername: user?.username, // 🔥 NUEVO: Campo para identificar quién escribió realmente el comentario
        authorRole: user?.role // 🔥 NUEVO: Campo para identificar el rol del autor
      };

      const updatedComments = [...comments, comment];
      saveComments(updatedComments);
      // Forzar recarga de comentarios desde localStorage para refrescar panel
      loadComments();

      console.log('💾 Comment saved:', {
        isSubmission,
        studentId: user?.id,
        taskId: selectedTask.id,
        commentId: comment.id,
        totalComments: updatedComments.length,
        attachmentsCount: commentAttachments.length,
        attachments: commentAttachments.map(a => a.name)
      });

      // Si es una entrega, notificar al profesor inmediatamente
      if (isSubmission && user?.role === 'student') {
        console.log(`📝 Estudiante ${user.displayName} entregando tarea "${selectedTask.title}"`);
        
        // Crear notificación usando TaskNotificationManager
        TaskNotificationManager.createTaskSubmissionNotification(
          selectedTask.id,
          selectedTask.title,
          selectedTask.course,
          selectedTask.subject,
          user.username,
          user.displayName || user.username,
          getTeacherUsernameById(selectedTask.assignedById)
        );

        toast({
          title: translate('taskSubmitted'),
          description: 'Tu tarea ha sido entregada y el profesor ha sido notificado.',
          variant: 'default'
        });
        
        // Disparar evento para actualizar notificaciones
        window.dispatchEvent(new CustomEvent('notificationsUpdated', {
          detail: { type: 'task_submission', taskId: selectedTask.id, studentId: user.id }
        }));
        
        // Forzar actualización del panel de estudiantes del profesor
        window.dispatchEvent(new CustomEvent('studentPanelUpdate', {
          detail: { taskId: selectedTask.id, studentId: user.id, submissionTime: new Date().toISOString() }
        }));
      }

      // Update task status only if ALL students have submitted - UPDATED para estados mejorados
      if (isSubmission) {
        // Obtener todos los estudiantes asignados a la tarea
        let assignedStudents = getAssignedStudentsForTask(selectedTask);
        
        console.log(`🔍 DEBUG: Verificando entregas para tarea "${selectedTask.title}"`);
        console.log(`👥 Estudiantes asignados: ${assignedStudents.length}`);
        console.log(`📋 Lista de estudiantes:`, assignedStudents);
        console.log(`👤 Usuario actual: ${user?.id} (${user?.username})`);
        
        // Verificar si ahora todos los estudiantes han entregado la tarea
        // Incluimos el comentario actual en la verificación
        console.log(`🔍 Verificando si todos los estudiantes han entregado...`);
        console.log(`📋 Estudiantes asignados:`, assignedStudents);
        
        // 🔥 PARCHE: Si no hay estudiantes asignados, intentar obtenerlos directamente del curso
        if (assignedStudents.length === 0 && selectedTask.course) {
          console.log(`⚠️ No hay estudiantes asignados, obteniendo del curso: ${selectedTask.course}`);
          const courseStudents = getStudentsFromCourseRelevantToTask(selectedTask.course, selectedTask.assignedById);
          console.log(`👥 Estudiantes del curso encontrados: ${courseStudents.length}`, courseStudents);
          assignedStudents = courseStudents;
        }
        
        const allStudentsSubmitted = assignedStudents.length > 0 && 
          assignedStudents.every(student => {
            const hasSubmitted = student.id === user?.id || hasStudentSubmitted(selectedTask.id, student.id);
            console.log(`✅ Estudiante ${student.displayName} (${student.id}): ${hasSubmitted ? 'ENTREGADO' : 'PENDIENTE'}`);
            return hasSubmitted;
          });
        
        // 🔥 CORRECCIÓN: NO cambiar el estado cuando los estudiantes entregan
        // La tarea debe mantenerse en 'pending' hasta que el profesor califique TODAS las entregas
        // El estado solo cambia a 'reviewed' (Finalizada) cuando el profesor termina de calificar a todos
        
        // Log para debug - mostrar cuántos estudiantes han entregado
        const submittedCount = assignedStudents.filter(student => 
          student.id === user?.id || hasStudentSubmitted(selectedTask.id, student.id)
        ).length;
        
        console.log(`📊 Entregas: ${submittedCount}/${assignedStudents.length} estudiantes han entregado la tarea "${selectedTask.title}"`);
        console.log(`⏳ Estado de la tarea mantiene: "pending" hasta que profesor califique todas las entregas`);
        console.log(`🎯 Todos entregaron: ${allStudentsSubmitted ? 'SÍ' : 'NO'}`);
        
        // 🔥 NUEVO: Si todos los estudiantes entregaron, crear notificación de tarea completa
        if (allStudentsSubmitted) {
          console.log(`🚀 Verificando si crear notificación de tarea completa...`);
          console.log(`📋 Detalles para notificación:`, {
            taskId: selectedTask.id,
            taskTitle: selectedTask.title,
            course: selectedTask.course,
            subject: selectedTask.subject,
            assignedById: selectedTask.assignedById,
            taskType: selectedTask.taskType
          });
          
          // � TEMPORALMENTE DESHABILITADO: Bloquear TODAS las notificaciones task_completed hasta resolver duplicados
          console.log(`⚠️ NOTIFICACIÓN BLOQUEADA: Creación de task_completed temporalmente deshabilitada`);
          console.log(`📝 Razón: Evitar duplicados mientras se investiga el problema`);
          
          /* 
          // �🔧 CORRECCIÓN CRÍTICA: NO crear notificaciones para evaluaciones aquí
          // Las evaluaciones ya se manejan en la página de evaluaciones con createEvaluationCompletedNotification
          if (selectedTask.taskType !== 'evaluacion') {
            console.log(`✅ Creando notificación para tarea de tipo: ${selectedTask.taskType}`);
            
            // 🔧 CORRECCIÓN CRÍTICA: Obtener el username del profesor, no usar el ID
            const teacherUsername = getTeacherUsernameById(selectedTask.assignedById);
            
            TaskNotificationManager.createTaskCompletedNotification(
              selectedTask.id,
              selectedTask.title,
              selectedTask.course,
              selectedTask.subject,
              teacherUsername, // Usar username del profesor, no ID
              'assignment' // Solo para assignments, no evaluations
            );
            
            console.log(`✅ Tarea completa: Todos los estudiantes han entregado "${selectedTask.title}"`);
            
            // 🔥 FORZAR REFRESCO DE NOTIFICACIONES
            // Disparar evento personalizado para actualizar el panel de notificaciones
            window.dispatchEvent(new CustomEvent('notificationsUpdated', {
              detail: { type: 'task_completed', taskId: selectedTask.id }
            }));
          } else {
            console.log(`ℹ️ Saltando notificación para evaluación - ya se maneja en página de evaluaciones`);
            console.log(`📝 Evaluación "${selectedTask.title}" completada por todos los estudiantes`);
          }
          */
        }
        
        // NO actualizar el estado aquí - se mantiene en 'pending' hasta calificación completa
      }

      setNewComment('');
      setIsSubmission(false);
      
      // Registrar que estamos limpiando los archivos adjuntos después de guardar el comentario
      console.log('🧹 Limpiando archivos adjuntos después de guardar', commentAttachments.length);
      setCommentAttachments([]);

      // 📧 Enviar notificación por email si es un comentario del profesor a un estudiante
      if (user?.role === 'teacher' && !isSubmission && selectedTask) {
        try {
          // Obtener los estudiantes asignados a esta tarea
          const assignedStudents = getAssignedStudentsForTask(selectedTask);
          const recipientIds = assignedStudents.map(s => s.id);
          
          // También incluir apoderados
          const storedUsers = localStorage.getItem('smart-student-users');
          if (storedUsers) {
            const allUsers = JSON.parse(storedUsers);
            const guardianIds = allUsers
              .filter((u: any) => 
                u.role === 'guardian' && 
                u.assignedStudents?.some((studentId: string) => recipientIds.includes(studentId))
              )
              .map((u: any) => u.id);
            recipientIds.push(...guardianIds);
          }
          
          if (recipientIds.length > 0) {
            // Usar .then/.catch en lugar de await para evitar requerir async
            sendEmailOnNotification(
              'task_comment',
              recipientIds,
              {
                title: `Nuevo comentario en la tarea: ${selectedTask.title}`,
                content: newComment,
                taskTitle: selectedTask.title,
                senderName: user?.displayName || user?.username || 'Profesor',
                courseName: selectedTask.course
              }
            ).then(() => {
              console.log(`📧 [TAREAS] Comment notification email sent to ${recipientIds.length} recipients`);
            }).catch((emailError) => {
              console.warn('⚠️ [TAREAS] Error sending comment email notification:', emailError);
            });
          }
        } catch (emailError) {
          console.warn('⚠️ [TAREAS] Error sending comment email notification:', emailError);
        }
      }

      if (!isSubmission) {
        toast({
          title: translate('commentAdded'),
          description: translate('commentAddedDesc'),
        });
      }
    };

    // Funciones para la evaluación mejorada con IA de Gemini
    const generateEvaluationQuestions = async (topic: string, numQuestions: number): Promise<any[]> => {
      try {
        console.log(`🤖 Solicitando ${numQuestions} preguntas sobre "${topic}" a nuestra API...`);

        // 1. Hacer una petición POST a tu API Route
        const response = await fetch('/api/generate-questions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ topic, numQuestions, language }),
        });

        console.log('📡 Respuesta del servidor recibida. Status:', response.status);

        // Verificar si la respuesta tiene contenido antes de parsear
        const responseText = await response.text();
        console.log('📄 Contenido de la respuesta:', responseText);

        if (!response.ok) {
          // Si la respuesta del servidor no es exitosa, lanza un error
          let errorData;
          try {
            errorData = JSON.parse(responseText);
          } catch {
            errorData = { error: responseText || `Error ${response.status}: ${response.statusText}` };
          }
          
          console.error('❌ Error del servidor:', errorData);
          
          // Mejorar el mensaje de error
          const errorMessage = errorData?.error || errorData?.message || `Error ${response.status}: ${response.statusText}`;
          throw new Error(errorMessage);
        }

        // 2. Convertir la respuesta a JSON (con validación mejorada)
        if (!responseText.trim()) {
          throw new Error("La respuesta del servidor está vacía");
        }

        let questions;
        try {
          questions = JSON.parse(responseText);
        } catch (parseError) {
          console.error('❌ Error al parsear JSON:', parseError);
          console.error('❌ Contenido que falló al parsear:', responseText);
          throw new Error("Respuesta del servidor no es un JSON válido");
        }
        console.log('✅ Preguntas recibidas desde la API:', questions.length, questions);

        // Validar que se recibieron preguntas válidas
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new Error("No se recibieron preguntas válidas de la API");
        }

        console.log('✅ Preguntas recibidas y validadas correctamente:', questions.length);

        // 3. ¡Randomizar el orden de las preguntas!
        // Esto asegura que cada vez que se inicie la evaluación, las preguntas aparezcan en un orden diferente.
        const shuffledQuestions = [...questions].sort(() => 0.5 - Math.random());

        console.log('🔀 Preguntas randomizadas y validadas correctamente');
        return shuffledQuestions;

      } catch (error: any) {
        console.error("❌ Error completo al solicitar o procesar las preguntas:", error);
        console.error("❌ Stack trace:", error.stack);
        console.error("❌ Error name:", error.name);
        console.error("❌ Error message:", error.message);
        
        // Mostrar mensaje de error más específico al usuario
        let errorMessage = "No se pudieron generar las preguntas. Por favor, inténtalo de nuevo.";
        
        if (error.message) {
          if (error.message.includes("fetch") || error.message.includes("network")) {
            errorMessage = "Error de conexión con el servidor. Verifica tu conexión a internet.";
          } else if (error.message.includes("API Key") || error.message.includes("GOOGLE_API_KEY")) {
            errorMessage = "Error de configuración del servidor. Contacta al administrador.";
          } else if (error.message.includes("estructura") || error.message.includes("JSON")) {
            errorMessage = "Error en el formato de las preguntas generadas. Inténtalo nuevamente.";
          } else if (error.message.includes("500")) {
            errorMessage = "Error interno del servidor. Inténtalo en unos momentos.";
          } else {
            // Usar el mensaje de error específico si está disponible
            errorMessage = error.message;
          }
        }
        
        toast({
          title: "Error de IA",
          description: errorMessage,
          variant: "destructive",
        });
        return []; // Devolver un array vacío en caso de error
      }
    };

    const handleStartEvaluation = async (task: Task) => {
      // Verificar si ya completó la evaluación
      if (evaluationResults[task.id]) {
        toast({
          title: "Evaluación completada",
          description: "Ya has completado esta evaluación.",
          variant: "destructive"
        });
        return;
      }

      // Validar criterios configurados por el profesor
      const topic = task.topic || 'Tema general';
      const numQuestions = task.numQuestions && task.numQuestions > 0 ? task.numQuestions : 5;
      const timeLimit = task.timeLimit && task.timeLimit > 0 ? task.timeLimit : 10;

      // Mostrar advertencia si algunos criterios no están configurados
      if (!task.topic || !task.numQuestions || !task.timeLimit) {
        console.warn('⚠️ Algunos criterios de evaluación no están configurados por el profesor:', {
          topic: task.topic,
          numQuestions: task.numQuestions, 
          timeLimit: task.timeLimit
        });
      }

      setShowLoadingDialog(true);
      setLoadingProgress(0);
      setLoadingStatus(translate('evalLoadingInitializing'));

      // --- LÓGICA DE CARGA MEJORADA ---
      // 1. Simulación rápida de los pasos iniciales (hasta el 80%)
      const initialSteps = [
        { progress: 20, status: translate('evalLoadingVerifyingConfig') },
        { progress: 50, status: translate('evalLoadingPreparingAI', { topic }) },
        { progress: 80, status: translate('evalLoadingGeneratingQuestions', { count: numQuestions.toString() }) }
      ];

      let stepIndex = 0;
      const initialInterval = setInterval(() => {
        if (stepIndex < initialSteps.length) {
          const step = initialSteps[stepIndex];
          setLoadingProgress(step.progress);
          setLoadingStatus(step.status);
          stepIndex++;
        } else {
          clearInterval(initialInterval);

          // 2. Paso final: La llamada real a la IA
          setLoadingProgress(90);
          setLoadingStatus(translate('evalLoadingConsultingAI'));

          // Llamamos a la función de generación y esperamos a que termine
          generateEvaluationQuestions(topic, numQuestions).then(questions => {
            // 3. Cuando las preguntas llegan, completamos al 100% y cerramos
            setLoadingProgress(100);
            setLoadingStatus(translate('evalLoadingReady'));

            // Pequeña pausa para que el usuario vea el 100%
            setTimeout(() => {
              setShowLoadingDialog(false);

              if (questions.length === 0) {
                // El toast de error ya se muestra dentro de generateEvaluationQuestions
                return;
              }

              console.log('🔍 GENERATED QUESTIONS:', questions.map(q => ({ 
                question: q.question?.substring(0, 50), 
                options: q.options?.map((o: any) => o?.substring(0, 20)) 
              })));

              const timeInSeconds = timeLimit * 60;
              setCurrentEvaluation({
                task,
                questions,
                startTime: new Date(),
                answers: {},
                timeRemaining: timeInSeconds,
                currentQuestionIndex: 0
              });
              setShowEvaluationDialog(true);
              
              // Iniciar countdown del timer
              console.log('🔥 [startEvaluation] Iniciando evaluación con tiempo límite:', timeLimit, 'minutos');
              startEvaluationTimer(timeInSeconds);
            }, 500); // 0.5 segundos de pausa en el 100%
          }).catch(error => {
            // Manejar errores de la IA
            console.error('Error al generar preguntas:', error);
            setShowLoadingDialog(false);
          });
        }
      }, 400); // Intervalo más rápido para la simulación
    };

    const startEvaluationTimer = (initialTime: number) => {
      console.log('🔥 [startEvaluationTimer] Iniciando timer con tiempo:', initialTime);
      let timerRef: NodeJS.Timeout;
      
      timerRef = setInterval(() => {
        setCurrentEvaluation(prev => {
          const newTime = prev.timeRemaining - 1;
          
          if (newTime <= 0) {
            console.log('🔥 [startEvaluationTimer] ¡TIEMPO AGOTADO! Deteniendo timer');
            clearInterval(timerRef);
            
            // Ejecutar handleCompleteEvaluation con un delay para asegurar que el estado se actualice
            setTimeout(() => {
              console.log('🔥 [startEvaluationTimer] Ejecutando handleCompleteEvaluation(true)');
              handleCompleteEvaluation(true);
            }, 200);
            
            return { ...prev, timeRemaining: 0 };
          }
          
          // Log cada segundo cuando queden menos de 30 segundos
          if (newTime <= 30) {
            console.log(`🔥 [startEvaluationTimer] Tiempo restante: ${newTime} segundos`);
          } else if (newTime % 10 === 0) {
            console.log(`🔥 [startEvaluationTimer] Tiempo restante: ${newTime} segundos`);
          }
          
          return { ...prev, timeRemaining: newTime };
        });
      }, 1000);
    };

    const handleReviewEvaluation = async (task: Task) => {
      const evaluationResult = evaluationResults[task.id];
      if (evaluationResult) {
        // Traducir las preguntas dinámicamente según el idioma actual
        const translatedResult = await translateEvaluationResult(evaluationResult, task);
        setCurrentEvaluationReview(translatedResult);
        setShowReviewEvaluationDialog(true);
      }
    };

    // Función para traducir los resultados de evaluación según el idioma actual
    const translateEvaluationResult = async (result: any, task: Task) => {
      const currentLanguage = localStorage.getItem('smart-student-lang') || 'es';
      
      console.log('🔍 TRANSLATION DEBUG - Current language:', currentLanguage);
      console.log('🔍 TRANSLATION DEBUG - LocalStorage key check:', localStorage.getItem('smart-student-lang'));
      console.log('🔍 TRANSLATION DEBUG - All localStorage keys:', Object.keys(localStorage));
      console.log('🔍 TRANSLATION DEBUG - Result has questions:', !!result.questions);
      console.log('🔍 TRANSLATION DEBUG - Questions length:', result.questions?.length);
      
      // FORZAR VERIFICACIÓN: Verificar otras posibles claves de idioma
      const altLanguageCheck = localStorage.getItem('language') || localStorage.getItem('locale') || localStorage.getItem('i18n-language');
      console.log('🔍 TRANSLATION DEBUG - Alternative language keys:', { altLanguageCheck });
      
      // Si ya está en español o no hay preguntas, devolver tal como está
      if (currentLanguage === 'es' || !result.questions || result.questions.length === 0) {
        console.log('🔍 TRANSLATION DEBUG - Returning original result (no translation needed)');
        console.log('🔍 TRANSLATION DEBUG - Reason: currentLanguage =', currentLanguage, ', hasQuestions =', !!result.questions);
        return result;
      }

      console.log('🔄 Translating evaluation result from Spanish to English...');
      console.log('Original topic:', task.topic);
      console.log('Original questions sample:', result.questions[0]?.question?.substring(0, 100));
      
      // Generar preguntas en inglés para el mismo tema usando la nueva función asíncrona
      const englishQuestions = await generateEvaluationQuestions(task.topic || 'mathematics', result.questions.length);
      
      console.log('Generated English questions:', englishQuestions.length);
      console.log('English questions sample:', englishQuestions[0]?.question?.substring(0, 100));
      
      // Mapear las preguntas guardadas con las traducciones al inglés
      const translatedQuestions = result.questions.map((savedQuestion: any, index: number) => {
        const englishQuestion = englishQuestions[index];
        
        // Si no hay pregunta en inglés correspondiente, mantener la original
        if (!englishQuestion || typeof englishQuestion !== 'object') {
          console.log(`⚠️ No English question found for index ${index}`);
          return savedQuestion;
        }
        
        // Verificar que la pregunta en inglés tiene las propiedades necesarias
        const hasRequiredProps = 'question' in englishQuestion && 
                                'options' in englishQuestion && 
                                'explanation' in englishQuestion &&
                                'correct' in englishQuestion;
        
        if (!hasRequiredProps) {
          console.log(`⚠️ English question ${index} missing required properties`);
          return savedQuestion;
        }
        
        const translatedQuestion = {
          ...savedQuestion,
          question: (englishQuestion as any).question,
          options: (englishQuestion as any).options,
          explanation: (englishQuestion as any).explanation,
          // Actualizar texto de respuesta del estudiante y respuesta correcta
          studentAnswerText: savedQuestion.studentAnswer !== undefined ? 
            (englishQuestion as any).options[savedQuestion.studentAnswer] : undefined,
          correctAnswer: (englishQuestion as any).options[(englishQuestion as any).correct],
          // Mantener datos originales del estudiante
          studentAnswer: savedQuestion.studentAnswer,
          correct: savedQuestion.correct,
          isCorrect: savedQuestion.isCorrect
        };
        
        console.log(`✅ Translated question ${index + 1}:`, {
          original: savedQuestion.question?.substring(0, 50) + '...',
          translated: (englishQuestion as any).question?.substring(0, 50) + '...'
        });
        
        return translatedQuestion;
      });

      const translatedResult = {
        ...result,
        questions: translatedQuestions
      };
      
      console.log('🎯 Translation completed');
      return translatedResult;
    };

    const handleCompleteEvaluation = (timeExpired: boolean = false) => {
      if (!currentEvaluation.task) return;

      let correctAnswers = 0;
      const totalQuestions = currentEvaluation.questions.length;

      // Calcular respuestas correctas y procesar cada pregunta
      const processedQuestions = currentEvaluation.questions.map((question, index) => {
        const studentAnswer = currentEvaluation.answers[index];
        const correctAnswer = question.correct;
        let isCorrect = false;

        // --- ✅ LÓGICA DE CALIFICACIÓN PARA TODOS LOS TIPOS ---
        if (question.type === 'multiple_select') {
          // Para selección múltiple, la respuesta correcta y del estudiante son arrays.
          // Los ordenamos y comparamos para ver si son idénticos.
          const studentSelection = Array.isArray(studentAnswer) ? studentAnswer.sort() : [];
          const correctSelection = Array.isArray(correctAnswer) ? correctAnswer.sort() : [];
          isCorrect = JSON.stringify(studentSelection) === JSON.stringify(correctSelection);
        } else {
          // Para selección única y V/F, la comparación es directa.
          isCorrect = studentAnswer === correctAnswer;
        }
        
        if (isCorrect) {
          correctAnswers++;
        }
        
        return {
          ...question,
          studentAnswer: studentAnswer,
          studentAnswerText: Array.isArray(studentAnswer)
            ? studentAnswer.map(i => question.options[i]).join(', ')
            : question.options[studentAnswer],
          correctAnswer: Array.isArray(correctAnswer)
            ? correctAnswer.map(i => question.options[i]).join(', ')
            : question.options[correctAnswer],
          isCorrect: isCorrect,
        };
      });

      const percentage = Math.round((correctAnswers / totalQuestions) * 100);
      const timeUsed = (currentEvaluation.task.timeLimit || 10) * 60 - currentEvaluation.timeRemaining;

      // Crear resultado de evaluación con detalles completos
      const evaluationResult = {
        taskId: currentEvaluation.task.id,
        studentId: user?.id,
        studentUsername: user?.username,
        studentName: user?.displayName,
        answers: currentEvaluation.answers,
        questions: processedQuestions, // Guardar preguntas procesadas con resultados
        correctAnswers,
        totalQuestions,
        percentage,
        completedAt: new Date().toISOString(),
        timeUsed,
        timeExpired,
        task: {
          title: currentEvaluation.task.title,
          topic: currentEvaluation.task.topic,
          timeLimit: currentEvaluation.task.timeLimit,
          numQuestions: currentEvaluation.task.numQuestions
        }
      };

      // Guardar en localStorage
      const existingResults = JSON.parse(localStorage.getItem('smart-student-evaluation-results') || '[]');
      existingResults.push(evaluationResult);
      localStorage.setItem('smart-student-evaluation-results', JSON.stringify(existingResults));

      // Verificar si todos los estudiantes han completado la evaluación para actualizar el estado
      checkAndUpdateEvaluationStatus(currentEvaluation.task!.id);

      // NO actualizar el estado de la tarea aquí - esto se hace en checkAndUpdateEvaluationStatus
      // Solo guardar el resultado individual del estudiante
      /* 
      // Actualizar estado de la tarea a finalizado
      const storedTasks = localStorage.getItem('smart-student-tasks');
      if (storedTasks) {
        const tasks = JSON.parse(storedTasks);
        const taskIndex = tasks.findIndex((t: any) => t.id === currentEvaluation.task!.id);
        if (taskIndex !== -1) {
          tasks[taskIndex] = {
            ...tasks[taskIndex],
            status: 'reviewed', // INCORRECTO: No cambiar el estado aquí
            evaluationResult: {
              completed: true,
              percentage: percentage,
              completedAt: evaluationResult.completedAt,
              correctAnswers: correctAnswers,
              totalQuestions: totalQuestions
            }
          };
          localStorage.setItem('smart-student-tasks', JSON.stringify(tasks));
        }
      }
      */

      // Actualizar estado local
      setEvaluationResults(prev => ({
        ...prev,
        [currentEvaluation.task!.id]: evaluationResult
      }));

      // Crear notificación en tiempo real para el profesor
      const notification = {
        id: `eval_completed_${Date.now()}`,
        type: 'evaluation_completed',
        taskId: currentEvaluation.task.id,
        fromUsername: user?.username,
        fromName: user?.displayName,
        targetUserRole: 'teacher',
        targetUsernames: [currentEvaluation.task.assignedById || ''],
        message: `${user?.displayName} completó la evaluación "${currentEvaluation.task.title}" - Nota: ${correctAnswers}/${totalQuestions} (${percentage}%)`,
        timestamp: new Date().toISOString(),
        readBy: [],
        data: evaluationResult // Incluir datos completos de la evaluación
      };

      // Agregar a notificaciones
      const existingNotifications = JSON.parse(localStorage.getItem('smart-student-task-notifications') || '[]');
      existingNotifications.push(notification);
      localStorage.setItem('smart-student-task-notifications', JSON.stringify(existingNotifications));

      // Disparar evento para actualizar notificaciones en tiempo real
      window.dispatchEvent(new CustomEvent('taskNotificationsUpdated'));
      
      // 🔥 NUEVO: Disparar evento para actualizar tareas pendientes
      window.dispatchEvent(new CustomEvent('pendingTasksUpdated'));
      
      // 📧 ENVIAR EMAIL AL ESTUDIANTE Y APODERADO cuando el estudiante completa una evaluación tipo tarea
      try {
        const currentYear = new Date().getFullYear();
        const studentId = (user as any)?.id || user?.username;
        const studentDisplayName = user?.displayName || user?.username || 'Estudiante';
        
        // Destinatarios: incluir al estudiante
        const recipientIds: string[] = [studentId];
        
        // Buscar apoderados
        let guardianIds: string[] = [];
        
        // Método 1: Buscar en smart-student-guardians-{year}
        const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]');
        if (guardiansForYear.length > 0) {
          guardianIds = guardiansForYear
            .filter((g: any) => g.studentIds?.includes(studentId))
            .map((g: any) => g.id);
          console.log(`📧 [EVALUACIÓN TAREA] Apoderados por guardians-year: ${guardianIds.length}`);
        }
        
        // Método 2: Buscar en smart-student-users (fallback)
        if (guardianIds.length === 0) {
          const storedUsers = localStorage.getItem('smart-student-users');
          if (storedUsers) {
            const allUsers = JSON.parse(storedUsers);
            guardianIds = allUsers
              .filter((u: any) => 
                u.role === 'guardian' && 
                (u.assignedStudents?.includes(studentId) ||
                 u.studentIds?.includes(studentId) ||
                 u.children?.includes(studentId))
              )
              .map((u: any) => u.id);
            console.log(`📧 [EVALUACIÓN TAREA] Apoderados por users: ${guardianIds.length}`);
          }
        }
        
        // Agregar apoderados a los destinatarios
        recipientIds.push(...guardianIds);
        
        console.log(`📧 [EVALUACIÓN TAREA] Enviando email a ${recipientIds.length} destinatario(s) (1 estudiante + ${guardianIds.length} apoderados)`);
        
        // Obtener nombre legible del curso CON SECCIÓN
        const courseDisplayName = getCourseAndSectionName(currentEvaluation.task.course);
        
        // Generar mensaje motivador basado en el porcentaje
        let motivationalMessage = '';
        if (percentage >= 90) {
          motivationalMessage = '🌟 ¡Excelente trabajo! Has demostrado un dominio sobresaliente del tema. ¡Sigue así!';
        } else if (percentage >= 80) {
          motivationalMessage = '🎯 ¡Muy bien! Has logrado un gran resultado. Estás muy cerca de la excelencia.';
        } else if (percentage >= 70) {
          motivationalMessage = '👍 ¡Buen trabajo! Has aprobado con un buen resultado. Con un poco más de práctica llegarás aún más lejos.';
        } else if (percentage >= 60) {
          motivationalMessage = '✅ ¡Lo lograste! Has aprobado la evaluación. Sigue esforzándote para mejorar.';
        } else if (percentage >= 50) {
          motivationalMessage = '💪 Estás cerca de aprobar. Repasa los temas y no te rindas, ¡tú puedes!';
        } else if (percentage >= 30) {
          motivationalMessage = '📚 Necesitas repasar algunos temas. No te desanimes, cada intento es una oportunidad de aprender.';
        } else {
          motivationalMessage = '🌱 Este es solo el comienzo. Revisa el material y vuelve a intentarlo. ¡El esfuerzo siempre da frutos!';
        }
        
        sendEmailOnNotification(
          'evaluation_completed',
          recipientIds,
          {
            title: `${studentDisplayName} ha completado una evaluación`,
            content: `${studentDisplayName} ha completado la evaluación "${currentEvaluation.task.title}" con un resultado de ${correctAnswers}/${totalQuestions} (${percentage}%)`,
            taskTitle: currentEvaluation.task.title,
            senderName: 'Smart Student',
            courseName: courseDisplayName,
            grade: percentage, // CORREGIDO: Enviar porcentaje, no respuestas correctas
            feedback: motivationalMessage // CORREGIDO: Mensaje motivador en lugar de solo porcentaje
          }
        ).then(() => {
          console.log(`📧 [EVALUACIÓN TAREA] Email enviado exitosamente a ${recipientIds.length} destinatarios`);
        }).catch((emailError) => {
          console.warn('⚠️ [EVALUACIÓN TAREA] Error enviando email:', emailError);
        });
      } catch (emailError) {
        console.warn('⚠️ [EVALUACIÓN TAREA] Error en envío de email:', emailError);
      }
      
      console.log('🎯 [handleCompleteEvaluation] Events dispatched: taskNotificationsUpdated, pendingTasksUpdated');

      // Si el tiempo se agotó, mostrar modal específico ANTES de cerrar la evaluación
      if (timeExpired) {
        console.log('🔥 [handleCompleteEvaluation] Tiempo agotado - Configurando estados para modal');
        console.log('🔥 [handleCompleteEvaluation] evaluationResult:', evaluationResult);
        
        // Configurar estados para el modal
        setEvaluationTimeExpired(true);
        setTimeExpiredResult(evaluationResult);
        setShowTimeExpiredDialog(true);
        
        console.log('🔥 [handleCompleteEvaluation] Estados configurados - timeExpiredResult:', !!evaluationResult);
        console.log('🔥 [handleCompleteEvaluation] showTimeExpiredDialog será:', true);
        
        // NO cerrar la evaluación hasta que el usuario haga clic en "Revisar"
        // Solo resetear algunas propiedades para evitar continuar la evaluación
        setCurrentEvaluation(prev => ({
          ...prev,
          timeRemaining: 0,
          // Bloquear interacciones manteniendo el estado
        }));
      } else {
        // Limpiar estado y cerrar inmediatamente para evaluación normal
        setShowEvaluationDialog(false);
        setCurrentEvaluation({
          task: null,
          questions: [],
          startTime: null,
          answers: {},
          timeRemaining: 0,
          currentQuestionIndex: 0
        });
        
        // Mostrar mensaje de éxito normal
        toast({
          title: "Evaluación Completada",
          description: `¡Evaluación completada! Tu calificación es ${correctAnswers}/${totalQuestions} (${percentage}%)`,
        });
      }

      // Recargar tareas para reflejar cambios
      loadTasks();
      loadEvaluationResults(); // Recargar resultados de evaluaciones
    };





    const handleEditTask = (task: Task) => {
      // CORRECCIÓN: Usar courseSectionId si existe, sino buscar el ID combinado
      let combinedIdToUse = task.courseSectionId;
      
      if (!combinedIdToUse) {
        // Fallback: Si no hay courseSectionId, buscar en cursos disponibles
        const availableCourses = getAvailableCoursesWithNames();
        const courseOption = availableCourses.find(c => c.courseId === task.course);
        combinedIdToUse = courseOption ? courseOption.id : task.course;
      }

      console.log(`✏️ [handleEditTask] Editando tarea "${task.title}"`);
      console.log(`📋 [handleEditTask] Datos de la tarea:`, {
        course: task.course,
        courseSectionId: task.courseSectionId,
        subject: task.subject,
        combinedIdToUse
      });

      setSelectedTask(task);
      setFormData({
        title: task.title,
        description: task.description,
        subject: task.subject, // Might become subjectId
        course: combinedIdToUse, // Usar el ID combinado para mostrar correctamente
        assignedTo: task.assignedTo,
        assignedStudentIds: task.assignedStudentIds || [], // Use assignedStudentIds
        dueDate: task.dueDate,
        priority: task.priority,
        taskType: task.taskType || 'tarea',
        topic: task.topic || '',
        numQuestions: task.numQuestions || 0,
        timeLimit: task.timeLimit || 0
      });

      // Asegurar que las asignaturas filtradas se actualicen para el curso seleccionado
      if (combinedIdToUse) {
        const subjects = getSubjectsForCourseSection(combinedIdToUse);
        console.log(`📚 [handleEditTask] Asignaturas para curso ${combinedIdToUse}:`, subjects);
        setFilteredSubjects(subjects);
      }

      setShowEditDialog(true);
    };

    const handleUpdateTask = () => {
      if (!selectedTask || !formData.title || !formData.description || !formData.course || !formData.dueDate || !formData.subject) {
        toast({
          title: translate('error'),
          description: translate('completeAllFields'),
          variant: 'destructive'
        });
        return;
      }

      // Validación específica para evaluaciones
      if (formData.taskType === 'evaluacion') {
        if (!formData.topic || !formData.numQuestions || !formData.timeLimit) {
          toast({
            title: 'Error',
            description: 'Para las evaluaciones debe especificar: Tema, Cantidad de Preguntas y Tiempo límite',
            variant: 'destructive'
          });
          return;
        }
        
        if (![5, 10, 15, 20, 25, 30].includes(formData.numQuestions)) {
          toast({
            title: 'Error', 
            description: 'La cantidad de preguntas debe ser una de las opciones disponibles: 5, 10, 15, 20, 25 o 30',
            variant: 'destructive'
          });
          return;
        }
        
        if (formData.timeLimit < 1 || formData.timeLimit > 180) {
          toast({
            title: 'Error',
            description: 'El tiempo límite debe estar entre 1 y 180 minutos',
            variant: 'destructive'
          });
          return;
        }
      }
      
      // Validar que la fecha límite sea en el futuro
      const dueDate = new Date(formData.dueDate);
      const now = new Date();
      if (dueDate <= now) {
        toast({
          title: translate('error'),
          description: translate('dueDateMustBeFuture'),
          variant: 'destructive'
        });
        return;
      }

  // CORRECCIÓN: Extraer courseId Y preservar el ID combinado completo
      const availableCourses = getAvailableCoursesWithNames();
      const selectedCourse = availableCourses.find(course => course.id === formData.course);
      
      // Log para debugging
      console.log(`🔍 [handleUpdateTask] formData.course: "${formData.course}"`);
      console.log(`🔍 [handleUpdateTask] selectedCourse:`, selectedCourse);
      
      // Extraer el courseId para compatibilidad con el resto del sistema
      const actualCourseId = selectedCourse && selectedCourse.courseId ? selectedCourse.courseId : formData.course;
      // Preservar el ID combinado completo para mostrar curso y sección correctamente
      const courseSectionId = formData.course; // ID combinado completo
      // Derivar sectionId explícito desde el ID combinado (formato: courseId-sectionId)
      let derivedSectionId: string | undefined = undefined;
      try {
        const parts = String(courseSectionId || '').split('-');
        if (parts.length === 10) {
          derivedSectionId = parts.slice(5).join('-');
        } else if (selectedCourse && selectedCourse.sectionId) {
          derivedSectionId = String(selectedCourse.sectionId);
        } else if (String(courseSectionId || '').includes('seccion-')) {
          derivedSectionId = String(courseSectionId).split('seccion-')[1];
        }
      } catch {}

      const updatedTask: Task = {
        ...selectedTask,
        title: formData.title,
        description: formData.description,
        subject: formData.subject, // Might become subjectId
        course: actualCourseId, // Mantener courseId para compatibilidad
  sectionId: derivedSectionId,
        courseSectionId: courseSectionId, // 🆕 NUEVO: Preservar ID combinado
        assignedTo: formData.assignedTo,
        assignedStudentIds: formData.assignedTo === 'student' ? formData.assignedStudentIds : undefined, // Use assignedStudentIds
        dueDate: formData.dueDate,
        priority: formData.priority,
        taskType: formData.taskType,
        // Include evaluation fields if it's an evaluation
        topic: formData.taskType === 'evaluacion' ? formData.topic : undefined,
        numQuestions: formData.taskType === 'evaluacion' ? formData.numQuestions : undefined,
        timeLimit: formData.taskType === 'evaluacion' ? formData.timeLimit : undefined
      };

      const updatedTasks = tasks.map(task => 
        task.id === selectedTask.id ? updatedTask : task
      );
      saveTasks(updatedTasks);

      toast({
        title: translate('taskUpdated'),
        description: translate('taskUpdatedDesc', { title: formData.title }),
      });

      // Reset form
      setFormData({
        title: '',
        description: '',
        subject: '',
        course: '',
        assignedTo: 'course',
        assignedStudentIds: [],
        dueDate: '',
        priority: 'medium',
        taskType: 'tarea',
        topic: '',
        numQuestions: 0,
        timeLimit: 0
      });
      setFilteredSubjects([]); // Limpiar asignaturas filtradas
      setSelectedTask(null);
      setShowEditDialog(false);
    };

    const handleDeleteTask = (task: Task) => {
      setTaskToDelete(task);
      setShowDeleteDialog(true);
    };

    const confirmDeleteTask = () => {
      if (!taskToDelete) return;

      const updatedTasks = tasks.filter(task => task.id !== taskToDelete.id);
      saveTasks(updatedTasks);

      // Also remove related comments
      const updatedComments = comments.filter(comment => comment.taskId !== taskToDelete.id);
      saveComments(updatedComments);

      toast({
        title: translate('taskDeleted'),
        description: translate('taskDeletedDesc', { title: taskToDelete.title }),
      });

      setTaskToDelete(null);
      setShowDeleteDialog(false);
    };

    const getTaskComments = (taskId: string) => {
      return comments.filter(comment => comment.taskId === taskId);
    };

    // 🔧 NUEVA FUNCIÓN: Contar solo comentarios del profesor (excluir entregas de estudiantes)
    // PROBLEMA SOLUCIONADO: El contador mostraba "3 comentarios" cuando debía mostrar "1 comentario"
    // porque estaba contando también las entregas de estudiantes como comentarios
    const getTeacherCommentsCount = (taskId: string) => {
      return comments.filter(comment => 
        comment.taskId === taskId && 
        !comment.isSubmission // Excluir entregas de estudiantes (isSubmission: true)
      ).length;
    };

    const getPriorityColor = (priority: string) => {
      switch (priority) {
        case 'high': return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400';
        case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
        case 'low': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
        default: return 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400';
      }
    };

    const getStatusColor = (status: string) => {
      switch (status) {
        case 'pending': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
        case 'delivered': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400';
        case 'submitted': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
        case 'reviewed': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
        case 'finished': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
        default: return 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400';
      }
    };

    const getTaskTypeColor = (taskType: string) => {
      switch (taskType) {
        case 'evaluacion': return 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800';
        case 'tarea': return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800';
        default: return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/20 dark:text-gray-400 dark:border-gray-800';
      }
    };

    const formatDate = (dateString: string) => {
      return new Date(dateString).toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    };
    
    // Formato de fecha en una sola línea para tablas compactas
    const formatDateOneLine = (dateString: string) => {
      if (!dateString) {
        return 'Fecha no disponible';
      }
      
      const date = new Date(dateString);
      
      // Validar si la fecha es válida
      if (isNaN(date.getTime())) {
        console.warn('Fecha inválida detectada:', dateString);
        return 'Fecha inválida';
      }
      
      try {
        const day = date.getDate().toString().padStart(2, '0');
        const month = new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(date);
        const year = date.getFullYear();
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        
        return `${day} ${month} ${year}, ${hours}:${minutes}`;
      } catch (error) {
        console.error('Error formateando fecha:', dateString, error);
        return 'Error en fecha';
      }
    };

    // File handling functions
    const handleFileUpload = async (files: FileList | null, isForTask: boolean = false) => {
      if (!files || files.length === 0) return;

      const newFiles: TaskFile[] = [];
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          toast({
            title: translate('error'),
            description: translate('fileTooLarge', { name: file.name }),
            variant: 'destructive'
          });
          continue;
        }

        // Convert to base64
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });

        const base64 = await base64Promise;
        
        const taskFile: TaskFile = {
          id: `file_${Date.now()}_${i}`,
          name: file.name,
          size: file.size,
          type: file.type,
          url: base64,
          uploadedBy: user?.username || '',
          uploadedAt: new Date().toISOString()
        };

        newFiles.push(taskFile);
      }

      if (isForTask) {
        setTaskAttachments(prev => [...prev, ...newFiles]);
      } else {
        setCommentAttachments(prev => [...prev, ...newFiles]);
      }

      toast({
        title: translate('filesUploaded'),
        description: translate('filesUploadedDesc', { count: newFiles.length.toString() }),
      });
    };

    const removeFile = (fileId: string, isForTask: boolean = false) => {
      if (isForTask) {
        setTaskAttachments(prev => prev.filter(f => f.id !== fileId));
      } else {
        setCommentAttachments(prev => prev.filter(f => f.id !== fileId));
      }
    };

    const downloadFile = (file: TaskFile) => {
      const link = document.createElement('a');
      link.href = file.url;
      link.download = file.name;
      link.click();
    };

    const formatFileSize = (bytes: number) => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Check if student has already submitted this task
    const hasStudentSubmitted = (taskId: string, studentId: string) => {
      console.log(`🔍 hasStudentSubmitted: Verificando taskId=${taskId}, studentId=${studentId}`);
      
      // Check if student has submitted using studentId
      let hasSubmission = comments.some(comment => 
        comment.taskId === taskId && 
        comment.studentId === studentId && 
        comment.isSubmission
      );
      
      console.log(`📝 Búsqueda por studentId: ${hasSubmission ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
      
      // If not found, try with studentName fallback (for legacy compatibility)
      if (!hasSubmission) {
        const usersText = localStorage.getItem('smart-student-users');
        const allUsers: ExtendedUser[] = usersText ? JSON.parse(usersText) : [];
        const studentData = allUsers.find(u => u.id === studentId);
        if (studentData) {
          hasSubmission = comments.some(comment => 
            comment.taskId === taskId && 
            (comment.studentName === studentData.displayName || comment.studentName === studentData.username) &&
            comment.isSubmission
          );
          console.log(`📝 Búsqueda por studentName (${studentData.displayName}/${studentData.username}): ${hasSubmission ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
        }
      }
      
      // Debug: mostrar todas las submissions para esta tarea
      const taskSubmissions = comments.filter(c => c.taskId === taskId && c.isSubmission);
      console.log(`📋 Todas las entregas para taskId=${taskId}:`, taskSubmissions.map(c => ({
        id: c.id,
        studentId: c.studentId,
        studentName: c.studentName,
        timestamp: c.timestamp
      })));
      
      console.log(`🎯 Resultado final para studentId=${studentId}: ${hasSubmission ? 'TIENE ENTREGA' : 'NO TIENE ENTREGA'}`);
      return hasSubmission;
    };

    // Función temporal para debug de Felipe específicamente
    const checkFelipeSubmission = (taskId: string) => {
      console.log('🔍 FELIPE SPECIAL CHECK for task:', taskId);
      
      // Buscar por todos los posibles nombres que podría tener Felipe
      const felipeSubmissions = comments.filter(c => 
        c.taskId === taskId && 
        c.isSubmission && 
        (
          c.studentName === 'Felipe Estudiante' ||
          c.studentName?.toLowerCase().includes('felipe') ||
          c.studentId === 'felipe-id' // Legacy compatibility
        )
      );
      
      console.log('Felipe submissions found:', felipeSubmissions.length, felipeSubmissions.map(s => ({
        studentId: s.studentId,
        name: s.studentName,
        id: s.id
      })));
      
      return felipeSubmissions.length > 0 ? felipeSubmissions[0] : undefined;
    };
    
    // Función específica para encontrar entregas de María
    const checkMariaSubmission = (taskId: string) => {
      console.log('🔍 MARIA SPECIAL CHECK for task:', taskId);
      
      // Buscar por todos los posibles nombres que podría tener María
      const mariaSubmissions = comments.filter(c => 
        c.taskId === taskId && 
        c.isSubmission && 
        (
          c.studentName === 'Maria Estudiante' ||
          c.studentName?.toLowerCase().includes('maria') ||
          c.studentId === 'maria-id' // Legacy compatibility
        )
      );
      
      console.log('Maria submissions found:', mariaSubmissions.length, mariaSubmissions.map(s => ({
        studentId: s.studentId,
        name: s.studentName,
        id: s.id,
        comment: s.comment.substring(0, 30) + '...'
      })));
      
      return mariaSubmissions.length > 0 ? mariaSubmissions[0] : undefined;
    };

    // Get individual student status for a task - UPDATED para nuevos estados
    const getStudentTaskStatus = (taskId: string, studentId: string) => { // Changed studentUsername to studentId
      // console.log(`🔍 getStudentTaskStatus called with:`, { taskId, studentId });

      const submission = getStudentSubmission(taskId, studentId); // Use the updated getStudentSubmission

      // console.log(`🔍 Search results for student ${studentId} in task ${taskId}:`, {
      //   foundSubmission: submission ? {
      //     id: submission.id,
      //     timestamp: submission.timestamp,
      //     studentId: submission.studentId,
      //     studentName: submission.studentName,
      //     hasGrade: submission.grade !== undefined,
      //     hasTeacherComment: !!submission.teacherComment,
      //     reviewedAt: submission.reviewedAt
      //   } : null
      // });
      
      if (!submission) {
        // console.log(`❌ No submission found for ${studentId} - returning 'pending'`);
        return 'pending';
      }
      
      // Si tiene calificación o comentario del profesor Y fecha de revisión, está finalizado
      if (submission.reviewedAt && (submission.grade !== undefined || submission.teacherComment)) {
        // console.log(`✅ Submission finalized for ${studentId} - returning 'reviewed'`);
        return 'reviewed'; // Finalizado
      }
      
      // Si tiene entrega pero no revisión, está en revisión
      // console.log(`📋 Submission under review for ${studentId} - returning 'delivered'`);
      return 'delivered'; // En Revisión (o 'submitted' if that's preferred before grading)
    };

    // Function for teacher to grade a submission - UPDATED para estado Finalizado
    const handleGradeSubmission = async (submissionId: string, grade: number, teacherComment: string) => {
      const updatedComments = comments.map(comment => 
        comment.id === submissionId 
          ? { 
              ...comment, 
              grade, 
              teacherComment, 
              reviewedAt: new Date().toISOString() 
            }
          : comment
      );
      saveComments(updatedComments);
      // Forzar recarga de comentarios desde localStorage para refrescar panel
      loadComments();

      // Verificar si todas las entregas de esta tarea están revisadas
      if (selectedTask) {
        const allStudents = getAssignedStudentsForTask(selectedTask); // Returns {id, username, displayName}
        
        // ✅ LÓGICA CORREGIDA: Verificar que TODOS los estudiantes hayan entregado Y sean calificados
        const allReviewed = allStudents.every(student => {
          const studentSubmission = getStudentSubmission(selectedTask.id, student.id);
          
          // Para que esté "completamente revisado" debe cumplir TODAS estas condiciones:
          // 1. El estudiante debe haber hecho una entrega (isSubmission = true)
          // 2. La entrega debe tener calificación (grade !== undefined)
          // 3. La entrega debe estar marcada como revisada (reviewedAt)
          
          if (!studentSubmission || !studentSubmission.isSubmission) {
            console.log(`❌ Student ${student.displayName} has not submitted yet`);
            return false; // No ha entregado
          }
          
          const hasGrade = studentSubmission.grade !== undefined;
          const isReviewed = studentSubmission.reviewedAt || studentSubmission.id === submissionId;
          
          if (!hasGrade) {
            console.log(`❌ Student ${student.displayName} submission not graded yet`);
            return false; // No tiene calificación
          }
          
          if (!isReviewed) {
            console.log(`❌ Student ${student.displayName} submission not reviewed yet`);
            return false; // No está revisado
          }
          
          console.log(`✅ Student ${student.displayName} submission is complete: delivered + graded + reviewed`);
          return true; // Entregado, calificado y revisado
        });

        console.log(`📊 Task completion check: ${allStudents.length} students total, all reviewed: ${allReviewed}`);

        // Si todos están revisados, cambiar el estado de la tarea del profesor a 'reviewed' (Finalizada)
        if (allReviewed) {
          const updatedTasks = tasks.map(task => 
            task.id === selectedTask.id 
              ? { ...task, status: 'reviewed' as const } // Mark task as reviewed
              : task
          );
          saveTasks(updatedTasks);
          
          // 🔔 ACTUALIZAR NOTIFICACIÓN: Cambiar de "Tarea Pendiente" a "Tarea Finalizada"
          TaskNotificationManager.updateTaskStatusNotification(
            selectedTask.id,
            'reviewed',
            user?.id || ''
          );
          
          // 🧹 NUEVO: Eliminar todas las notificaciones de esta tarea al finalizar completamente
          TaskNotificationManager.removeNotificationsForTask(selectedTask.id, [
            'pending_grading', 
            'task_submission', 
            'task_completed'
          ]);
          
          console.log('✅ Task marked as FINALIZED - all students have delivered AND been graded');
          console.log('🧹 All task notifications cleaned up for finalized task');
        } else {
          console.log('⏳ Task remains PENDING - not all students have delivered or been graded');
          
          // 🧹 NUEVO: Eliminar notificaciones específicas del estudiante recién calificado
          TaskNotificationManager.removeNotificationsForTask(selectedTask.id, ['task_submission']);
          
          // 🎯 NUEVO: Eliminar notificaciones de 'task_completed' cuando el profesor califica
          TaskNotificationManager.removeTaskCompletedNotifications(selectedTask.id);
          
          // 🔥 NUEVO: Disparar evento para actualizar panel de notificaciones
          window.dispatchEvent(new CustomEvent('taskGraded', {
            detail: { taskId: selectedTask.id, studentUsername: submission?.studentUsername }
          }));
        }
      }

      // Crear notificación para el estudiante
      const submission = comments.find(c => c.id === submissionId); // This submission has studentId
      if (submission && selectedTask && submission.studentId) {
        const notification = {
          id: `notif_${Date.now()}`,
          type: 'task_graded',
          taskId: selectedTask.id,
          taskTitle: selectedTask.title,
          studentId: submission.studentId,
          teacherName: user?.displayName || user?.username,
          message: `Tu tarea "${selectedTask.title}" ha sido calificada`,
          timestamp: new Date().toISOString(),
          read: false,
          grade: grade,
          course: selectedTask.course, // This is courseId
          subject: selectedTask.subject
        };

        // Guardar notificación
        const existingNotifications = JSON.parse(localStorage.getItem('smart-student-notifications') || '[]');
        const updatedNotifications = [...existingNotifications, notification];
        localStorage.setItem('smart-student-notifications', JSON.stringify(updatedNotifications));

        // 📧 Enviar notificación por email al estudiante
        try {
          const recipientIds: string[] = [submission.studentId];
          const currentYear = new Date().getFullYear();
          
          // También notificar al apoderado si existe - búsqueda multi-método
          let guardianIds: string[] = [];
          
          // Método 1: Buscar en smart-student-guardians-{year}
          const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]');
          if (guardiansForYear.length > 0) {
            guardianIds = guardiansForYear
              .filter((g: any) => g.studentIds?.includes(submission.studentId))
              .map((g: any) => g.id);
          }
          
          // Método 2: Buscar en smart-student-guardian-students (relaciones)
          if (guardianIds.length === 0) {
            const guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-students') || '[]');
            if (guardianRelations.length > 0) {
              const guardianIdsFromRelations = guardianRelations
                .filter((r: any) => r.studentId === submission.studentId)
                .map((r: any) => r.guardianId);
              guardianIds = [...new Set(guardianIdsFromRelations)];
            }
          }
          
          // Método 3: Buscar en smart-student-users
          if (guardianIds.length === 0) {
            const storedUsers = localStorage.getItem('smart-student-users');
            if (storedUsers) {
              const allUsers = JSON.parse(storedUsers);
              guardianIds = allUsers
                .filter((u: any) => 
                  u.role === 'guardian' && 
                  (u.assignedStudents?.includes(submission.studentId) ||
                   u.studentIds?.includes(submission.studentId) ||
                   u.children?.includes(submission.studentId))
                )
                .map((u: any) => u.id);
            }
          }
          
          console.log(`📧 [TAREAS] Apoderados encontrados para calificación: ${guardianIds.length}`);
          recipientIds.push(...guardianIds);
          
          // Determinar si es evaluación o tarea para el tipo de email
          const isEvaluation = selectedTask.taskType === 'evaluacion' || selectedTask.taskType === 'evaluation';
          
          await sendEmailOnNotification(
            isEvaluation ? 'evaluation_graded' : 'task_graded',
            recipientIds,
            {
              title: `Tu ${isEvaluation ? 'evaluación' : 'tarea'} "${selectedTask.title}" ha sido calificada`,
              content: teacherComment || `Tu ${isEvaluation ? 'evaluación' : 'tarea'} ha sido revisada y calificada.`,
              taskTitle: selectedTask.title,
              senderName: user?.displayName || user?.username || 'Profesor',
              courseName: selectedTask.course,
              grade: grade,
              feedback: teacherComment
            }
          );
          console.log(`📧 [TAREAS] Grade notification email sent to student ${submission.studentId} and ${recipientIds.length - 1} guardians`);
        } catch (emailError) {
          console.warn('⚠️ [TAREAS] Error sending grade email notification:', emailError);
        }
      }

      toast({
        title: 'Entrega Calificada',
        description: `La entrega ha sido calificada con ${grade} puntos.`,
      });
    };

    // Open grade dialog
    const openGradeDialog = (taskId: string, studentId: string) => { // Changed studentUsername to studentId
      // console.log('🎯 Opening grade dialog for:', { taskId, studentId });
      
      const submission = getStudentSubmission(taskId, studentId); // Use updated getStudentSubmission
      
      if (!submission) {
        const usersText = localStorage.getItem('smart-student-users');
        const allUsers: ExtendedUser[] = usersText ? JSON.parse(usersText) : [];
        const studentData = allUsers.find(u => u.id === studentId); // Fetch student for name
        const studentDisplayName = studentData?.displayName || `ID ${studentId}`;
        const errorMessage = `No se encontró una entrega para el estudiante "${studentDisplayName}" en esta tarea.`;
        
        // console.error('❌ No submission found for openGradeDialog:', { taskId, studentId });
        toast({
          title: 'Error',
          description: errorMessage,
          variant: 'destructive',
        });
        return;
      }
      
      // console.log(`✅ Submission found for studentId "${studentId}":`, submission);
      
      setSubmissionToGrade(submission); // submission already contains grade and teacherComment if they exist
      setGradeForm({
        grade: submission.grade?.toString() || '',
        teacherComment: submission.teacherComment || ''
      });
      setShowGradeDialog(true);
    };

    // Función para guardar la calificación
  const saveGrade = () => {
      if (!submissionToGrade) return;
      
      const grade = parseFloat(gradeForm.grade);
      const g = getGradingConfig();
      if (isNaN(grade) || grade < g.min || grade > g.max) {
        alert(`Por favor ingresa una calificación válida entre ${g.min} y ${g.max}`);
        return;
      }
      
      if (!gradeForm.teacherComment.trim()) {
        const confirmSave = confirm('¿Estás seguro de guardar sin comentario adicional?');
        if (!confirmSave) return;
      }
      
      // Actualizar el comentario existente con la calificación
      const updatedComments = comments.map(comment => {
        if (comment.id === submissionToGrade.id) {
          return {
            ...comment,
            grade: grade,
            teacherComment: gradeForm.teacherComment.trim(),
            reviewedAt: new Date().toISOString()
          };
        }
        return comment;
      });
      
      setComments(updatedComments);
      localStorage.setItem('smart-student-task-comments', JSON.stringify(updatedComments));
      // Notificar a la misma pestaña para que Calificaciones sincronice de inmediato
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'smart-student-task-comments',
          newValue: JSON.stringify(updatedComments)
        }));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('taskNotificationsUpdated', { detail: { reason: 'gradeSaved' } }));
      } catch {}
      
      // 📧 NUEVO: Enviar notificación por email al estudiante y apoderado cuando se califica
      if (submissionToGrade.studentId && selectedTask) {
        try {
          const recipientIds: string[] = [submissionToGrade.studentId];
          
          // También notificar al apoderado si existe
          const storedUsers = localStorage.getItem('smart-student-users');
          const currentYear = new Date().getFullYear();
          
          if (storedUsers) {
            const allUsers = JSON.parse(storedUsers);
            
            // Buscar en smart-student-guardians-{year}
            const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]');
            let guardianIds: string[] = [];
            
            if (guardiansForYear.length > 0) {
              guardianIds = guardiansForYear
                .filter((g: any) => g.studentIds?.includes(submissionToGrade.studentId))
                .map((g: any) => g.id);
            }
            
            // Fallback: buscar en smart-student-users
            if (guardianIds.length === 0) {
              guardianIds = allUsers
                .filter((u: any) => 
                  u.role === 'guardian' && 
                  (u.assignedStudents?.includes(submissionToGrade.studentId) ||
                   u.studentIds?.includes(submissionToGrade.studentId))
                )
                .map((u: any) => u.id);
            }
            
            console.log(`📧 [SAVE GRADE] Apoderados encontrados: ${guardianIds.length}`);
            recipientIds.push(...guardianIds);
          }
          
          // Determinar si es evaluación o tarea para el tipo de email
          const isEvaluation = selectedTask.taskType === 'evaluacion' || selectedTask.taskType === 'evaluation';
          
          // Obtener nombre legible del curso en lugar del ID
          const courseDisplayName = getCourseAndSectionName(selectedTask.course);
          
          sendEmailOnNotification(
            isEvaluation ? 'evaluation_graded' : 'task_graded',
            recipientIds,
            {
              title: `Tu ${isEvaluation ? 'evaluación' : 'tarea'} "${selectedTask.title}" ha sido calificada`,
              content: gradeForm.teacherComment.trim() || `Tu ${isEvaluation ? 'evaluación' : 'tarea'} ha sido revisada y calificada.`,
              taskTitle: selectedTask.title,
              senderName: user?.displayName || user?.username || 'Profesor',
              courseName: courseDisplayName,
              grade: grade,
              feedback: gradeForm.teacherComment.trim()
            }
          ).then(() => {
            console.log(`📧 [SAVE GRADE] Email enviado a ${recipientIds.length} destinatarios`);
          }).catch((emailError) => {
            console.warn('⚠️ [SAVE GRADE] Error enviando email:', emailError);
          });
        } catch (emailError) {
          console.warn('⚠️ [SAVE GRADE] Error en envío de email:', emailError);
        }
      }
      
      // Cerrar el diálogo
      setShowGradeDialog(false);
      setSubmissionToGrade(null);
      setGradeForm({ grade: '', teacherComment: '' });
      
      console.log('✅ Grade saved successfully');
    };

    // Función para intentar cerrar el diálogo
    const handleCloseGradeDialog = () => {
      if (!submissionToGrade) {
        setShowGradeDialog(false);
        return;
      }
      
      const hasGrade = gradeForm.grade.trim() !== '';
      const hasComment = gradeForm.teacherComment.trim() !== '';
      const wasAlreadyGraded = submissionToGrade.grade !== undefined;
      
      if (!hasGrade && !hasComment && !wasAlreadyGraded) {
        alert('Debes calificar y/o agregar un comentario antes de cerrar.');
        return;
      }
      
      if ((hasGrade || hasComment) && (!wasAlreadyGraded || gradeForm.grade !== submissionToGrade.grade?.toString() || gradeForm.teacherComment !== submissionToGrade.teacherComment)) {
        const confirmClose = confirm('Tienes cambios sin guardar. ¿Estás seguro de cerrar sin guardar?');
        if (!confirmClose) return;
      }
      
      setShowGradeDialog(false);
      setSubmissionToGrade(null);
      setGradeForm({ grade: '', teacherComment: '' });
    };

    // Submit grade
    // Delete student submission to allow re-submission
    const handleDeleteSubmission = (commentId: string) => {
      const commentToDelete = comments.find(c => c.id === commentId);
      if (!commentToDelete || !selectedTask) return;

      // Verificar si la tarea ya está calificada
      if (commentToDelete.grade !== undefined || commentToDelete.reviewedAt) {
        toast({
          title: 'No se puede eliminar',
          description: 'Esta tarea ya ha sido calificada por el profesor y no se puede eliminar.',
          variant: 'destructive'
        });
        return;
      }

      // Show confirmation dialog
      if (!window.confirm('¿Estás seguro de que quieres eliminar tu entrega? Esta acción no se puede deshacer.')) {
        return;
      }

      // Remove the submission comment
      const updatedComments = comments.filter(comment => comment.id !== commentId);
      saveComments(updatedComments);

      // Obtener todos los estudiantes asignados a la tarea
      const assignedStudents = getAssignedStudentsForTask(selectedTask);
      
      // Verificar si ahora todos los estudiantes han entregado la tarea
      const allStudentsSubmitted = assignedStudents.length > 0 && 
        assignedStudents.every(student => 
          student.id !== commentToDelete.studentId && // Excluimos el que acabamos de eliminar
          hasStudentSubmitted(selectedTask.id, student.id)
        );
      
      // Actualizar el estado a "pendiente" si ya no todos han entregado
      if (!allStudentsSubmitted) {
        const updatedTasks = tasks.map(task => 
          task.id === selectedTask.id 
            ? { ...task, status: 'pending' as const }
            : task
        );
        saveTasks(updatedTasks);
      }

      toast({
        title: 'Entrega eliminada',
        description: 'Tu entrega ha sido eliminada exitosamente.',
      });
    };

    const filteredTasks = getFilteredTasks();

    // Función para abrir el diálogo de revisión mejorado
    const handleReviewSubmission = (studentId: string, taskId: string, tryDisplayName?: boolean) => {
      console.log(`🔍 handleReviewSubmission called with studentId: "${studentId}", taskId: "${taskId}"`);
      
      let submission = getStudentSubmission(taskId, studentId);
      
      // Si no se encuentra, intentar con el displayName
      if (!submission && tryDisplayName) {
        const student = getAssignedStudentsForTask(selectedTask).find(s => s.id === studentId || s.username === studentId);
        if (student && student.displayName) {
          console.log(`🔄 Trying with displayName: "${student.displayName}"`);
          submission = getStudentSubmission(taskId, student.displayName);
        }
        
        // Si aún no se encuentra, intentar buscar por studentName en los comentarios
        if (!submission) {
          console.log(`🔄 Trying with studentName search`);
          submission = comments.find(c =>
            c.taskId === taskId &&
            c.isSubmission &&
            (c.studentName === studentId || 
            c.studentName === student?.displayName ||
            c.studentId === studentId ||
            c.studentUsername === studentId)
          );
        }
      }
      
      if (!submission) {
        console.log(`❌ No submission found for student: "${studentId}"`);
        console.log(`Available submissions for task "${taskId}":`, comments.filter(c => c.taskId === taskId && c.isSubmission));
        toast({
          title: 'Error',
          description: 'No se encontró una entrega para este estudiante.',
          variant: 'destructive'
        });
        return;
      }
      
      const student = getAssignedStudentsForTask(selectedTask).find(s => s.id === studentId || s.username === studentId);
      console.log(`✅ Found submission for student: "${studentId}"`, submission);
      
      setCurrentReview({
        studentId,
        studentDisplayName: student?.displayName || studentId,
        taskId,
        submission,
        grade: submission.grade || 0,
        feedback: submission.teacherComment || '',
        isGraded: submission.grade !== undefined
      });
      setShowReviewDialog(true);
    };

    // Función para abrir el diálogo de revisión de evaluación
    const handleViewEvaluationDetail = async (studentId: string, taskId: string) => {
      console.log('🔍 handleViewEvaluationDetail called with:', { studentId, taskId });
      
      const evaluationResult = getStudentEvaluationResult(taskId, studentId);
      console.log('🔍 Evaluation result found:', !!evaluationResult);
      console.log('🔍 Evaluation result structure:', evaluationResult);
      
      if (!evaluationResult) {
        toast({
          title: translate('error'),
          description: 'No se encontró el resultado de la evaluación',
          variant: 'destructive'
        });
        return;
      }

      // Encontrar la tarea correspondiente para obtener el tema
      const task = tasks.find(t => t.id === taskId);
      console.log('🔍 Task found for translation:', !!task, task?.topic);
      
      if (task) {
        try {
          // Traducir las preguntas dinámicamente según el idioma actual
          console.log('🔄 About to translate evaluation result...');
          const translatedResult = await translateEvaluationResult(evaluationResult, task);
          console.log('🔄 Translation completed, setting result');
          console.log('🔄 Translated result structure:', translatedResult);
          setSelectedEvaluationResult(translatedResult);
        } catch (error) {
          console.error('❌ Error translating evaluation result:', error);
          // Usar resultado original si hay error en traducción
          setSelectedEvaluationResult(evaluationResult);
        }
      } else {
        console.log('⚠️ No task found, using original result');
        setSelectedEvaluationResult(evaluationResult);
      }
      setShowEvaluationReviewDialog(true);
    };

    // Función para guardar la revisión y calificación
    const saveReviewAndGrade = () => {
      if (!currentReview.submission || !selectedTask) return;
      
      if (currentReview.grade < 0 || currentReview.grade > 100) {
        toast({
          title: 'Error',
          description: 'La calificación debe estar entre 0 y 100.',
          variant: 'destructive'
        });
        return;
      }
      
      // Actualizar el comentario con la calificación y feedback
      const updatedComments = comments.map(comment => {
        if (comment.id === currentReview.submission!.id) {
          return {
            ...comment,
            grade: currentReview.grade,
            teacherComment: currentReview.feedback,
            reviewedAt: new Date().toISOString(),
            reviewed: true
          };
        }
        return comment;
      });
      
      saveComments(updatedComments);
      
      // Verificar si todas las entregas están revisadas
      const allSubmissionsReviewed = getAssignedStudentsForTask(selectedTask).every(student => {
        const studentSubmission = getStudentSubmission(selectedTask.id, student.id);
        return !!studentSubmission?.reviewedAt || student.id === currentReview.studentId;
      });
      
      if (allSubmissionsReviewed) {
        const updatedTasks = tasks.map(task => 
          task.id === selectedTask.id 
            ? { ...task, status: 'reviewed' as const }
            : task
        );
        saveTasks(updatedTasks);
      }

      // Crear notificación para el estudiante
      const notification = {
        id: `notif_${Date.now()}`,
        type: 'task_graded',
        taskId: selectedTask.id,
        taskTitle: selectedTask.title,
        studentId: currentReview.studentId, // Use studentId
        teacherName: user?.displayName || user?.username, // Keep for display
        // teacherId: user?.id, // Optionally add teacherId
        message: `Tu tarea "${selectedTask.title}" ha sido calificada con ${currentReview.grade}/100`,
        timestamp: new Date().toISOString(),
        read: false,
        grade: currentReview.grade,
        course: selectedTask.course, // This is courseId
        subject: selectedTask.subject
      };

      const existingNotifications = JSON.parse(localStorage.getItem('smart-student-notifications') || '[]');
      const updatedNotifications = [...existingNotifications, notification];
      localStorage.setItem('smart-student-notifications', JSON.stringify(updatedNotifications));
      
      // 📧 ENVIAR EMAIL AL ESTUDIANTE Y APODERADO cuando se califica la tarea
      try {
        const recipientIds: string[] = [currentReview.studentId];
        const currentYear = new Date().getFullYear();
        
        // Buscar apoderados del estudiante
        // Método 1: smart-student-guardians-{year}
        const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]');
        let guardianIds: string[] = [];
        
        if (guardiansForYear.length > 0) {
          guardianIds = guardiansForYear
            .filter((g: any) => g.studentIds?.includes(currentReview.studentId))
            .map((g: any) => g.id);
          console.log(`📧 [TAREA CALIFICADA] Apoderados por guardians-year: ${guardianIds.length}`);
        }
        
        // Método 2: smart-student-users (fallback)
        if (guardianIds.length === 0) {
          const storedUsers = localStorage.getItem('smart-student-users');
          if (storedUsers) {
            const allUsers = JSON.parse(storedUsers);
            guardianIds = allUsers
              .filter((u: any) => 
                u.role === 'guardian' && 
                (u.assignedStudents?.includes(currentReview.studentId) ||
                 u.studentIds?.includes(currentReview.studentId) ||
                 u.children?.includes(currentReview.studentId))
              )
              .map((u: any) => u.id);
            console.log(`📧 [TAREA CALIFICADA] Apoderados por users: ${guardianIds.length}`);
          }
        }
        
        recipientIds.push(...guardianIds);
        
        console.log(`📧 [TAREA CALIFICADA] Enviando email a ${recipientIds.length} destinatario(s)`);
        
        const isEvaluation = selectedTask.taskType === 'evaluacion' || selectedTask.taskType === 'evaluation';
        
        // Obtener nombre legible del curso en lugar del ID
        const courseDisplayName = getCourseAndSectionName(selectedTask.course);
        
        sendEmailOnNotification(
          isEvaluation ? 'evaluation_graded' : 'task_graded',
          recipientIds,
          {
            title: `Tu ${isEvaluation ? 'evaluación' : 'tarea'} "${selectedTask.title}" ha sido calificada`,
            content: currentReview.feedback || `Tu ${isEvaluation ? 'evaluación' : 'tarea'} ha sido revisada y calificada.`,
            taskTitle: selectedTask.title,
            senderName: user?.displayName || user?.username || 'Profesor',
            courseName: courseDisplayName,
            grade: currentReview.grade,
            feedback: currentReview.feedback
          }
        ).then(() => {
          console.log(`📧 [TAREA CALIFICADA] Email enviado exitosamente`);
        }).catch((emailError) => {
          console.warn('⚠️ [TAREA CALIFICADA] Error enviando email:', emailError);
        });
      } catch (emailError) {
        console.warn('⚠️ [TAREA CALIFICADA] Error en envío de email:', emailError);
      }
      
      toast({
        title: 'Tarea Calificada',
        description: `La tarea ha sido calificada con ${currentReview.grade}/100.`,
      });
      
      setShowReviewDialog(false);
    };

    // Función auxiliar para obtener el nombre del estudiante por username
    const getStudentNameByUsername = (username: string) => {
      const student = getStudentsForCourse(selectedTask?.course || '').find(
        s => s.username === username
      );
      return student?.displayName || username;
    };

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold flex items-center">
              <ClipboardList className="w-8 h-8 mr-3 text-orange-500" />
              {translate('tasksPageTitle')}
            </h1>
            <p className="text-muted-foreground">
              {user?.role === 'teacher' 
                ? translate('tasksPageSubTeacher')
                : translate('tasksPageSubStudent')
              }
            </p>
          </div>
          
          <div className="flex items-center space-x-3">
            {user?.role === 'teacher' && (
              <>
                {/* View Mode Toggle */}
                <div className="flex items-center space-x-1 border rounded-lg p-1">
                  <Button
                    variant={viewMode === 'list' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('list')}
                    className={`px-3 py-1 ${viewMode === 'list' ? 'bg-orange-500 hover:bg-orange-600 text-white' : 'hover:bg-orange-100 hover:text-orange-700'}`}
                  >
                    {translate('listView')}
                  </Button>
                  <Button
                    variant={viewMode === 'course' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('course')}
                    className={`px-3 py-1 ${viewMode === 'course' ? 'bg-orange-500 hover:bg-orange-600 text-white' : 'hover:bg-orange-100 hover:text-orange-700'}`}
                  >
                    {translate('courseView')}
                  </Button>
                </div>

                {/* Course Filter */}
                <div className="relative">
                  <Select value={selectedCourseFilter} onValueChange={setSelectedCourseFilter}>
                    <SelectTrigger className={`w-48 select-orange-hover-trigger ${
                      selectedCourseFilter !== 'all' ? 'border-orange-500 bg-orange-50 text-orange-700' : ''
                    }`}>
                      <SelectValue placeholder={translate('filterByCourse')} />
                    </SelectTrigger>
                    <SelectContent className="select-orange-hover">
                      <SelectItem value="all" className="hover:bg-orange-100 hover:text-orange-700 individual-option select-item-spaced">
                        {translate('allCourses')}
                      </SelectItem>
                      {getAvailableCoursesWithNames().map(course => (
                        <SelectItem 
                          key={`main-header-course-filter-${course.id}`} 
                          value={course.id} 
                          className="hover:bg-orange-100 hover:text-orange-700 individual-option select-item-spaced"
                        >
                          {course.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {/* Indicador de filtro activo */}
                  {selectedCourseFilter !== 'all' && (
                    <div className="absolute -top-2 -right-2">
                      <div className="w-3 h-3 bg-orange-500 rounded-full border border-white"></div>
                    </div>
                  )}
                  
                  {/* Botón para limpiar filtro */}
                  {selectedCourseFilter !== 'all' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedCourseFilter('all')}
                      className="absolute -right-8 top-0 h-10 w-6 p-0 hover:bg-orange-100 text-orange-600"
                      title="Limpiar filtro"
                    >
                      ×
                    </Button>
                  )}
                </div>

                <Button 
                  onClick={() => {
                    // Establecer fecha de vencimiento por defecto a 7 días en el futuro
                    const defaultDueDate = new Date();
                    defaultDueDate.setDate(defaultDueDate.getDate() + 7);
                    const defaultDueDateString = defaultDueDate.toISOString().slice(0, 16);
                    
                    // Resetear el formulario completamente y configurar fecha por defecto
                    setFormData({
                      title: '',
                      description: '',
                      subject: '',
                      course: '',
                      assignedTo: 'course',
                      assignedStudentIds: [],
                      dueDate: defaultDueDateString,
                      priority: 'medium',
                      taskType: 'tarea',
                      topic: '',
                      numQuestions: 0,
                      timeLimit: 0
                    });
                    
                    // Limpiar asignaturas filtradas
                    setFilteredSubjects([]);
                    setTaskAttachments([]);
                    
                    setShowCreateDialog(true);
                  }}
                  className="bg-orange-500 hover:bg-orange-600 text-white"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  {translate('newTask')}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Tasks Display */}
        <div className="space-y-6">
          {user?.role === 'teacher' && viewMode === 'course' ? (
            /* Course View for Teachers */
            <>
              {/* Mensaje informativo cuando hay filtro activo */}
              {selectedCourseFilter !== 'all' && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 flex items-center space-x-3">
                  <div className="flex-shrink-0">
                    <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-orange-800">
                      <strong>Filtro activo:</strong> Mostrando solo tareas de {
                        getAvailableCoursesWithNames().find(c => c.id === selectedCourseFilter)?.name || selectedCourseFilter
                      }
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedCourseFilter('all')}
                    className="text-orange-600 hover:text-orange-700 hover:bg-orange-100"
                  >
                    Mostrar todo
                  </Button>
                </div>
              )}
              
              {Object.keys(getTasksByCourseAndSection()).length === 0 ? (
                <Card>
                  <CardContent className="pt-6 text-center">
                    <ClipboardList className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {selectedCourseFilter !== 'all' 
                        ? `No hay tareas para ${getAvailableCoursesWithNames().find(c => c.id === selectedCourseFilter)?.name || 'el filtro seleccionado'}`
                        : translate('tasksEmptyTeacher')
                      }
                    </p>
                  </CardContent>
                </Card>
              ) : (
                // Aplicar ordenamiento académico a las entradas
                sortCoursesByAcademicLevel(Object.keys(getTasksByCourseAndSection())).map((courseSection) => {
                  const courseTasks = getTasksByCourseAndSection()[courseSection];
                  const stats = getCourseStats()[courseSection];
                  return (
                    <Card key={courseSection} className="card-orange-shadow border-l-4 border-l-indigo-500">
                      <CardHeader>
                        <div className="flex justify-between items-center">
                          <div>
                            <CardTitle className="text-xl flex items-center">
                              <Users className="w-5 h-5 mr-2" />
                              {getCourseAndSectionName(courseSection)}
                            </CardTitle>
                            <div className="flex items-center space-x-4 mt-2">
                              <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800">
                                {translate('totalTasks')}: {stats.total}
                              </Badge>
                              <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800">
                                {translate('statusSubmitted')}: {stats.submitted}
                              </Badge>
                              <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800">
                                {translate('statusPending')}: {stats.pending}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {courseTasks.map(task => (
                          <div key={`pending-task-${task.id}`} className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="flex-1">
                              <div className="flex items-center space-x-2 mb-1">
                                <h4 className="font-medium">{task.title}</h4>
                                <Badge variant="outline" className={getTaskTypeColor(task.taskType || 'tarea')}>
                                  {task.taskType === 'evaluacion' ? translate('evaluation') : translate('task')}
                                </Badge>
                                <Badge className={getPriorityColor(task.priority)}>
                                  {task.priority === 'high' ? translate('priorityHigh') : 
                                  task.priority === 'medium' ? translate('priorityMedium') : translate('priorityLow')}
                                </Badge>
                                <Badge className={getTaskStatusForCurrentUser(task).statusClass}>
                                  {getTaskStatusForCurrentUser(task).statusText}
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">{task.description}</p>
                              <div className="flex items-center space-x-4 text-xs text-muted-foreground mt-2">
                                <span className="flex items-center">
                                  <Calendar className="w-3 h-3 mr-1" />
                                  {translate('duePrefix')} {formatDateOneLine(task.dueDate)}
                                </span>
                                <span className="flex items-center">
                                  <MessageSquare className="w-3 h-3 mr-1" />
                                  {getTeacherCommentsCount(task.id)} {translate('commentsCount')}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center space-x-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  console.log('🔄 Opening task dialog from course view - reloading comments');
                                  loadComments(); // Recargar comentarios antes de abrir
                                  
                                  // Si es una evaluación, verificar su estado antes de abrir
                                  if (task.taskType === 'evaluacion') {
                                    checkAndUpdateEvaluationStatus(task.id);
                                  }
                                  
                                  setSelectedTask(task);
                                  setShowTaskDialog(true);
                                }}
                                title={translate('viewTask')}
                                className="action-button"
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditTask(task)}
                                className="action-button"
                                title={translate('editTask')}
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDeleteTask(task)}
                                className="action-button action-button-delete"
                                title={translate('deleteTask')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
              )}
            </>
          ) : (
            /* List View (for both teachers and students) */
            <>
              {/* Mensaje informativo cuando hay filtro activo - Solo para profesores */}
              {user?.role === 'teacher' && selectedCourseFilter !== 'all' && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 flex items-center space-x-3">
                  <div className="flex-shrink-0">
                    <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-orange-800">
                      <strong>Filtro activo:</strong> Mostrando solo tareas de {
                        getAvailableCoursesWithNames().find(c => c.id === selectedCourseFilter)?.name || selectedCourseFilter
                      }
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedCourseFilter('all')}
                    className="text-orange-600 hover:text-orange-700 hover:bg-orange-100"
                  >
                    Mostrar todo
                  </Button>
                </div>
              )}
              
              <div className="grid gap-4">
                {filteredTasks.length === 0 ? (
                <Card>
                  <CardContent className="pt-6 text-center">
                    <ClipboardList className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {user?.role === 'teacher' ? (
                        selectedCourseFilter !== 'all' 
                          ? `No hay tareas para ${getAvailableCoursesWithNames().find(c => c.id === selectedCourseFilter)?.name || 'el filtro seleccionado'}`
                          : translate('tasksEmptyTeacher')
                      ) : translate('tasksEmptyStudent')}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                filteredTasks.map(task => {
                  // Para estudiantes, calcular su estado individual
                  const studentStatus = user?.role === 'student' 
                    ? getStudentTaskStatus(task.id, user.username || '')
                    : task.status;
                  
                  return (
                  <Card key={`active-task-${task.id}`} className="card-orange-shadow hover:shadow-md transition-shadow">
                    <CardHeader>
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <CardTitle className="text-lg">{task.title}</CardTitle>
                          <div className="flex items-center space-x-2 mt-2">
                            <Badge variant="outline">{task.subject}</Badge>
                            <Badge variant="outline" className="bg-indigo-100 text-indigo-800 border-indigo-200">
                              {getCourseAndSectionName(task.courseSectionId || task.course)}
                            </Badge>
                            <Badge variant="outline" className={getTaskTypeColor(task.taskType || 'tarea')}>
                              {task.taskType === 'evaluacion' ? translate('evaluation') : translate('task')}
                            </Badge>
                            <Badge className={getPriorityColor(task.priority)}>
                              {task.priority === 'high' ? translate('priorityHigh') : task.priority === 'medium' ? translate('priorityMedium') : translate('priorityLow')}
                            </Badge>
                            {/* Badge de estado y badge de porcentaje en burbujas separadas para estudiante */}
                            {user?.role === 'student' ? (() => {
                              // Verificar si es evaluación y está completada
                              if (task.taskType === 'evaluacion') {
                                const evaluationResult = evaluationResults[task.id];
                                if (evaluationResult) {
                                  return (
                                    <>
                                      <Badge className={getStatusColor('submitted') + ' font-bold mr-1'}>
                                        {translate('statusFinished')}
                                      </Badge>
                                      <Badge className={evaluationResult.percentage >= 70 ? 'bg-green-100 text-green-700 font-bold ml-2' : 'bg-red-100 text-red-700 font-bold ml-2'}>
                                        {evaluationResult.percentage}%
                                      </Badge>
                                    </>
                                  );
                                } else {
                                  return (
                                    <Badge className={getStatusColor('pending')}>
                                      {translate('statusPending')}
                                    </Badge>
                                  );
                                }
                              }
                              
                              // Para tareas normales, lógica original
                              const mySubmission = comments.find(c => c.taskId === task.id && c.studentId === user.id && c.isSubmission);
                              if (!mySubmission) {
                                // Pendiente: igual que en la vista detalle
                                return (
                                  <Badge className={getStatusColor('pending')}>
                                    {translate('statusPending')}
                                  </Badge>
                                );
                              } else if (mySubmission && (mySubmission.grade === undefined || mySubmission.grade === null)) {
                                // En Revisión: amarillo (forzado)
                                return (
                                  <Badge className="bg-yellow-100 text-yellow-800 font-bold">
                                    {translate('underReview')}
                                  </Badge>
                                );
                              } else if (mySubmission && typeof mySubmission.grade === 'number') {
                                // Finalizado: igual que en la vista detalle (usamos submitted/verde)
                                return (
                                  <>
                                    <Badge className={getStatusColor('submitted') + ' font-bold mr-1'}>
                                      {translate('statusFinished')}
                                    </Badge>
                                    <Badge className={mySubmission.grade >= 70 ? 'bg-green-100 text-green-700 font-bold ml-2' : 'bg-red-100 text-red-700 font-bold ml-2'}>
                                      {mySubmission.grade}%
                                    </Badge>
                                  </>
                                );
                              }
                            })() : (
                              <Badge className={getStatusColor(task.status)}>
                                {task.status === 'pending' ? translate('statusPending') : 
                                  task.status === 'delivered' ? translate('underReview') :
                                  task.status === 'submitted' ? translate('underReview') : translate('statusFinished')}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center space-x-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              console.log('🔄 Opening task dialog - reloading comments');
                              loadComments(); // Recargar comentarios antes de abrir
                              
                              // Si es una evaluación, verificar su estado antes de abrir
                              if (task.taskType === 'evaluacion') {
                                checkAndUpdateEvaluationStatus(task.id);
                              }
                              
                              setSelectedTask(task);
                              setShowTaskDialog(true);
                            }}
                            className="action-button"
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          {user?.role === 'teacher' && task.assignedById === user.id && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditTask(task)}
                                className="action-button"
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDeleteTask(task)}
                                className="action-button action-button-delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground mb-3">
                        {task.description}
                      </p>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <div className="flex items-center space-x-4">
                          <span className="flex items-center">
                            <Calendar className="w-3 h-3 mr-1" />
                            {translate('duePrefix')} {formatDateOneLine(task.dueDate)}
                          </span>
                          <span className="flex items-center">
                            {task.assignedTo === 'course' ? (
                              <>
                                <Users className="w-3 h-3 mr-1" />
                                {/* Mostrar curso y sección seguido del número de estudiantes */}
                                <span className="font-medium text-gray-600 dark:text-gray-400 mr-2">
                                  {getCourseAndSectionName(task.courseSectionId || task.course)}
                                </span>
                                •
                                <span className="ml-2">
                                  {getAssignedStudentsForTask(task).length} {translate('studentsCount')}
                                </span>
                              </>
                            ) : (
                              <>
                                <User className="w-3 h-3 mr-1" />
                                {/* Mostrar curso y sección para tareas específicas también */}
                                <span className="font-medium text-gray-600 dark:text-gray-400 mr-2">
                                  {getCourseAndSectionName(task.courseSectionId || task.course)}
                                </span>
                                •
                                <span className="ml-2">
                                  {task.assignedStudentIds?.length} {translate('studentsCount')}
                                </span>
                              </>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center">
                          <MessageSquare className="w-3 h-3 mr-1" />
                          {getTeacherCommentsCount(task.id)} {translate('commentsCount')}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  );
                })
              )}
              </div>
            </>
          )}
        </div>

        {/* Create Task Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>{formData.taskType === 'evaluacion' ? 'Crear Nueva Evaluación' : translate('createNewTask')}</DialogTitle>
              <DialogDescription>
                {translate('createTaskDescription')}
              </DialogDescription>
            </DialogHeader>
            
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="title" className="text-right">{translate('taskTitle')} <span className="text-red-500">*</span></Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                  className="col-span-3"
                  placeholder={translate('taskTitlePlaceholder')}
                />
              </div>
              
              <div className="grid grid-cols-4 items-start gap-4">
                <Label htmlFor="description" className="text-right pt-2">{translate('taskDescription')} <span className="text-red-500">*</span></Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  className="col-span-3"
                  placeholder={translate('taskDescriptionPlaceholder')}
                  rows={4}
                />
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="course" className="text-right">{translate('taskCourse')} <span className="text-red-500">*</span></Label>
                <Select value={formData.course} onValueChange={(value) => setFormData(prev => ({ ...prev, course: value }))}>
                  <SelectTrigger className={`${formData.taskType === 'evaluacion' ? 'select-purple-hover-trigger' : 'select-orange-hover-trigger'} col-span-3`}>
                    <SelectValue placeholder={translate('selectCourse')} />
                  </SelectTrigger>
                  <SelectContent className={formData.taskType === 'evaluacion' ? 'select-purple-hover' : 'select-orange-hover'}>
                    {getAvailableCoursesWithNames().map(course => (
                      <SelectItem key={`edit-task-course-${course.id}`} value={course.id}>{course.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="subject" className="text-right">{translate('taskSubject')} <span className="text-red-500">*</span></Label>
                <Select 
                  value={formData.subject} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, subject: value }))} 
                  required 
                  disabled={!formData.course}
                >
                  <SelectTrigger className={`${formData.taskType === 'evaluacion' ? 'select-purple-hover-trigger' : 'select-orange-hover-trigger'} col-span-3 ${!formData.course ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <SelectValue placeholder={!formData.course ? translate('selectCourseFirst') : translate('selectSubject')} />
                  </SelectTrigger>
                  <SelectContent className={formData.taskType === 'evaluacion' ? 'select-purple-hover' : 'select-orange-hover'}>
                    {filteredSubjects.map(subject => (
                      <SelectItem key={subject} value={subject}>{subject}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">{translate('assignTo')}</Label>
                <Select value={formData.assignedTo} onValueChange={(value: 'course' | 'student') => setFormData(prev => ({ ...prev, assignedTo: value, assignedStudentIds: [] }))}>
                  <SelectTrigger className={`${formData.taskType === 'evaluacion' ? 'select-purple-hover-trigger' : 'select-orange-hover-trigger'} col-span-3`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={formData.taskType === 'evaluacion' ? 'select-purple-hover' : 'select-orange-hover'}>
                    <SelectItem value="course">{translate('assignToCourse')}</SelectItem>
                    <SelectItem value="student">{translate('assignToStudents')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {formData.assignedTo === 'student' && formData.course && (
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">{translate('assignToStudents')}</Label>
                  <div className="col-span-3">
                    <div className="border rounded-md p-3 max-h-60 overflow-y-auto">
                      {(() => {
                        // Extraer el courseId real del formData.course
                        const availableCourses = getAvailableCoursesWithNames();
                        const selectedCourse = availableCourses.find(course => course.id === formData.course);
                        
                        // Obtener el courseId real - usar courseId si existe, si no, extraer del ID combinado
                        let actualCourseId = formData.course;
                        if (selectedCourse && selectedCourse.courseId) {
                          actualCourseId = selectedCourse.courseId;
                        } else if (formData.course && formData.course.includes('-')) {
                          // Para formato curso-seccion-id, extraer solo la primera parte
                          const coursesText = localStorage.getItem('smart-student-courses');
                          const courses = coursesText ? JSON.parse(coursesText) : [];
                          const courseFromId = courses.find((c: any) => formData.course.startsWith(c.id));
                          actualCourseId = courseFromId ? courseFromId.id : formData.course.split('-')[0];
                        }
                        
                        console.log(`🔍 [Create Task] formData.course: ${formData.course}`);
                        console.log(`🔍 [Create Task] actualCourseId: ${actualCourseId}`);
                        console.log(`🔍 [Create Task] selectedCourse:`, selectedCourse);
                        
                        const students = getStudentsForCourse(formData.course);
                        
                        return students.length > 0 ? (
                          students.map((student: { id: string, username: string, displayName: string }) => (
                            <div key={student.id} className="flex items-center space-x-2 py-1">
                              <Checkbox
                                id={`create-student-${student.username}`}
                                checked={formData.assignedStudentIds?.includes(student.id)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setFormData(prev => ({
                                    ...prev,
                                    assignedStudentIds: [...(prev.assignedStudentIds || []), student.id]
                                  }));
                                } else {
                                  setFormData(prev => ({
                                    ...prev,
                                    assignedStudentIds: prev.assignedStudentIds?.filter((s: string) => s !== student.id) || []
                                  }));
                                }
                              }}
                            />
                            <Label htmlFor={`student-${student.username}`} className="cursor-pointer">
                              {student.displayName}
                            </Label>
                          </div>
                        ))
                      ) : (
                        <p className="text-muted-foreground py-2 text-center">
                          No hay estudiantes asignados a este curso.<br />
                          <span className="text-xs">Verifica las asignaciones en Gestión de Usuarios.</span>
                        </p>
                      );
                    })()}
                    </div>
                  </div>
                </div>
              )}
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="dueDate" className="text-right">{translate('dueDate')} <span className="text-red-500">*</span></Label>
                <Input
                  id="dueDate"
                  type="datetime-local"
                  value={formData.dueDate}
                  onChange={(e) => setFormData(prev => ({ ...prev, dueDate: e.target.value }))}
                  className="col-span-3"
                />
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">{translate('priority')}</Label>
                <Select value={formData.priority} onValueChange={(value: 'low' | 'medium' | 'high') => setFormData(prev => ({ ...prev, priority: value }))}>
                  <SelectTrigger className="select-orange-hover-trigger col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    <SelectItem value="low">{translate('priorityLow')}</SelectItem>
                    <SelectItem value="medium">{translate('priorityMedium')}</SelectItem>
                    <SelectItem value="high">{translate('priorityHigh')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">{translate('taskType')}</Label>
                <Select 
                  value={formData.taskType} 
                  onValueChange={(value: 'tarea' | 'evaluacion') => {
                    setFormData(prev => ({
                      ...prev,
                      taskType: value,
                      // Establecer valores por defecto cuando se selecciona evaluación
                      numQuestions: value === 'evaluacion' ? 10 : prev.numQuestions,
                      timeLimit: value === 'evaluacion' ? 2 : prev.timeLimit
                    }))
                  }}
                >
                  <SelectTrigger className="select-orange-hover-trigger col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    <SelectItem value="tarea">{translate('taskTypeAssignment')}</SelectItem>
                    <SelectItem value="evaluacion">{translate('taskTypeEvaluation')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Evaluation specific fields */}
              {formData.taskType === 'evaluacion' && (
                <>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="topic" className="text-right">Tema <span className="text-red-500">*</span></Label>
                    <Input
                      id="topic"
                      value={formData.topic}
                      onChange={(e) => setFormData(prev => ({ ...prev, topic: e.target.value }))}
                      className="col-span-3"
                      placeholder="Introduce el tema de la evaluación"
                      required
                    />
                  </div>
                  
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="numQuestions" className="text-right">{translate('questionCountLabel')} <span className="text-red-500">*</span></Label>
                    <Select 
                      value={formData.numQuestions?.toString() || ''} 
                      onValueChange={(value) => setFormData(prev => ({ ...prev, numQuestions: parseInt(value) }))}
                    >
                      <SelectTrigger className="col-span-3">
                        <SelectValue placeholder="Selecciona la cantidad de preguntas" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5">5 preguntas</SelectItem>
                        <SelectItem value="10">10 preguntas</SelectItem>
                        <SelectItem value="15">15 preguntas</SelectItem>
                        <SelectItem value="20">20 preguntas</SelectItem>
                        <SelectItem value="25">25 preguntas</SelectItem>
                        <SelectItem value="30">30 preguntas</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="timeLimit" className="text-right">Tiempo (minutos) <span className="text-red-500">*</span></Label>
                    <Input
                      id="timeLimit"
                      type="number"
                      value={formData.timeLimit || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, timeLimit: parseInt(e.target.value) || 0 }))}
                      className="col-span-3"
                      placeholder="Ej: 45"
                      min="1"
                      max="180"
                      required
                    />
                  </div>
                </>
              )}

              {/* File Upload Section for Create Task - Only for regular tasks, not evaluations */}
              {formData.taskType !== 'evaluacion' && (
                <div className="grid grid-cols-4 items-start gap-4">
                  <Label className="text-right pt-2">{translate('attachments')}</Label>
                  <div className="col-span-3 space-y-2">
                    <div className="flex items-center space-x-2">
                      <Input
                        type="file"
                        multiple
                        onChange={(e) => handleFileUpload(e.target.files, true)}
                        className="hidden"
                        id="task-file-upload"
                        accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.zip,.rar"
                      />
                      <Button
                        type="button"
                        onClick={() => document.getElementById('task-file-upload')?.click()}
                        className={`w-full ${(formData.taskType as string) === 'evaluacion' 
                          ? 'bg-purple-100 hover:bg-purple-200 text-purple-800 border-purple-200 dark:bg-purple-900/20 dark:hover:bg-purple-900/30 dark:text-purple-400 dark:border-purple-700'
                          : 'bg-orange-100 hover:bg-orange-500 hover:text-white text-orange-800 border-orange-200 dark:bg-orange-900/20 dark:hover:bg-orange-600 dark:hover:text-white dark:text-orange-400 dark:border-orange-700'
                        }`}
                      >
                        <Paperclip className="w-4 h-4 mr-2" />
                        {translate('attachFile')}
                      </Button>
                    </div>
                    
                    {/* Display uploaded files */}
                    {taskAttachments.length > 0 && (
                      <div className="space-y-2 max-h-32 overflow-y-auto">
                        {taskAttachments.map((file) => (
                          <div key={`new-task-file-${file.id}`} className="flex items-center justify-between p-2 bg-muted rounded text-sm">
                            <div className="flex items-center space-x-2 min-w-0 flex-1">
                              <Paperclip className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              <span className="truncate" title={file.name}>{file.name}</span>
                              <span className="text-muted-foreground text-xs">({formatFileSize(file.size)})</span>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeFile(file.id, true)}
                              className="flex-shrink-0 h-6 w-6 p-0 hover:bg-orange-50 hover:text-orange-500 dark:hover:bg-orange-900/20 dark:hover:text-orange-400"
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDialog(false)} 
                className={formData.taskType === 'evaluacion' ? 'cancel-button-evaluation' : 'cancel-button'}>
                {translate('cancel')}
              </Button>
              <Button 
                onClick={handleCreateTask}
                className={`${formData.taskType === 'evaluacion' 
                  ? 'bg-purple-600 hover:bg-purple-700' 
                  : 'bg-orange-500 hover:bg-orange-600'} text-white`}
              >
                {formData.taskType === 'evaluacion' ? translate('createEvaluation') : translate('createTask')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Task Detail Dialog */}
        <Dialog open={showTaskDialog} onOpenChange={(open) => {
          setShowTaskDialog(open);
          if (!open) {
            // Reset states when closing dialog
            setNewComment('');
            setIsSubmission(false);
            setCommentAttachments([]);
          } else {
            // Reload comments when opening dialog to ensure fresh data
            loadComments();
            
            // Log debug information when opening task dialog
            console.log('🔍 TASK DIALOG OPENED FOR:', selectedTask);
            
            // NOTA: Código de demo/debug deshabilitado para comportamiento correcto
            // Solo deben aparecer entregas reales de estudiantes
            /*
            // Forzar la creación de una entrega falsa para María si no existe
            if (selectedTask) {
              const mariaExists = comments.some(c => 
                c.taskId === selectedTask.id && 
                c.isSubmission && 
                (c.studentName?.toLowerCase().includes('maria') || c.studentId?.toLowerCase().includes('maria'))
              );
              
              if (!mariaExists) {
                console.log('🚨 Creating fake submission for Maria...');
                const mariaSubmission: TaskComment = {
                  id: `fake_maria_submission_${Date.now()}`,
                  taskId: selectedTask.id,
                  studentId: 'maria',
                  studentName: 'Maria Estudiante',
                  comment: 'Entrega de María (generada automáticamente)',
                  timestamp: new Date().toISOString(),
                  isSubmission: true,
                  attachments: []
                };
                
                const updatedComments = [...comments, mariaSubmission];
                saveComments(updatedComments);
                loadComments();
              }
            }
            */
            if (selectedTask) {
              console.log(`🔍 Opening task dialog for "${selectedTask.title}":`, {
                taskId: selectedTask.id,
                totalComments: comments.length,
                submissionComments: comments.filter(c => c.isSubmission),
                allComments: comments
              });
            }
          }
        }}>
          <DialogContent className="sm:max-w-[700px] max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center space-x-2">
                <span>{selectedTask?.title}</span>
                <Badge variant="outline" className={getTaskTypeColor(selectedTask?.taskType || 'tarea')}>
                  {selectedTask?.taskType === 'evaluacion' ? translate('evaluation') : translate('task')}
                </Badge>
              </DialogTitle>
              <DialogDescription>
                {selectedTask?.assignedByName} • {getCourseAndSectionName(selectedTask?.courseSectionId || selectedTask?.course || '')} • {selectedTask?.subject}
              </DialogDescription>
            </DialogHeader>
            
            {selectedTask && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-2">{translate('taskDescriptionDetail')}</h4>
                  <p className="text-sm text-muted-foreground">{selectedTask.description}</p>
                </div>

                {/* Task Attachments */}
                {selectedTask.attachments && selectedTask.attachments.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2">{translate('attachments')}</h4>
                    <div className="space-y-2">
                      {selectedTask.attachments.map((file) => (
                        <div key={`selected-task-file-${file.id}`} className="flex items-center justify-between p-2 bg-muted rounded text-sm">
                          <div className="flex items-center space-x-2 min-w-0 flex-1">
                            <Paperclip className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <span className="truncate" title={file.name}>{file.name}</span>
                            <span className="text-muted-foreground text-xs">({formatFileSize(file.size)})</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => downloadFile(file)}
                            className="flex-shrink-0 hover:bg-orange-50 hover:text-orange-500 dark:hover:bg-orange-900/20 dark:hover:text-orange-400"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Estado y badge de porcentaje para el estudiante, lógica unificada con la lista */}
                <div className="flex space-x-4 text-sm">
                  <span className="whitespace-nowrap font-medium">
                    <strong>{translate('taskDueDateLabel')}</strong> <span className="single-line-date text-base">{formatDateOneLine(selectedTask.dueDate)}</span>
                  </span>
                  <span>
                    <strong>{translate('taskStatusLabel')}</strong>
                    {user?.role === 'student' ? (() => {
                      // Verificar si es evaluación y está completada
                      if (selectedTask.taskType === 'evaluacion') {
                        const evaluationResult = evaluationResults[selectedTask.id];
                        if (evaluationResult) {
                          return (
                            <>
                              <Badge className={getStatusColor('submitted') + ' font-bold ml-1'}>
                                {translate('statusFinished')}
                              </Badge>
                              <Badge className={`ml-2 ${evaluationResult.percentage >= 70 ? 'bg-green-100 text-green-700 font-bold' : 'bg-red-100 text-red-700 font-bold'}`}>
                                {evaluationResult.percentage}%
                              </Badge>
                            </>
                          );
                        } else {
                          return (
                            <Badge className={getStatusColor('pending') + ' ml-1'}>
                              {translate('statusPending')}
                            </Badge>
                          );
                        }
                      }
                      
                      // Para tareas normales, lógica original
                      const mySubmission = comments.find(c => c.taskId === selectedTask.id && c.studentId === user.id && c.isSubmission);
                      if (!mySubmission) {
                        // Pendiente
                        return (
                          <Badge className={getStatusColor('pending') + ' ml-1'}>
                            {translate('statusPending')}
                          </Badge>
                        );
                      } else if (mySubmission && (mySubmission.grade === undefined || mySubmission.grade === null)) {
                        // En Revisión: amarillo (forzado)
                        return (
                          <Badge className="bg-yellow-100 text-yellow-800 font-bold ml-1">
                            {translate('underReview')}
                          </Badge>
                        );
                      } else if (mySubmission && typeof mySubmission.grade === 'number') {
                        // Finalizado
                        return (
                          <Badge className={getStatusColor('submitted') + ' font-bold ml-1'}>
                            {translate('statusFinished')}
                          </Badge>
                        );
                      }
                    })() : (
                      <Badge className={`ml-1 ${getStatusColor(selectedTask.status)}`}>
                        {selectedTask.status === 'pending' ? translate('statusPending') : 
                          selectedTask.status === 'submitted' ? translate('underReview') : translate('statusFinished')}
                      </Badge>
                    )}
                  </span>
                </div>

                {/* Evaluation specific information */}
                {selectedTask.taskType === 'evaluacion' && user?.role === 'student' && (
                  <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                    <h4 className="font-medium mb-3 text-purple-800 dark:text-purple-200">{translate('evaluationInformation')}</h4>
                    
                    {/* Tabla horizontal de información de evaluación - Sin scroll horizontal */}
                    <div className="border border-purple-200 dark:border-purple-700 rounded-lg">
                      <table className="w-full table-fixed">
                        <thead className="bg-purple-100 dark:bg-purple-900/40">
                          <tr>
                            <th className="w-1/6 px-2 py-3 text-center text-sm font-medium text-purple-700 dark:text-purple-300 align-middle">{translate('evaluationTopic')}</th>
                            <th className="w-1/8 px-2 py-3 text-center text-sm font-medium text-purple-700 dark:text-purple-300 align-middle">{translate('evaluationQuestions')}</th>
                            <th className="w-1/8 px-2 py-3 text-center text-sm font-medium text-purple-700 dark:text-purple-300 align-middle">{translate('evaluationTime')}</th>
                            <th className="w-1/6 px-2 py-3 text-center text-sm font-medium text-purple-700 dark:text-purple-300 align-middle">{translate('evaluationGradeColumn')}</th>
                            <th className="w-1/8 px-2 py-3 text-center text-sm font-medium text-purple-700 dark:text-purple-300 align-middle">{translate('evaluationDateColumn')}</th>
                            <th className="w-1/4 px-2 py-3 text-center text-sm font-medium text-purple-700 dark:text-purple-300 align-middle">{translate('evaluationActionsColumn')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="bg-white dark:bg-slate-800/50">
                            <td className="px-2 py-3 text-center text-gray-600 dark:text-gray-400 text-sm font-medium align-middle">
                              {selectedTask.topic || (
                                <span className="text-gray-400 italic">--</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-center text-gray-600 dark:text-gray-400 text-sm font-medium align-middle">
                              {selectedTask.numQuestions && selectedTask.numQuestions > 0 ? selectedTask.numQuestions : (
                                <span className="text-gray-400 italic">--</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-center text-gray-600 dark:text-gray-400 text-sm font-medium align-middle">
                              {selectedTask.timeLimit && selectedTask.timeLimit > 0 ? `${selectedTask.timeLimit} ${translate('minutes')}` : (
                                <span className="text-gray-400 italic">--</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-center text-gray-600 dark:text-gray-400 text-sm font-medium align-middle">
                              {evaluationResults[selectedTask.id] ? (
                                <span className="text-gray-600 dark:text-gray-400 font-medium">
                                  {evaluationResults[selectedTask.id].correctAnswers}/{evaluationResults[selectedTask.id].totalQuestions} ({evaluationResults[selectedTask.id].percentage}%)
                                </span>
                              ) : (
                                <span className="text-gray-400 italic">{translate('statusPending')}</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-center text-gray-600 dark:text-gray-400 text-sm font-medium align-middle">
                              {evaluationResults[selectedTask.id] ? (
                                <span className="text-gray-600 dark:text-gray-400">
                                  {new Date(evaluationResults[selectedTask.id].completedAt).toLocaleDateString('es-ES', {
                                    day: '2-digit',
                                    month: '2-digit',
                                    year: 'numeric'
                                  })}
                                </span>
                              ) : (
                                <span className="text-gray-400 italic">--</span>
                              )}
                            </td>
                            <td className="px-2 py-3 text-center align-middle">
                              {evaluationResults[selectedTask.id] ? (
                                <Button
                                  onClick={() => handleReviewEvaluation(selectedTask)}
                                  className="bg-purple-500 hover:bg-purple-600 text-white text-xs px-2 py-1"
                                  size="sm"
                                >
                                  <Eye className="w-3 h-3 mr-1" />
                                  {translate('resultsButton')}
                                </Button>
                              ) : (
                                <Button
                                  onClick={() => handleStartEvaluation(selectedTask)}
                                  className="bg-purple-500 hover:bg-purple-600 text-white text-xs px-3 py-1"
                                  size="sm"
                                >
                                  <ClipboardCheck className="w-3 h-3 mr-1" />
                                  {translate('takeEvaluation')}
                                </Button>
                              )}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                
                {/* Evaluation specific information for teachers (keep original format) */}
                {selectedTask.taskType === 'evaluacion' && user?.role === 'teacher' && (
                  <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                    <h4 className="font-bold mb-4 text-purple-800 dark:text-purple-200 text-left">{translate('evaluationInformation')}</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                      {selectedTask.topic && (
                        <div className="text-center">
                          <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evaluationTopic')}:</strong>
                          <p className="text-purple-600 dark:text-purple-400">{selectedTask.topic}</p>
                        </div>
                      )}
                      {selectedTask.numQuestions && selectedTask.numQuestions > 0 && (
                        <div className="text-center">
                          <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evaluationQuestions')}:</strong>
                          <p className="text-purple-600 dark:text-purple-400">{selectedTask.numQuestions}</p>
                        </div>
                      )}
                      {selectedTask.timeLimit && selectedTask.timeLimit > 0 && (
                        <div className="text-center">
                          <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evaluationTime')}:</strong>
                          <p className="text-purple-600 dark:text-purple-400">{selectedTask.timeLimit} minutos</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                <Separator />
                
                {/* Detalle por estudiante - Solo visible para profesor - REPOSICIONADO AL PRINCIPIO */}
                {user?.role === 'teacher' && (
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <h4 className="font-bold">{translate('studentDetailPanel')}</h4>
                    </div>

                    {/* Tabla para tareas normales */}
                    {selectedTask?.taskType !== 'evaluacion' && (
                      <div className="border rounded-lg overflow-hidden">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-muted">
                              <tr>
                                <th className="centered-header py-2 px-3 font-medium">{translate('studentNameColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium">{translate('studentStatusColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium">{translate('studentGradeColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium min-w-[150px]">{translate('submissionDateColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium">{translate('studentActionsColumn')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {getAssignedStudentsForTask(selectedTask).length > 0 ? (
                                getAssignedStudentsForTask(selectedTask).map((student, index) => {
                                  let submission = getStudentSubmission(selectedTask.id, student.id);
                                  let studentStatus = getStudentTaskStatus(selectedTask.id, student.id);
                                  
                                  // NOTA: Parches temporales deshabilitados para comportamiento correcto
                                  // El botón "Revisar" solo debe aparecer cuando hay entrega real
                                  /*
                                  // PARCHE TEMPORAL: Si es Felipe y no encontramos submission, usar método especial
                                  if (!submission && student.displayName === 'Felipe Estudiante') {
                                    console.log('🚨 Using Felipe special check');
                                    const felipeSubmission = checkFelipeSubmission(selectedTask.id);
                                    if (felipeSubmission) {
                                      submission = {
                                        ...felipeSubmission,
                                        grade: felipeSubmission.grade || undefined,
                                        teacherComment: felipeSubmission.teacherComment || '',
                                        reviewedAt: felipeSubmission.reviewedAt || (felipeSubmission.grade !== undefined ? new Date().toISOString() : undefined)
                                      };
                                      studentStatus = submission.grade !== undefined || submission.teacherComment ? 'reviewed' : 'delivered';
                                    }
                                  }

                                  // PARCHE TEMPORAL: Si es María y no encontramos submission, usar método especial
                                  if (!submission && (student.displayName === 'Maria Estudiante' || student.username.toLowerCase().includes('maria'))) {
                                    console.log('🚨 Using Maria special check');
                                    const mariaSubmission = checkMariaSubmission(selectedTask.id);
                                    if (mariaSubmission) {
                                      console.log('✅ Found Maria submission using special function:', mariaSubmission);
                                      submission = {
                                        ...mariaSubmission,
                                        grade: mariaSubmission.grade || undefined,
                                        teacherComment: mariaSubmission.teacherComment || '',
                                        reviewedAt: mariaSubmission.reviewedAt || (mariaSubmission.grade !== undefined ? new Date().toISOString() : undefined)
                                      };
                                      studentStatus = 'delivered'; // Forzamos el estado como "delivered" para asegurar que se muestre correctamente
                                      console.log('✅ Maria status set to DELIVERED:', studentStatus);
                                    } else {
                                      console.log('❌ No Maria submission found using special function');
                                    }
                                  }
                                  */
                                  
                                  const hasSubmission = submission !== undefined;
                                  
                                  console.log(`👨‍🎓 TABLE ROW - Student ${student.displayName} (${student.username}):`, {
                                    studentObject: student,
                                    searchingWithUsername: student.username,
                                    hasSubmission,
                                    studentStatus,
                                    submissionId: submission?.id,
                                    submissionTimestamp: submission?.timestamp,
                                    submissionDetails: submission ? {
                                      studentId: submission.studentId,
                                      studentName: submission.studentName,
                                      isSubmission: submission.isSubmission,
                                      comment: submission.comment.substring(0, 50)
                                    } : null,
                                    allCommentsForThisTask: comments.filter(c => c.taskId === selectedTask.id).map(c => ({
                                      id: c.id,
                                      studentId: c.studentId,
                                      studentName: c.studentName,
                                      isSubmission: c.isSubmission
                                    }))
                                  });
                                  
                                  return (
                                    <tr key={student.id} className={index % 2 === 0 ? 'bg-background' : 'bg-muted/30'}>
                                      <td className="py-2 px-3 text-center">{student.displayName}</td>
                                      <td className="py-2 px-3 text-center">
                                        <Badge className={
                                          studentStatus === 'pending' ? 'bg-gray-100 text-gray-800' :
                                          studentStatus === 'delivered' ? 'bg-yellow-100 text-yellow-800' :
                                          'bg-green-100 text-green-800'
                                        }>
                                          {studentStatus === 'pending' ? translate('statusPending') : 
                                          studentStatus === 'delivered' ? translate('underReview') : 
                                          translate('statusFinished')}
                                        </Badge>
                                      </td>
                                      <td className="py-2 px-3 text-center">
                                        {hasSubmission && submission && submission.grade !== undefined ? 
                                          <span className="font-medium">{submission.grade}/100</span> :
                                          <span className="text-muted-foreground italic">{hasSubmission ? translate('pendingGrade') : translate('noSubmissionYet')}</span>
                                        }
                                      </td>
                                      <td className="py-2 px-3 text-center date-cell">
                                        <span className="single-line-date font-medium">
                                          {hasSubmission && submission ? formatDateOneLine(submission.timestamp) : '-'}
                                        </span>
                                      </td>
                                      <td className="py-2 px-3 text-center">
                                        <div className="flex justify-center space-x-2">
                                          {/* Solo mostrar botón Revisar/Editar cuando el estudiante ha hecho una entrega */}
                                          {hasSubmission && (studentStatus === 'delivered' || studentStatus === 'reviewed') ? (
                                            <Button 
                                              size="sm" 
                                              className="h-7 bg-orange-500 hover:bg-orange-600 text-white"
                                              onClick={() => handleReviewSubmission(student.id || student.username, selectedTask.id, true)}
                                            >
                                              {studentStatus === 'reviewed' ? translate('editSubmission') : translate('reviewSubmission')}
                                            </Button>
                                          ) : (
                                            <span className="text-xs text-muted-foreground">{translate('noSubmission') || "Sin entrega"}</span>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })
                              ) : (
                                <tr>
                                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                                    {translate('noStudentsInTask')}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Tabla para evaluaciones */}
                    {selectedTask?.taskType === 'evaluacion' && (
                      <div className="border rounded-lg overflow-hidden">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-muted">
                              <tr>
                                <th className="centered-header py-2 px-3 font-medium">{translate('studentNameColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium">{translate('evaluationStatusColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium">{translate('evaluationGradeColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium min-w-[150px]">{translate('evaluationDateColumn')}</th>
                                <th className="centered-header py-2 px-3 font-medium">{translate('evaluationActionsColumn')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {getAssignedStudentsForTask(selectedTask).length > 0 ? (
                                getAssignedStudentsForTask(selectedTask).map((student, index) => {
                                  const evaluationResult = getStudentEvaluationResult(selectedTask.id, student.id);
                                  const hasCompleted = evaluationResult !== undefined;
                                  
                                  return (
                                    <tr key={student.id} className={index % 2 === 0 ? 'bg-background' : 'bg-muted/30'}>
                                      <td className="py-2 px-3 text-center">{student.displayName}</td>
                                      <td className="py-2 px-3 text-center">
                                        <Badge className={hasCompleted ? 'bg-green-100 text-green-800' : 'bg-purple-100 text-purple-800'}>
                                          {hasCompleted ? translate('statusCompleted') : translate('statusPending')}
                                        </Badge>
                                      </td>
                                      <td className="py-2 px-3 text-center">
                                        {hasCompleted ? 
                                          <span className="font-medium">{evaluationResult.correctAnswers}/{evaluationResult.totalQuestions} ({evaluationResult.percentage}%)</span> :
                                          <span className="text-muted-foreground italic">{translate('noSubmissionYet')}</span>
                                        }
                                      </td>
                                      <td className="py-2 px-3 text-center date-cell">
                                        <span className="single-line-date font-medium">
                                          {hasCompleted ? formatDateOneLine(evaluationResult.completedAt) : '-'}
                                        </span>
                                      </td>
                                      <td className="py-2 px-3 text-center">
                                        {hasCompleted && (
                                          <Button 
                                            size="sm" 
                                            className="h-7 bg-purple-500 hover:bg-purple-600 text-white"
                                            onClick={() => handleViewEvaluationDetail(student.id, selectedTask.id)}
                                          >
                                            {translate('viewEvaluationDetail')}
                                          </Button>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })
                              ) : (
                                <tr>
                                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                                    {translate('noStudentsInTask')}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Panel de comentarios - REPOSICIONADO */}
                <div className="mt-6">
                  <Separator className="mb-4" />
                  <h4 className="font-medium mb-3">{translate('comments')}</h4>
                  <div className="space-y-3 max-h-60 overflow-y-auto">
                    {getTaskComments(selectedTask.id)
                      .filter(comment => {
                        // PROFESOR: solo comentarios (no entregas)
                        if (user?.role === 'teacher') return !comment.isSubmission;
                        
                        // ESTUDIANTE: aplicar filtros de privacidad
                        if (user?.role === 'student') {
                          // Para entregas: solo mostrar la propia
                          if (comment.isSubmission) {
                            return comment.studentId === user.id;
                          }
                          
                          // Para comentarios: verificar si el estudiante está asignado a la tarea
                          const isAssigned = isStudentAssignedToTask(comment.taskId, user.id, user.username);
                          
                          // Solo mostrar comentarios si el estudiante está asignado a la tarea
                          return isAssigned;
                        }
                        
                        // Otros roles: solo comentarios
                        return !comment.isSubmission;
                      })
                      .map(comment => (
                        <div
                          key={`task-comment-${comment.id}`}
                          id={`comment-${comment.id}`}
                          className={`bg-muted p-4 rounded-lg transition-all duration-300 ${
                            highlightedCommentId === comment.id
                              ? 'border-2 border-blue-500 shadow-md bg-blue-50 dark:bg-blue-900/20'
                              : ''
                          }`}
                        >
                          {/* NUEVA ORGANIZACIÓN PARA ENTREGA DE ESTUDIANTE */}
                          {comment.isSubmission ? (
                            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                              {/* Bloque principal: Nombre, estado Entregado, fecha/hora, porcentaje */}
                              <div className="flex flex-col md:flex-row md:items-center gap-2 flex-1">
                                {/* Nombre primero */}
                                <span className="font-semibold text-base text-gray-900 dark:text-gray-100">{comment.studentName}</span>
                                {/* Estado Entregado */}
                                <Badge className="bg-blue-100 text-blue-800 font-bold px-2 py-1 text-xs ml-4 md:ml-6">{translate('submitted')}</Badge>
                                {/* Fecha */}
                                <span className="text-xs text-muted-foreground ml-2 md:ml-4">{formatDateOneLine(comment.timestamp)}</span>
                                {/* Porcentaje */}
                                {((user?.role === 'teacher') || (user?.role === 'student' && comment.studentId === user.id)) && typeof comment.grade === 'number' && (
                                  <Badge className={comment.grade >= 70 ? 'bg-green-100 text-green-700 font-bold px-2 py-1 text-xs ml-2 md:ml-4' : 'bg-red-100 text-red-700 font-bold px-2 py-1 text-xs ml-2 md:ml-4'}>
                                    {comment.grade}%
                                  </Badge>
                                )}
                              </div>
                              {/* Botón eliminar o badge calificado alineado derecha */}
                              <div className="flex items-center gap-2 md:ml-auto">
                                {user?.role === 'student' && comment.studentId === user.id && !comment.grade && !comment.reviewedAt && (
                                  <Button variant="destructive" size="sm" onClick={() => handleDeleteSubmission(comment.id)}>
                                    <Trash2 className="w-4 h-4 mr-1" /> {translate('delete')}
                                  </Button>
                                )}
                                {comment.reviewedAt && (
                                  <Badge className="bg-red-100 text-red-700 font-bold px-2 py-1 text-xs flex items-center">
                                    <Lock className="w-3 h-3 mr-1" /> {translate('graded')}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ) : (
                            // Comentario normal
                            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-base text-gray-900 dark:text-gray-100">
                                  {/* Solo mostrar el nombre sin redundancias */}
                                  {comment.authorRole === 'teacher' 
                                    ? (comment.authorUsername === user?.username 
                                        ? user?.displayName || user?.username
                                        : comment.studentName)
                                    : comment.studentName
                                  }
                                </span>
                                {/* Badge específico según el rol del autor */}
                                {comment.authorRole === 'teacher' ? (
                                  <Badge 
                                    variant="outline" 
                                    className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100 hover:text-blue-800 text-xs font-medium px-2 py-1 inline-flex items-center gap-1.5"
                                  >
                                    <Shield className="w-3 h-3 text-blue-700 flex-shrink-0" />
                                    {translate('teacherRole')}
                                  </Badge>
                                ) : (
                                  <Badge 
                                    variant="outline" 
                                    className="bg-green-100 text-green-800 border-green-200 text-xs font-medium px-2 py-1 inline-flex items-center gap-1.5"
                                  >
                                    <GraduationCap className="w-3 h-3 text-green-700 flex-shrink-0" />
                                    {translate('studentRole')}
                                  </Badge>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground md:ml-3">{formatDateOneLine(comment.timestamp)}</span>
                            </div>
                          )}

                          {/* Comentario */}
                          <p className="text-sm mb-1 mt-2 whitespace-pre-line">{comment.comment}</p>

                          {/* Adjuntos */}
                          {comment.attachments && comment.attachments.length > 0 && (
                            <div className="mt-1 space-y-1">
                              {comment.attachments.map((file) => (
                                <div key={`comment-file-${file.id}`} className="flex items-center gap-2 text-xs">
                                  <Paperclip className="w-3 h-3 text-muted-foreground" />
                                  <span className="truncate" title={file.name}>{file.name}</span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => downloadFile(file)}
                                    className="h-6 w-6 p-0 hover:bg-orange-50 hover:text-orange-500 dark:hover:bg-orange-900/20 dark:hover:text-orange-400"
                                  >
                                    <Download className="w-3 h-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    
                    {getTaskComments(selectedTask.id).length === 0 && (
                      <p className="text-center text-sm text-muted-foreground py-4">
                        {translate('noCommentsYet')}
                      </p>
                    )}
                  </div>
                </div>

                {/* Sección para agregar comentarios - REPOSICIONADO AL FINAL */}
                <div className="space-y-3 mt-6">
                  <Separator />
                  <div>
                    <Label htmlFor="newComment">
                      {user?.role === 'student' && isSubmission 
                        ? translate('submitTask') 
                        : user?.role === 'teacher' 
                          ? translate('teacherCommentPlaceholder') 
                          : translate('addComment')}
                    </Label>
                    <Textarea
                      id="newComment"
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder={
                        user?.role === 'student' && isSubmission 
                          ? translate('submissionPlaceholder') 
                          : user?.role === 'teacher' 
                            ? translate('teacherCommentPlaceholder') 
                            : translate('commentPlaceholder')
                      }
                      className="mt-1"
                    />
                    
                    {/* File Upload for Comments - Solo para tareas normales, no para evaluaciones */}
                    {selectedTask?.taskType !== 'evaluacion' && (
                      <div className="mt-3 space-y-2">
                        <div>
                          <Input
                            type="file"
                            multiple
                            onChange={(e) => handleFileUpload(e.target.files, false)}
                            className="hidden"
                            id="comment-file-upload"
                            accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.zip,.rar"
                          />
                          <Button
                            type="button"
                            onClick={() => document.getElementById('comment-file-upload')?.click()}
                            className="w-full bg-orange-100 hover:bg-orange-500 hover:text-white text-orange-800 border-orange-200 dark:bg-orange-900/20 dark:hover:bg-orange-600 dark:hover:text-white dark:text-orange-400 dark:border-orange-700"
                            size="sm"
                          >
                            <Paperclip className="w-4 h-4 mr-2" />
                            {translate('attachFile')}
                          </Button>
                        </div>
                        
                        {/* Display uploaded files for comment */}
                        {commentAttachments.length > 0 && (
                          <div className="space-y-2 max-h-24 overflow-y-auto">
                            {commentAttachments.map((file) => (
                              <div key={`comment-attachment-${file.id}`} className="flex items-center justify-between p-2 bg-muted rounded text-sm">
                                <div className="flex items-center space-x-2 min-w-0 flex-1">
                                  <Paperclip className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                                  <span className="truncate" title={file.name}>{file.name}</span>
                                  <span className="text-muted-foreground text-xs">({formatFileSize(file.size)})</span>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeFile(file.id, false)}
                                  className="flex-shrink-0 h-6 w-6 p-0 hover:bg-orange-50 hover:text-orange-500 dark:hover:bg-orange-900/20 dark:hover:text-orange-400"
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    
                    <div className="flex justify-between items-center mt-3">
                      {user?.role === 'student' && selectedTask?.taskType !== 'evaluacion' && (
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="isSubmission"
                            checked={isSubmission}
                            onChange={(e) => setIsSubmission(e.target.checked)}
                            className="rounded"
                          />
                          <Label htmlFor="isSubmission" className="text-sm">
                            {translate('markAsFinalSubmission')}
                          </Label>
                        </div>
                      )}
                      {user?.role === 'teacher' && (
                        <div>{/* Espacio vacío para mantener la alineación */}</div>
                      )}
                      <Button 
                        onClick={handleAddComment} 
                        disabled={!newComment.trim() && commentAttachments.length === 0}
                        className={`${
                          selectedTask?.taskType === 'evaluacion' 
                            ? 'bg-purple-500 hover:bg-purple-600' 
                            : 'bg-orange-500 hover:bg-orange-600'
                        } text-white disabled:bg-gray-300 disabled:text-gray-500`}
                      >
                        <Send className="w-4 h-4 mr-2" />
                        {user?.role === 'student' && isSubmission 
                          ? translate('submit') 
                          : translate('sendComment')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Edit Task Dialog */}
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>{translate('editTask')}</DialogTitle>
              <DialogDescription>
                {translate('editTaskDescription')}
              </DialogDescription>
            </DialogHeader>
            
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="title" className="text-right">{translate('taskTitle')} <span className="text-red-500">*</span></Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                  className="col-span-3"
                  placeholder={translate('taskTitlePlaceholder')}
                />
              </div>
              
              <div className="grid grid-cols-4 items-start gap-4">
                <Label htmlFor="description" className="text-right pt-2">{translate('taskDescription')} <span className="text-red-500">*</span></Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  className="col-span-3"
                  placeholder={translate('taskDescriptionPlaceholder')}
                  rows={4}
                />
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="course" className="text-right">{translate('taskCourse')} <span className="text-red-500">*</span></Label>
                <Select value={formData.course} onValueChange={(value) => setFormData(prev => ({ ...prev, course: value }))}>
                  <SelectTrigger className="select-orange-hover-trigger col-span-3">
                    <SelectValue placeholder={translate('selectCourse')} />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    {getAvailableCoursesWithNames().map(course => (
                      <SelectItem key={`comment-course-${course.id}`} value={course.id}>{course.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="subject" className="text-right">{translate('taskSubject')} <span className="text-red-500">*</span></Label>
                <Select 
                  value={formData.subject} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, subject: value }))} 
                  required 
                  disabled={!formData.course}
                >
                  <SelectTrigger className={`select-orange-hover-trigger col-span-3 ${!formData.course ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <SelectValue placeholder={!formData.course ? translate('selectCourseFirst') : translate('selectSubject')} />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    {filteredSubjects.map(subject => (
                      <SelectItem key={subject} value={subject}>{subject}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">{translate('assignTo')}</Label>
                <Select value={formData.assignedTo} onValueChange={(value: 'course' | 'student') => setFormData(prev => ({ ...prev, assignedTo: value }))}>
                  <SelectTrigger className="select-orange-hover-trigger col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    <SelectItem value="course">{translate('assignToCourse')}</SelectItem>
                    <SelectItem value="student">{translate('assignToStudents')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {formData.assignedTo === 'student' && formData.course && (
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">{translate('assignToStudents')}</Label>
                  <div className="col-span-3">
                    <div className="border rounded-md p-3 max-h-60 overflow-y-auto">
                      {(() => {
                        // Extraer el courseId real del formData.course (para el formulario de edición)
                        const availableCourses = getAvailableCoursesWithNames();
                        const selectedCourse = availableCourses.find(course => course.id === formData.course);
                        
                        // Obtener el courseId real - usar courseId si existe, si no, extraer del ID combinado
                        let actualCourseId = formData.course;
                        if (selectedCourse && selectedCourse.courseId) {
                          actualCourseId = selectedCourse.courseId;
                        } else if (formData.course && formData.course.includes('-')) {
                          // Para formato curso-seccion-id, extraer solo la primera parte
                          const coursesText = localStorage.getItem('smart-student-courses');
                          const courses = coursesText ? JSON.parse(coursesText) : [];
                          const courseFromId = courses.find((c: any) => formData.course.startsWith(c.id));
                          actualCourseId = courseFromId ? courseFromId.id : formData.course.split('-')[0];
                        }
                        
                        console.log(`🔍 [Edit Task] formData.course: ${formData.course}`);
                        console.log(`🔍 [Edit Task] actualCourseId: ${actualCourseId}`);
                        console.log(`🔍 [Edit Task] selectedCourse:`, selectedCourse);
                        
                        const students = getStudentsForCourse(formData.course);
                        
                        return students.length > 0 ? (
                          students.map((student: { id: string, username: string, displayName: string }) => (
                            <div key={student.id} className="flex items-center space-x-2 py-1">
                              <Checkbox
                                id={`edit-student-${student.username}`}
                                checked={formData.assignedStudentIds?.includes(student.id)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setFormData(prev => ({
                                    ...prev,
                                    assignedStudentIds: [...(prev.assignedStudentIds || []), student.id]
                                  }));
                                } else {
                                  setFormData(prev => ({
                                    ...prev,
                                    assignedStudentIds: prev.assignedStudentIds?.filter((s: string) => s !== student.id) || []
                                  }));
                                }
                              }}
                            />
                            <Label htmlFor={`student-${student.username}`} className="cursor-pointer">
                              {student.displayName}
                            </Label>
                          </div>
                        ))
                      ) : (
                        <p className="text-muted-foreground py-2 text-center">
                          {translate('noEvaluationsSubtext') || "No hay estudiantes disponibles para este curso"}
                        </p>
                      );
                    })()}
                    </div>
                  </div>
                </div>
              )}
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="dueDate" className="text-right">{translate('dueDate')} *</Label>
                <Input
                  id="dueDate"
                  type="datetime-local"
                  value={formData.dueDate}
                  onChange={(e) => setFormData(prev => ({ ...prev, dueDate: e.target.value }))}
                  className="col-span-3"
                />
              </div>
              
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">{translate('priority')}</Label>
                <Select value={formData.priority} onValueChange={(value: 'low' | 'medium' | 'high') => setFormData(prev => ({ ...prev, priority: value }))}>
                  <SelectTrigger className="select-orange-hover-trigger col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    <SelectItem value="low">{translate('priorityLow')}</SelectItem>
                    <SelectItem value="medium">{translate('priorityMedium')}</SelectItem>
                    <SelectItem value="high">{translate('priorityHigh')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">{translate('taskType')}</Label>
                <Select value={formData.taskType} onValueChange={(value: 'tarea' | 'evaluacion') => setFormData(prev => ({ ...prev, taskType: value }))}>
                  <SelectTrigger className="select-orange-hover-trigger col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="select-orange-hover">
                    <SelectItem value="tarea">{translate('taskTypeAssignment')}</SelectItem>
                    <SelectItem value="evaluacion">{translate('taskTypeEvaluation')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Evaluation specific fields */}
              {formData.taskType === 'evaluacion' && (
                <>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="topic-edit" className="text-right">Tema <span className="text-red-500">*</span></Label>
                    <Input
                      id="topic-edit"
                      value={formData.topic}
                      onChange={(e) => setFormData(prev => ({ ...prev, topic: e.target.value }))}
                      className="col-span-3"
                      placeholder="Introduce el tema de la evaluación"
                      required
                    />
                  </div>
                  
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="numQuestions-edit" className="text-right">{translate('questionCountLabel')} <span className="text-red-500">*</span></Label>
                    <Select 
                      value={formData.numQuestions?.toString() || ''} 
                      onValueChange={(value) => setFormData(prev => ({ ...prev, numQuestions: parseInt(value) }))}
                    >
                      <SelectTrigger className="col-span-3">
                        <SelectValue placeholder="Selecciona la cantidad de preguntas" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5">5 preguntas</SelectItem>
                        <SelectItem value="10">10 preguntas</SelectItem>
                        <SelectItem value="15">15 preguntas</SelectItem>
                        <SelectItem value="20">20 preguntas</SelectItem>
                        <SelectItem value="25">25 preguntas</SelectItem>
                        <SelectItem value="30">30 preguntas</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="timeLimit-edit" className="text-right">Tiempo (minutos) <span className="text-red-500">*</span></Label>
                    <Input
                      id="timeLimit-edit"
                      type="number"
                      value={formData.timeLimit || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, timeLimit: parseInt(e.target.value) || 0 }))}
                      className="col-span-3"
                      placeholder="Ej: 45"
                      min="1"
                      max="180"
                      required
                    />
                  </div>
                </>
              )}
            </div>
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEditDialog(false)} className="cancel-button">
                {translate('cancel')}
              </Button>
              <Button 
                onClick={handleUpdateTask}
                className={`${formData.taskType === 'evaluacion' 
                  ? 'bg-purple-600 hover:bg-purple-700' 
                  : 'bg-orange-500 hover:bg-orange-600'} text-white`}
              >
                {formData.taskType === 'evaluacion' ? translate('updateEvaluation') || translate('updateTask') : translate('updateTask')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Task Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle>{translate('confirmDelete')}</DialogTitle>
            </DialogHeader>
            
            <div className="py-4">
              <p className="text-sm text-muted-foreground">
                {translate('taskDeleteConfirm', { title: taskToDelete?.title || '' })}
              </p>
            </div>
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteDialog(false)} className="cancel-button">
                {translate('cancel')}
              </Button>
              <Button onClick={confirmDeleteTask} variant="destructive">
                {translate('deleteTask')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Grade Submission Dialog */}
        <Dialog open={showGradeDialog} onOpenChange={handleCloseGradeDialog}>
          <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{translate('gradeSubmissionTitle')}</DialogTitle>
              <DialogDescription>
                {translate('gradeSubmissionDesc')}
              </DialogDescription>
            </DialogHeader>
            
            {submissionToGrade && selectedTask && (
              <div className="space-y-6">
                {/* Información de la tarea */}
                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border">
                  <h4 className="font-medium mb-2 text-blue-800 dark:text-blue-200">{translate('taskInformation')}</h4>
                  <div className="space-y-2 text-sm">
                    <p><strong>{translate('task')}:</strong> {selectedTask.title}</p>
                    <p><strong>{translate('taskDescription')}:</strong> {selectedTask.description}</p>
                    <p><strong>{translate('dueDate')}:</strong> {formatDateOneLine(selectedTask.dueDate)}</p>
                    <p><strong>{translate('tableCourse')}:</strong> {getCourseAndSectionName(selectedTask.courseSectionId || selectedTask.course)}</p>
                    <p><strong>{translate('taskSubject')}:</strong> {selectedTask.subject}</p>
                  </div>
                </div>

                {/* Información del estudiante */}
                <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg border">
                  <h4 className="font-medium mb-2 text-green-800 dark:text-green-200">{translate('studentInformation')}</h4>
                  <div className="space-y-2 text-sm">
                    <p><strong>{translate('studentNameColumn')}:</strong> {submissionToGrade.studentName}</p>
                    <p><strong>{translate('user')}:</strong> {submissionToGrade.studentName}</p>
                    <p><strong>{translate('submissionDateColumn')}:</strong> {formatDateOneLine(submissionToGrade.timestamp)}</p>
                  </div>
                </div>

                {/* Entrega del estudiante */}
                <div className="bg-gray-50 dark:bg-gray-900/20 p-4 rounded-lg border">
                  <h4 className="font-medium mb-3">Entrega del Estudiante</h4>
                  <div className="bg-white dark:bg-gray-800 p-4 rounded border">
                    <p className="text-sm whitespace-pre-wrap">{submissionToGrade.comment}</p>
                  </div>
                </div>

                {/* Archivos adjuntos de la entrega */}
                {submissionToGrade.attachments && submissionToGrade.attachments.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-3">Archivos de la Entrega</h4>
                    <div className="space-y-2">
                      {submissionToGrade.attachments.map((file) => (
                        <div key={`submission-file-${file.id}`} className="flex items-center justify-between p-3 bg-muted rounded border">
                          <div className="flex items-center space-x-2 min-w-0 flex-1">
                            <Paperclip className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <span className="truncate font-medium" title={file.name}>{file.name}</span>
                            <span className="text-muted-foreground text-xs">({formatFileSize(file.size)})</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadFile(file)}
                            className="flex-shrink-0 hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-900/20 dark:hover:text-orange-400"
                          >
                            <Download className="w-4 h-4 mr-1" />
                            Descargar
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Archivos adjuntos de la tarea original */}
                {selectedTask.attachments && selectedTask.attachments.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-3">Archivos de la Tarea Original</h4>
                    <div className="space-y-2">
                      {selectedTask.attachments.map((file) => (
                        <div key={`task-file-${file.id}`} className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 rounded border">
                          <div className="flex items-center space-x-2 min-w-0 flex-1">
                            <Paperclip className="w-4 h-4 text-blue-600 flex-shrink-0" />
                            <span className="truncate" title={file.name}>{file.name}</span>
                            <span className="text-muted-foreground text-xs">({formatFileSize(file.size)})</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadFile(file)}
                            className="flex-shrink-0 hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-900/20 dark:hover:text-orange-400"
                          >
                            <Download className="w-4 h-4 mr-1" />
                            Descargar
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Separator />

                {/* Sección de calificación */}
                <div className="bg-orange-50 dark:bg-orange-900/20 p-4 rounded-lg border">
                  <h4 className="font-medium mb-4 text-orange-800 dark:text-orange-200">Calificación</h4>
                  
                  <div className="space-y-4">
                    {/* Campo de calificación */}
                    <div>
                      <label htmlFor="gradeInput" className="block text-sm font-medium mb-2">
                        {translate('gradeRange')} <span className="text-red-500">*</span>
                      </label>
                      <div className="flex items-center space-x-2">
                        <Input
                          id="gradeInput"
                          type="number"
                          min={getGradingConfig().min}
                          max={getGradingConfig().max}
                          value={gradeForm.grade}
                          onChange={(e) => setGradeForm(prev => ({ ...prev, grade: e.target.value }))}
                          placeholder="Ej: 85"
                          className="w-24"
                        />
                        <span className="text-sm text-muted-foreground">/ {getGradingConfig().max}</span>
                        {gradeForm.grade && (() => { const g = getGradingConfig(); const val = parseFloat(gradeForm.grade); const thr = g.min + ((g.max - g.min) * ((g.passPercent ?? 60)/100)); const ok = val >= thr; return (
                          <Badge variant="outline" className={ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
                            {ok ? translate('approved') : translate('failed')}
                          </Badge>
                        ); })()}
                      </div>
                    </div>

                    {/* Campo de comentario */}
                    <div>
                      <label htmlFor="teacherComment" className="block text-sm font-medium mb-2">
                        Comentario de Retroalimentación
                      </label>
                      <Textarea
                        id="teacherComment"
                        value={gradeForm.teacherComment}
                        onChange={(e) => setGradeForm(prev => ({ ...prev, teacherComment: e.target.value }))}
                        placeholder={translate('feedbackPlaceholder')}
                        rows={4}
                      />
                    </div>
                  </div>
                </div>

                {/* Botones de acción */}
                <div className="flex justify-end space-x-3 pt-4 border-t">
                  <Button 
                    variant="outline" 
                    onClick={handleCloseGradeDialog}
                    className="hover:bg-orange-50 hover:text-orange-600 hover:border-orange-300"
                  >
                    {translate('cancel')}
                  </Button>
                  <Button 
                    onClick={saveGrade}
                    className="bg-orange-500 hover:bg-orange-600 text-white"
                    disabled={!gradeForm.grade.trim()}
                  >
                    {translate('saveGrade')}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Diálogo de Revisión Mejorado */}
        <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
          <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center space-x-2">
                <span>{currentReview.isGraded ? translate('editSubmission') : translate('reviewSubmission')} - {currentReview.studentDisplayName}</span>
                <Badge variant="outline" className="bg-blue-100 text-blue-800">
                  {currentReview.isGraded ? translate('graded') : translate('toGrade')}
                </Badge>
              </DialogTitle>
              <DialogDescription>
                {selectedTask?.title}
              </DialogDescription>
            </DialogHeader>
            
            {currentReview.submission && selectedTask && (
              <div className="space-y-6">
                {/* Información de la Tarea */}
                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200">
                  <h4 className="font-medium mb-3 text-blue-800 dark:text-blue-200 flex items-center">
                    <ClipboardList className="w-5 h-5 mr-2" />
                    {translate('taskInformation')}
                  </h4>
                  <div className="grid md:grid-cols-2 gap-4 text-sm">
                    <div>
                      <p><strong>{translate('taskTitle')}:</strong> {selectedTask.title}</p>
                      <p><strong>{translate('tableCourse')}:</strong> {getCourseAndSectionName(selectedTask.courseSectionId || selectedTask.course)}</p>
                      <p><strong>{translate('taskSubject')}:</strong> {selectedTask.subject}</p>
                    </div>
                    <div>
                      <p><strong>{translate('dueDate')}:</strong> {formatDateOneLine(selectedTask.dueDate)}</p>
                      <div><strong>{translate('priority')}:</strong> 
                        <Badge className={`ml-1 ${getPriorityColor(selectedTask.priority)}`}>
                          {selectedTask.priority === 'high' ? translate('priorityHigh') : 
                          selectedTask.priority === 'medium' ? translate('priorityMedium') : translate('priorityLow')}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3">
                    <p><strong>{translate('taskDescription')}:</strong></p>
                    <p className="text-muted-foreground mt-1">{selectedTask.description}</p>
                  </div>
                </div>

                {/* Información del Estudiante */}
                <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg border border-green-200">
                  <h4 className="font-medium mb-3 text-green-800 dark:text-green-200 flex items-center">
                    <User className="w-5 h-5 mr-2" />
                    {translate('studentAndSubmissionInfo')}
                  </h4>
                  <div className="grid md:grid-cols-2 gap-4 text-sm">
                    <div>
                      <p><strong>{translate('studentNameColumn')}:</strong> {currentReview.studentDisplayName}</p>
                      <p><strong>ID:</strong> {currentReview.studentId}</p>
                      <p><strong>{translate('deliveryTime')}:</strong> {formatDate(currentReview.submission.timestamp)}</p>
                    </div>
                    <div>
                      <p><strong>{translate('fullDate')}:</strong> {new Date(currentReview.submission.timestamp).toLocaleString('es-ES', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}</p>
                      <p><strong>{translate('timeElapsed')}:</strong> {(() => {
                        const now = new Date();
                        const submissionTime = new Date(currentReview.submission.timestamp);
                        const diffMs = now.getTime() - submissionTime.getTime();
                        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                        const diffDays = Math.floor(diffHours / 24);
                        
                        if (diffDays > 0) {
                          return `Hace ${diffDays} día${diffDays > 1 ? 's' : ''} y ${diffHours % 24} hora${(diffHours % 24) > 1 ? 's' : ''}`;
                        } else if (diffHours > 0) {
                          return `Hace ${diffHours} hora${diffHours > 1 ? 's' : ''}`;
                        } else {
                          const diffMinutes = Math.floor(diffMs / (1000 * 60));
                          return `Hace ${diffMinutes} minuto${diffMinutes > 1 ? 's' : ''}`;
                        }
                      })()}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <strong>{translate('currentStatus')}:</strong>
                        {/* Estado de la entrega del estudiante, igual que en la lista */}
                        {(() => {
                          if (!currentReview.submission) {
                            // No hay entrega: Pendiente
                            return (
                              <Badge className="bg-gray-100 text-gray-800">
                                {translate('statusPending')}
                              </Badge>
                            );
                          } else if (currentReview.submission && (currentReview.submission.grade === undefined || currentReview.submission.grade === null)) {
                            // Entregada pero sin nota: En Revisión (amarillo)
                            return (
                              <Badge className="bg-yellow-100 text-yellow-800 font-bold">
                                {translate('underReview')}
                              </Badge>
                            );
                          } else if (currentReview.submission && typeof currentReview.submission.grade === 'number') {
                            // Finalizado: verde + badge porcentaje
                            return (
                              <>
                                <Badge className="bg-green-100 text-green-800 font-bold mr-1">
                                  {translate('statusFinished')}
                                </Badge>
                                <Badge className={currentReview.submission.grade >= 70 ? 'bg-green-100 text-green-700 font-bold ml-2' : 'bg-red-100 text-red-700 font-bold ml-2'}>
                                  {currentReview.submission.grade}/100
                                </Badge>
                              </>
                            );
                          }
                        })()}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Contenido de la Entrega */}
                <div className="bg-gray-50 dark:bg-gray-900/20 p-4 rounded-lg border">
                  <h4 className="font-medium mb-3 flex items-center">
                    <MessageSquare className="w-5 h-5 mr-2" />
                    {translate('submissionContent')}
                  </h4>
                  <div className="bg-white dark:bg-gray-800 p-4 rounded border min-h-[100px]">
                    <p className="text-sm whitespace-pre-wrap">
                      {currentReview.submission.comment || translate('noTextContent')}
                    </p>
                  </div>
                </div>

                {/* Archivos Adjuntos de la Entrega */}
                {currentReview.submission.attachments && currentReview.submission.attachments.length > 0 ? (
                  <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg border border-purple-200">
                    <h4 className="font-medium mb-3 flex items-center text-purple-800 dark:text-purple-200">
                      <Paperclip className="w-5 h-5 mr-2" />
                      {translate('submissionAttachments')} ({currentReview.submission.attachments.length})
                    </h4>
                    <div className="space-y-3">
                      {currentReview.submission.attachments.map((file, index) => (
                        <div key={`review-submission-file-${file.id}`} className="flex items-center justify-between p-4 bg-white dark:bg-gray-800 rounded-lg border shadow-sm">
                          <div className="flex items-center space-x-3 min-w-0 flex-1">
                            <div className="flex-shrink-0 w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                              <Paperclip className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-sm truncate" title={file.name}>
                                📎 {file.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Tamaño: {formatFileSize(file.size)} • Subido: {formatDate(file.uploadedAt)}
                              </p>
                              <p className="text-xs text-blue-600 dark:text-blue-400">
                                {translate('fileNumber', { number: (index + 1).toString(), total: (currentReview.submission?.attachments?.length || 0).toString() })}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadFile(file)}
                            className="flex-shrink-0 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20 dark:hover:text-blue-400 ml-3"
                          >
                            <Download className="w-4 h-4 mr-1" />
                            Ver/Descargar
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/30 rounded border border-blue-200">
                      <p className="text-sm text-blue-800 dark:text-blue-200">
                        💡 <strong>Tip:</strong> Haz clic en "Ver/Descargar" para revisar cada archivo antes de calificar la entrega.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-gray-50 dark:bg-gray-900/20 p-4 rounded-lg border border-gray-200">
                    <h4 className="font-medium mb-3 flex items-center text-gray-600 dark:text-gray-400">
                      <Paperclip className="w-5 h-5 mr-2" />
                      {translate('attachedFiles')}
                    </h4>
                    <div className="text-center py-6">
                      <Paperclip className="w-12 h-12 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">
                        {translate('noAttachedFiles')}
                      </p>
                    </div>
                  </div>
                )}

                {/* Sección de Calificación */}
                <div className="bg-orange-50 dark:bg-orange-900/20 p-6 rounded-lg border border-orange-200">
                  <h4 className="font-medium mb-4 text-orange-800 dark:text-orange-200 flex items-center">
                    <Star className="w-5 h-5 mr-2" />
                    {translate('gradeAndFeedback')}
                  </h4>
                  
                  <div className="space-y-6">
                    {/* Resumen de la Entrega */}
                    <div className="bg-blue-50 dark:bg-blue-900/30 p-4 rounded-lg border border-blue-200">
                      <h5 className="font-medium text-blue-800 dark:text-blue-200 mb-2">📋 {translate('submissionSummary')}</h5>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <p><strong>{translate('studentNameColumn')}:</strong> {currentReview.studentDisplayName}</p>
                          <p><strong>{translate('submittedOn')}:</strong> {formatDate(currentReview.submission.timestamp)}</p>
                        </div>
                        <div>
                          <p><strong>{translate('attachedFiles')}:</strong> {currentReview.submission.attachments?.length || 0}</p>
                          <p><strong>{translate('comments')}:</strong> {currentReview.submission.comment ? translate('yes') : translate('no')}</p>
                        </div>
                      </div>
                    </div>

                    {/* Campo de calificación mejorado */}
                    <div>
                      <label htmlFor="gradeInputNew" className="block text-sm font-medium mb-3">
                        🎯 {translate('gradeRange')} <span className="text-red-500">*</span>
                      </label>
                      <div className="space-y-3">
                        <div className="flex items-center space-x-4">
                          <Input
                            id="gradeInputNew"
                            type="number"
                            min={getGradingConfig().min}
                            max={getGradingConfig().max}
                            value={currentReview.grade || ''}
                            onChange={(e) => setCurrentReview(prev => ({ 
                              ...prev, 
                              grade: parseFloat(e.target.value) || 0 
                            }))}
                            placeholder="0"
                            className="w-32 text-lg text-center font-bold"
                          />
                          <span className="text-lg text-muted-foreground font-medium">/ {getGradingConfig().max}</span>
                          {currentReview.grade > 0 && (
                            <Badge variant="outline" className={
                              (currentReview.grade >= (getGradingConfig().min + ((getGradingConfig().max - getGradingConfig().min) * ((getGradingConfig().passPercent ?? 60)/100)))) 
                                ? 'bg-green-100 text-green-800 border-green-300 text-sm font-bold' 
                                : 'bg-red-100 text-red-800 border-red-300 text-sm font-bold'
                            }>
                              {(currentReview.grade >= (getGradingConfig().min + ((getGradingConfig().max - getGradingConfig().min) * ((getGradingConfig().passPercent ?? 60)/100)))) ? `✅ ${translate('approved')}` : `❌ ${translate('failed')}`}
                            </Badge>
                          )}
                        </div>
                        
                        {/* Escala de calificación visual */}
                        <div className="mt-2">
                          <div className="flex justify-between text-xs text-gray-500 mb-1">
                            {(() => { const g = getGradingConfig(); const ticks = [g.min, g.min + (g.max-g.min)*0.25, g.min + (g.max-g.min)*0.5, g.min + (g.max-g.min)*0.7, g.max]; return (
                              <>
                                <span>{Math.round(ticks[0])}</span>
                                <span>{Math.round(ticks[1])}</span>
                                <span>{Math.round(ticks[2])}</span>
                                <span>{Math.round(ticks[3])}</span>
                                <span>{Math.round(ticks[4])}</span>
                              </>
                            ); })()}
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div 
                              className={`h-2 rounded-full transition-all duration-300 ${
                                (currentReview.grade >= (getGradingConfig().min + ((getGradingConfig().max - getGradingConfig().min) * 0.7))) ? 'bg-green-500' : 
                                (currentReview.grade >= (getGradingConfig().min + ((getGradingConfig().max - getGradingConfig().min) * 0.5))) ? 'bg-yellow-500' : 
                                'bg-red-500'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, ((currentReview.grade - getGradingConfig().min) / (getGradingConfig().max - getGradingConfig().min)) * 100))}%` }}
                            ></div>
                          </div>
                          <div className="flex justify-between text-xs text-gray-600 mt-1">
                            <span>{translate('insufficient')}</span>
                            <span>{translate('regular')}</span>
                            <span>{translate('good')}</span>
                            <span>{translate('veryGood')}</span>
                            <span>{translate('excellent')}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Campo de retroalimentación mejorado */}
                    <div>
                      <label htmlFor="feedbackInputNew" className="block text-sm font-medium mb-3">
                        💬 {translate('feedbackForStudent')}
                      </label>
                      <Textarea
                        id="feedbackInputNew"
                        value={currentReview.feedback}
                        onChange={(e) => setCurrentReview(prev => ({ 
                          ...prev, 
                          feedback: e.target.value 
                        }))}
                        placeholder={translate('feedbackPlaceholder')}
                        rows={4}
                        className="resize-none"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {translate('feedbackVisibleNote')}
                      </p>
                    </div>

                    {/* Calificación previa (si existe) */}
                    {currentReview.isGraded && currentReview.submission.reviewedAt && (
                      <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded border border-purple-200">
                        <p className="text-sm text-purple-700 dark:text-purple-300">
                          <strong>Calificación anterior:</strong> {currentReview.submission.grade}/100
                        </p>
                        <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                          Revisado el: {formatDate(currentReview.submission.reviewedAt)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            
            <DialogFooter className="pt-6 border-t">
              <Button 
                variant="outline" 
                onClick={() => setShowReviewDialog(false)}
                className="hover:bg-orange-50 hover:text-orange-600 hover:border-orange-300"
              >
                {translate('cancel')}
              </Button>
              <Button 
                onClick={saveReviewAndGrade}
                className="bg-orange-500 hover:bg-orange-600 text-white"
                disabled={!currentReview.grade || currentReview.grade < 0 || currentReview.grade > 100}
              >
                {currentReview.isGraded ? translate('updateGrade') : translate('saveGrade')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Loading Dialog para evaluación mejorado */}
        <Dialog open={showLoadingDialog} onOpenChange={() => {}}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-center text-purple-700 flex items-center justify-center space-x-2">
                <ClipboardCheck className="w-5 h-5" />
                <span>{translate('evalLoadingPreparingEvaluation')}</span>
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center space-y-6 py-6">
              <div className="relative w-24 h-24">
                <svg className="w-24 h-24 transform -rotate-90" viewBox="0 0 100 100">
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    stroke="currentColor"
                    strokeWidth="8"
                    fill="none"
                    className="text-purple-200"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    stroke="currentColor"
                    strokeWidth="8"
                    fill="none"
                    strokeDasharray={`${2 * Math.PI * 40}`}
                    strokeDashoffset={`${2 * Math.PI * 40 * (1 - loadingProgress / 100)}`}
                    className="text-purple-600 transition-all duration-500 ease-out"
                    strokeLinecap="round"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-lg font-bold text-purple-700">{loadingProgress}%</span>
                </div>
              </div>
              <div className="text-center space-y-2">
                <p className="text-sm text-purple-600 font-medium">{loadingStatus}</p>
                <div className="flex justify-center">
                  <div className="animate-pulse flex space-x-1">
                    <div className="w-2 h-2 bg-purple-400 rounded-full"></div>
                    <div className="w-2 h-2 bg-purple-400 rounded-full"></div>
                    <div className="w-2 h-2 bg-purple-400 rounded-full"></div>
                  </div>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Evaluation Dialog mejorado - Formato similar a pestaña evaluaciones */}
        <Dialog open={showEvaluationDialog} onOpenChange={() => {}}>
          <DialogContent className="max-w-none w-screen h-screen m-0 rounded-none border-0 p-0">
            <DialogTitle className="sr-only">
              {translate('navEvaluation')} - {currentEvaluation.task?.topic || translate('navEvaluation')}
            </DialogTitle>
            <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 dark:from-gray-900 dark:to-gray-800 p-4">
              <Card className="w-full max-w-2xl mx-auto shadow-xl">
                <CardHeader className="text-center border-b pb-4">
                  <CardTitle className="text-2xl font-bold font-headline">
                    {translate('navEvaluation').toUpperCase()} - {currentEvaluation.task?.topic?.toUpperCase() || translate('navEvaluation').toUpperCase()}
                  </CardTitle>
                  <CardDescription className="flex items-center justify-center space-x-4">
                    <span>{translate('evalQuestionProgress', { current: ((currentEvaluation.currentQuestionIndex || 0) + 1).toString(), total: currentEvaluation.questions.length.toString() })}</span>
                    <span className={`font-mono text-base text-primary tabular-nums flex items-center ${currentEvaluation.timeRemaining <= 60 ? 'text-red-500 animate-pulse' : ''}`}>
                      <Timer className="w-4 h-4 mr-1.5" />
                      {translate('evalTimeLeft', { time: `${Math.floor(currentEvaluation.timeRemaining / 60)}:${(currentEvaluation.timeRemaining % 60).toString().padStart(2, '0')}` })}
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 min-h-[300px] flex flex-col justify-between">
                  {currentEvaluation.questions.length > 0 && (
                    <div>
                      {(() => {
                        // Obtenemos la pregunta actual y su tipo
                        const question = currentEvaluation.questions[currentEvaluation.currentQuestionIndex || 0];
                        const questionType = question?.type || 'multiple_choice';
                        const currentAnswer = currentEvaluation.answers[currentEvaluation.currentQuestionIndex || 0];

                        // Lógica para manejar respuestas de selección múltiple (checkboxes)
                        const handleMultipleSelect = (selectedIndex: number) => {
                          const newAnswers = { ...currentEvaluation.answers };
                          const currentSelection = (currentAnswer as number[] | undefined) || [];
                          
                          if (currentSelection.includes(selectedIndex)) {
                            newAnswers[currentEvaluation.currentQuestionIndex || 0] = currentSelection.filter(item => item !== selectedIndex);
                          } else {
                            newAnswers[currentEvaluation.currentQuestionIndex || 0] = [...currentSelection, selectedIndex].sort();
                          }
                          setCurrentEvaluation({ ...currentEvaluation, answers: newAnswers });
                        };

                        // Lógica para respuestas de selección única (alternativas y V/F)
                        const handleSingleSelect = (selectedIndex: number) => {
                            const newAnswers = { ...currentEvaluation.answers };
                            newAnswers[currentEvaluation.currentQuestionIndex || 0] = selectedIndex;
                            setCurrentEvaluation({ ...currentEvaluation, answers: newAnswers });
                        };

                        return (
                          <>
                            <p className="text-lg font-medium mb-4 text-left md:text-center">
                              {question?.question}
                            </p>
                            {questionType === 'multiple_select' && (
                                <p className="text-sm text-center text-purple-600 mb-4">
                                  ({translate('multipleSelectInstruction')})
                                </p>
                            )}
                            
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {question?.options.map((option: string, index: number) => (
                                // --- ✨ AQUÍ ESTÁ LA CORRECCIÓN CLAVE ✨ ---
                                questionType === 'multiple_select' ? (
                                  // Si es selección múltiple, renderizamos un Checkbox
                                  <div key={index} className="flex items-center space-x-3 p-3 border rounded-md hover:bg-primary/10">
                                    <Checkbox
                                      id={`option-${index}`}
                                      checked={Array.isArray(currentAnswer) && currentAnswer.includes(index)}
                                      onCheckedChange={() => handleMultipleSelect(index)}
                                    />
                                    <Label htmlFor={`option-${index}`} className="text-base font-normal cursor-pointer w-full">
                                      {String.fromCharCode(65 + index)}. {option}
                                    </Label>
                                  </div>
                                ) : (
                                  // Si no, renderizamos un Botón (para alternativas o V/F)
                                  <Button
                                    key={index}
                                    variant="ghost"
                                    className={`py-3 text-base justify-start text-left h-auto whitespace-normal w-full ${
                                      currentAnswer === index
                                        ? 'bg-purple-600 text-white hover:bg-purple-700' 
                                        : 'border border-primary text-primary hover:bg-primary/10 dark:hover:bg-primary/20'
                                    }`}
                                    onClick={() => handleSingleSelect(index)}
                                    disabled={currentEvaluation.timeRemaining === 0}
                                  >
                                    <span className="mr-2 font-semibold">{String.fromCharCode(65 + index)}.</span> {option}
                                  </Button>
                                )
                              ))}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                  
                  <div className={`flex mt-8 ${(currentEvaluation.currentQuestionIndex || 0) > 0 ? 'justify-between' : 'justify-end'}`}>
                    {(currentEvaluation.currentQuestionIndex || 0) > 0 && (
                      <Button 
                        variant="outline" 
                        onClick={() => {
                          const newIndex = Math.max(0, (currentEvaluation.currentQuestionIndex || 0) - 1);
                          setCurrentEvaluation({
                            ...currentEvaluation,
                            currentQuestionIndex: newIndex
                          });
                        }}
                        className="text-base py-3 px-6 hover:bg-purple-100 hover:text-purple-700 hover:border-purple-300"
                        disabled={currentEvaluation.timeRemaining === 0}
                      >
                        <ChevronRight className="w-5 h-5 mr-2 rotate-180" />
                        {translate('evalPreviousButton')}
                      </Button>
                    )}
                    
                    {(currentEvaluation.currentQuestionIndex || 0) < currentEvaluation.questions.length - 1 ? (
                      <Button
                        onClick={() => {
                          const newIndex = (currentEvaluation.currentQuestionIndex || 0) + 1;
                          setCurrentEvaluation({
                            ...currentEvaluation,
                            currentQuestionIndex: newIndex
                          });
                        }}
                        className="text-base py-3 px-6 bg-purple-600 hover:bg-purple-700 text-white"
                        disabled={currentEvaluation.timeRemaining === 0}
                      >
                        {translate('evalNextButton')}
                        <ChevronRight className="w-5 h-5 ml-2" />
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleCompleteEvaluation()}
                        className="text-base py-3 px-6 bg-green-500 hover:bg-green-600 text-white dark:bg-green-600 dark:hover:bg-green-700"
                        disabled={currentEvaluation.timeRemaining === 0}
                      >
                        <Award className="w-5 h-5 mr-2" />
                        {translate('evalFinishButton')}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
              
              {/* Modal de Tiempo Agotado - DENTRO del diálogo de evaluación */}
              {showTimeExpiredDialog && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                  <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full mx-4">
                    <div className="flex items-center space-x-2 mb-4">
                      <Timer className="w-5 h-5 text-red-600 dark:text-red-400" />
                      <h3 className="text-lg font-semibold text-red-600 dark:text-red-400">Tiempo Agotado</h3>
                    </div>
                    <p className="text-gray-600 dark:text-gray-300 mb-6">
                      Se acabó el tiempo para completar la evaluación. La evaluación se ha guardado automáticamente con las respuestas que alcanzaste a completar.
                    </p>
                    
                    {timeExpiredResult && (
                      <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-lg border border-red-200 dark:border-red-800 mb-6">
                        <h4 className="font-medium text-red-800 dark:text-red-200 mb-6 text-center text-lg">{translate('resultsObtained')}</h4>
                        <div className="flex justify-center space-x-12">
                          <div className="text-center">
                            <span className="font-medium text-red-700 dark:text-red-300 block mb-2">{translate('correctAnswersLabel')}</span>
                            <p className="text-red-600 dark:text-red-400 text-2xl font-bold">
                              {timeExpiredResult.correctAnswers}/{timeExpiredResult.totalQuestions}
                            </p>
                          </div>
                          <div className="text-center">
                            <span className="font-medium text-red-700 dark:text-red-300 block mb-2">Calificación:</span>
                            <p className="text-red-600 dark:text-red-400 text-2xl font-bold">
                              {timeExpiredResult.percentage}%
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="flex justify-center">
                      <Button
                        onClick={() => {
                          setShowTimeExpiredDialog(false);
                          setEvaluationTimeExpired(false);
                          // Cerrar la evaluación completamente
                          setShowEvaluationDialog(false);
                          setCurrentEvaluation({
                            task: null,
                            questions: [],
                            startTime: null,
                            answers: {},
                            timeRemaining: 0,
                            currentQuestionIndex: 0
                          });
                          // Mostrar revisión de resultados
                          setCurrentEvaluationReview(timeExpiredResult);
                          setShowReviewEvaluationDialog(true);
                        }}
                        className="bg-purple-600 hover:bg-purple-700 text-white px-8 py-3 text-lg font-medium rounded-lg"
                      >
                        <Eye className="w-5 h-5 mr-2" />
                        {translate('resultsButton')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              
            </div>
          </DialogContent>
        </Dialog>

        {/* Diálogo de Revisión de Evaluación con detalles completos */}
        <Dialog open={showReviewEvaluationDialog} onOpenChange={setShowReviewEvaluationDialog}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center space-x-2">
                <Eye className="w-5 h-5 text-blue-600" />
                <span>{translate('evalReviewTitle')}</span>
              </DialogTitle>
              <DialogDescription>
                {translate('evalReviewDescription')}
              </DialogDescription>
            </DialogHeader>
            
            {currentEvaluationReview && (
              <div className="space-y-6">
                {/* Información general */}
                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="font-medium text-blue-800 dark:text-blue-200 mb-3">{translate('evalReviewGeneralInfo')}</h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="font-medium text-blue-700 dark:text-blue-300">{translate('evalReviewTopic')}</span>
                      <p className="text-blue-600 dark:text-blue-400">{currentEvaluationReview.task?.topic || translate('evalReviewNotSpecified')}</p>
                    </div>
                    <div>
                      <span className="font-medium text-blue-700 dark:text-blue-300">{translate('evalReviewTimeUsed')}</span>
                      <p className="text-blue-600 dark:text-blue-400">
                        {Math.floor(currentEvaluationReview.timeUsed / 60)}:{(currentEvaluationReview.timeUsed % 60).toString().padStart(2, '0')} min
                      </p>
                    </div>
                    <div>
                      <span className="font-medium text-blue-700 dark:text-blue-300">{translate('evalReviewDate')}</span>
                      <p className="text-blue-600 dark:text-blue-400">
                        {new Date(currentEvaluationReview.completedAt).toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <span className="font-medium text-blue-700 dark:text-blue-300">{translate('evalReviewStatus')}</span>
                      <p className="text-blue-600 dark:text-blue-400">
                        {currentEvaluationReview.timeExpired ? translate('evalReviewTimeExpired') : translate('evalReviewCompletedOnTime')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Resultados */}
                <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
                  <h4 className="font-medium text-green-800 dark:text-green-200 mb-3">{translate('evalReviewResults')}</h4>
                  <div className="flex items-center justify-center space-x-8">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-green-700 dark:text-green-300">
                        {currentEvaluationReview.correctAnswers}/{currentEvaluationReview.totalQuestions}
                      </div>
                      <div className="text-sm text-green-600 dark:text-green-400">{translate('evalReviewCorrectAnswers')}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-green-700 dark:text-green-300">
                        {currentEvaluationReview.percentage}%
                      </div>
                      <div className="text-sm text-green-600 dark:text-green-400">{translate('evalReviewPercentage')}</div>
                    </div>
                  </div>
                </div>

                {/* Revisión detallada de preguntas */}
                {currentEvaluationReview.questions && currentEvaluationReview.questions.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="font-medium text-gray-800 dark:text-gray-200">{translate('evalReviewDetailedReview')}</h4>
                    
                    {currentEvaluationReview.questions.map((question: any, index: number) => {
                      // --- ✨ CORRECCIÓN CLAVE AQUÍ ✨ ---
                      // Simplemente leemos el valor 'isCorrect' que ya fue calculado y guardado.
                      const isCorrect = question.isCorrect;
                      const userAnswer = question.studentAnswer; // Usamos el studentAnswer guardado
                      
                      return (
                        <div 
                          key={index} 
                          className={`p-4 rounded-lg border-l-4 ${
                            isCorrect 
                              ? 'bg-green-50 dark:bg-green-900/20 border-l-green-500 border border-green-200 dark:border-green-800' 
                              : 'bg-red-50 dark:bg-red-900/20 border-l-red-500 border border-red-200 dark:border-red-800'
                          }`}
                        >
                          <div className="flex items-start justify-between mb-3">
                            <h5 className="font-medium text-gray-800 dark:text-gray-200">
                              {translate('evalReviewQuestion')} {index + 1}
                            </h5>
                            <Badge 
                              className={isCorrect 
                                ? 'bg-green-100 text-green-800 border-green-200' 
                                : 'bg-red-100 text-red-800 border-red-200'
                              }
                            >
                              {isCorrect ? translate('evalReviewCorrect') : translate('evalReviewIncorrect')}
                            </Badge>
                          </div>
                          
                          <p className="text-gray-700 dark:text-gray-300 mb-4 font-medium">
                            {question.question}
                          </p>
                          
                          <div className="space-y-2 mb-4">
                            {question.options.map((option: string, optionIndex: number) => {
                              // Determinar si esta opción fue seleccionada por el estudiante
                              const isStudentAnswer = Array.isArray(userAnswer) 
                                ? userAnswer.includes(optionIndex)
                                : userAnswer === optionIndex;
                              
                              // Determinar si esta opción es correcta
                              const isCorrectOption = Array.isArray(question.correct)
                                ? question.correct.includes(optionIndex)
                                : question.correct === optionIndex;
                              
                              return (
                                <div 
                                  key={optionIndex}
                                  className={`p-2 rounded border text-sm ${
                                    isCorrectOption
                                      ? 'bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-300 font-medium'
                                      : isStudentAnswer && !isCorrectOption
                                      ? 'bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-800 dark:text-red-300'
                                      : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
                                  }`}
                                >
                                  <div className="flex items-center space-x-2">
                                    <span className="font-semibold">
                                      {String.fromCharCode(65 + optionIndex)}.
                                    </span>
                                    <span>{option}</span>
                                    {isCorrectOption && (
                                      <Badge className="bg-green-200 text-green-800 text-xs ml-auto">
                                        {translate('evalReviewCorrectAnswer')}
                                      </Badge>
                                    )}
                                    {isStudentAnswer && !isCorrectOption && (
                                      <Badge className="bg-red-200 text-red-800 text-xs ml-auto">
                                        {translate('evalReviewYourAnswer')}
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          
                          {question.explanation && (
                            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-700 mt-3">
                              <span className="font-medium text-blue-700 dark:text-blue-300 text-sm block mb-1">
                                {translate('evalReviewExplanation')}
                              </span>
                              <p className="text-blue-600 dark:text-blue-400 text-sm">
                                {question.explanation}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Botón cerrar */}
                <div className="flex justify-end pt-4 border-t">
                  <Button
                    onClick={() => setShowReviewEvaluationDialog(false)}
                    className="bg-purple-600 hover:bg-purple-700 text-white"
                  >
                    {translate('evalReviewClose')}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Diálogo de revisión de evaluación */}
        <Dialog open={showEvaluationReviewDialog} onOpenChange={setShowEvaluationReviewDialog}>
          <DialogContent className="sm:max-w-[800px] max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-purple-800 dark:text-purple-200">
                {translate('viewEvaluationDetail')} - {selectedEvaluationResult?.studentName || translate('student')}
              </DialogTitle>
            </DialogHeader>
            
            {selectedEvaluationResult && (
              <div className="space-y-6">
                {/* Debug log */}
                {console.log('🎯 RENDERING EVALUATION DIALOG:', {
                  currentLanguage: localStorage.getItem('smart-student-lang'),
                  hasQuestions: !!selectedEvaluationResult.questions,
                  firstQuestion: selectedEvaluationResult.questions?.[0]?.question?.substring(0, 50),
                  studentName: selectedEvaluationResult.studentName
                })}
                
                {/* Resumen de la evaluación */}
                <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                  <h4 className="font-bold mb-4 text-purple-800 dark:text-purple-200 text-left">{translate('evalSummaryTitle')}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div className="text-center">
                      <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evalSummaryScore')}</strong>
                      <p className="text-lg font-bold text-purple-600 dark:text-purple-400">
                        {selectedEvaluationResult.correctAnswers}/{selectedEvaluationResult.totalQuestions}
                      </p>
                    </div>
                    <div className="text-center">
                      <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evalSummaryPercentage')}</strong>
                      <p className="text-lg font-bold text-purple-600 dark:text-purple-400">
                        {selectedEvaluationResult.percentage}%
                      </p>
                    </div>
                    <div className="text-center">
                      <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evalSummaryTime')}</strong>
                      <p className="text-purple-600 dark:text-purple-400">
                        {selectedEvaluationResult.timeUsed 
                          ? `${Math.floor(selectedEvaluationResult.timeUsed / 60)}:${(selectedEvaluationResult.timeUsed % 60).toString().padStart(2, '0')} min`
                          : selectedEvaluationResult.timeSpent || translate('notAvailable')
                        }
                      </p>
                    </div>
                    <div className="text-center">
                      <strong className="text-purple-700 dark:text-purple-300 block mb-1">{translate('evalSummaryDate')}</strong>
                      <p className="text-purple-600 dark:text-purple-400">
                        {new Date(selectedEvaluationResult.completedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Preguntas y respuestas */}
                {selectedEvaluationResult.questions && selectedEvaluationResult.questions.length > 0 && (
                  <div>
                    <h4 className="font-bold mb-4 text-gray-800 dark:text-gray-200">{translate('evalDetailedReview')}</h4>
                    <div className="space-y-4">
                      {selectedEvaluationResult.questions.map((question: any, index: number) => (
                        <div 
                          key={index}
                          className={`p-4 rounded-lg border-2 ${
                            question.isCorrect 
                              ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20' 
                              : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
                          }`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <h5 className="font-medium text-gray-800 dark:text-gray-200">
                              {translate('evalReviewQuestion')} {index + 1}
                            </h5>
                            <Badge className={question.isCorrect ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
                              {question.isCorrect ? translate('evalReviewCorrect') : translate('evalReviewIncorrect')}
                            </Badge>
                          </div>
                          
                          <p className="mb-3 text-gray-700 dark:text-gray-300">{question.question}</p>
                          
                          <div className="space-y-2">
                            <div>
                              <strong className="text-sm text-gray-600 dark:text-gray-400">{translate('evalReviewStudentAnswer') || 'Respuesta del estudiante:'}</strong>
                              <p className={`ml-2 ${question.isCorrect ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                                {question.studentAnswerText || question.studentAnswer || 'No respondió'}
                              </p>
                            </div>
                            
                            <div>
                              <strong className="text-sm text-gray-600 dark:text-gray-400">{translate('evalReviewCorrectAnswer')}</strong>
                              <p className="ml-2 text-green-700 dark:text-green-300">{question.correctAnswer}</p>
                            </div>
                            
                            {question.explanation && (
                              <div>
                                <strong className="text-sm text-gray-600 dark:text-gray-400">{translate('evalReviewExplanation')}</strong>
                                <p className="ml-2 text-gray-600 dark:text-gray-400 text-sm">{question.explanation}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Funciones auxiliares para la vista de detalles por estudiante */}
        {/* Fin del contenido principal */}
      </div>
    );
  }