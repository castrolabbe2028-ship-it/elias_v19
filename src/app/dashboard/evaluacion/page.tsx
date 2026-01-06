"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLanguage } from '@/contexts/language-context';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { ClipboardList, PlayCircle, ChevronLeft, ChevronRight, PartyPopper, Award, Timer, BookOpen, Loader2 } from 'lucide-react';
import { BookCourseSelector } from '@/components/common/book-course-selector';
import { generateEvaluationContent, type EvaluationQuestion } from '@/ai/flows/generate-evaluation-content';
import { analyzeSubjectTopics } from '@/ai/flows/analyze-subject-topics';
import { TopicDescription } from '@/lib/topic-descriptions';
import { submitEvaluationAction, generateEvaluationAction } from '@/actions/evaluation-actions';
import { useToast } from "@/hooks/use-toast";
import { useAIProgress } from "@/hooks/use-ai-progress";
import { cn } from '@/lib/utils';
import { contentDB } from '@/lib/sql-content';
import { Label } from '@/components/ui/label';
import type { EvaluationHistoryItem } from '@/lib/types';
import { useSearchParams, useRouter } from 'next/navigation';
import { TaskNotificationManager } from '@/lib/notifications'; 
import { sendEmailOnNotification } from '@/services/email-notification.service'; 

type UserAnswer = boolean | number | number[] | null; 

// Fisher-Yates shuffle function
function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

// Tiempo por pregunta en segundos (1.5 minutos = 90 segundos por pregunta)
const SECONDS_PER_QUESTION = 90;
const DEFAULT_QUESTION_COUNT = 15;
const INITIAL_TIME_LIMIT = DEFAULT_QUESTION_COUNT * SECONDS_PER_QUESTION; // 22.5 minutes by default

// Función para calcular tiempo límite basado en cantidad de preguntas
const calculateTimeLimit = (questionCount: number): number => {
  return questionCount * SECONDS_PER_QUESTION;
};

export default function EvaluacionPage() {
  const { translate, language: currentUiLanguage, setLanguage } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const { progress, progressText, isLoading: aiIsLoading, startProgress, stopProgress } = useAIProgress();
  const searchParams = useSearchParams();
  const router = useRouter(); 

  // Setup state
  const [selectedCourse, setSelectedCourse] = useState('');
  const [selectedBook, setSelectedBook] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [currentTopicForDisplay, setCurrentTopicForDisplay] = useState('');
  const [selectedQuestionCount, setSelectedQuestionCount] = useState(15);
  
  // Estados para análisis automático de temas de cualquier asignatura
  const [subjectTopics, setSubjectTopics] = useState<string[]>([]);
  const [selectedSubjectTopic, setSelectedSubjectTopic] = useState<string>('');
  const [isAnalyzingSubject, setIsAnalyzingSubject] = useState(false);
  const [subjectBookTitle, setSubjectBookTitle] = useState<string>('');
  const [topicDescriptions, setTopicDescriptions] = useState<Record<string, TopicDescription>>({});
  const hasAnalyzedRef = useRef<string>('');
  
  // Evaluation state
  const [evaluationTitle, setEvaluationTitle] = useState('');
  const [evaluationQuestions, setEvaluationQuestions] = useState<EvaluationQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<UserAnswer[]>([]);
  
  // Control state
  const [evaluationStarted, setEvaluationStarted] = useState(false);
  const [evaluationFinished, setEvaluationFinished] = useState(false);
  const [showResultDialog, setShowResultDialog] = useState(false);
  const [showTimeUpDialog, setShowTimeUpDialog] = useState(false);
  const [score, setScore] = useState(0);
  const [motivationalMessageKey, setMotivationalMessageKey] = useState('');

  // Timer state
  const [timeLeft, setTimeLeft] = useState(INITIAL_TIME_LIMIT);
  const [timerActive, setTimerActive] = useState(false);
  const [startTime, setStartTime] = useState<Date | null>(null);

  // Completion tracking
  const [completionPercentage, setCompletionPercentage] = useState(0);
  const [isSubmittingEvaluation, setIsSubmittingEvaluation] = useState(false);

  // Log initial time limit for debugging
  console.log('Initial time limit set to:', INITIAL_TIME_LIMIT, 'seconds (', INITIAL_TIME_LIMIT/60, 'minutes)');

  // For pre-filling from query params
  const [initialBookFromQuery, setInitialBookFromQuery] = useState<string | undefined>(undefined);

  // Check and clean localStorage on component mount to prevent quota issues
  useEffect(() => {
    const checkLocalStorageQuota = () => {
      try {
        // Try to estimate localStorage usage
        let totalSize = 0;
        for (let key in localStorage) {
          if (localStorage.hasOwnProperty(key)) {
            totalSize += localStorage[key].length + key.length;
          }
        }
        
        console.log(`📊 LocalStorage usage: ~${Math.round(totalSize / 1024)}KB`);
        
        // If usage is over 4MB (approaching 5MB limit), clean evaluation histories
        if (totalSize > 4 * 1024 * 1024) {
          console.warn('🧹 LocalStorage approaching limit, cleaning evaluation histories...');
          
          Object.keys(localStorage)
            .filter(key => key.startsWith('evaluationHistory_'))
            .forEach(key => {
              try {
                const history = JSON.parse(localStorage.getItem(key) || '[]');
                if (Array.isArray(history) && history.length > 20) {
                  // Keep only last 20 evaluations per user
                  const reducedHistory = history.slice(0, 20);
                  localStorage.setItem(key, JSON.stringify(reducedHistory));
                  console.log(`✂️ Reduced ${key} from ${history.length} to ${reducedHistory.length} items`);
                }
              } catch (e) {
                console.error(`Error cleaning ${key}:`, e);
                localStorage.removeItem(key); // Remove corrupted data
              }
            });
        }
      } catch (error) {
        console.error('Error checking localStorage quota:', error);
      }
    };
    
    checkLocalStorageQuota();
  }, []); // Run once on mount

  // Helper para obtener el nombre legible del curso CON SECCIÓN
  const getCourseDisplayName = (courseId: string): string => {
    try {
      const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]');
      const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]');
      const currentYear = new Date().getFullYear();
      const students = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]');
      
      // Si es un ID compuesto (courseId-sectionId)
      if (courseId.includes('-') && courseId.length > 40) {
        const parts = courseId.split('-');
        if (parts.length >= 10) {
          const actualCourseId = parts.slice(0, 5).join('-');
          const sectionId = parts.slice(5).join('-');
          
          const course = courses.find((c: any) => c.id === actualCourseId);
          const section = sections.find((s: any) => s.id === sectionId);
          
          if (course && section) {
            return `${course.name} Sección ${section.name}`;
          }
        }
      }
      
      // Buscar directamente en cursos
      const course = courses.find((c: any) => c.id === courseId);
      if (course) {
        // Intentar obtener la sección del estudiante actual
        const studentId = (user as any)?.id || user?.username;
        const student = students.find((s: any) => s.id === studentId || s.username === studentId);
        
        if (student?.sectionId) {
          const section = sections.find((s: any) => s.id === student.sectionId);
          if (section) {
            return `${course.name} Sección ${section.name}`;
          }
        }
        
        // Si no encontramos sección del estudiante, buscar por courseId en secciones
        const sectionForCourse = sections.find((s: any) => s.courseId === courseId || s.courseId === course.id);
        if (sectionForCourse) {
          return `${course.name} Sección ${sectionForCourse.name}`;
        }
        
        return course.name;
      }
      
      // Si no es UUID, puede ser el nombre ya
      if (!courseId.includes('-') || courseId.length < 30) {
        return courseId; // Ya es un nombre legible
      }
      
      return courseId;
    } catch (e) {
      console.warn('Error getting course name:', e);
      return courseId;
    }
  };

  // Detectar el tipo de asignatura para mostrar icono apropiado
  const subjectIcon = useMemo(() => {
    const s = `${selectedBook || ''} ${selectedSubject || ''}`.toLowerCase();
    if (/matem|math|algebra|geometr/i.test(s)) return '🔢';
    if (/lenguaje|comunicacion|language|literatura/i.test(s)) return '📚';
    if (/ciencia|natural|science|biolog/i.test(s)) return '🔬';
    if (/historia|geography|social|civica/i.test(s)) return '🌍';
    return '📖';
  }, [selectedBook, selectedSubject]);

  // Analizar automáticamente los temas cuando se selecciona cualquier asignatura O cuando cambia el idioma
  useEffect(() => {
    // Incluir el idioma en la clave para forzar re-análisis cuando cambie
    const analyzeKey = `${selectedCourse}_${selectedSubject}_${currentUiLanguage}`;
    
    if (selectedCourse && selectedSubject && hasAnalyzedRef.current !== analyzeKey) {
      hasAnalyzedRef.current = analyzeKey;
      setIsAnalyzingSubject(true);
      setSubjectTopics([]);
      setSelectedSubjectTopic('');
      setSubjectBookTitle('');
      
      console.log('[Evaluation] Starting subject analysis for:', selectedCourse, selectedSubject, 'Language:', currentUiLanguage);
      
      analyzeSubjectTopics({
        courseName: selectedCourse,
        subjectName: selectedSubject,
        language: currentUiLanguage,
      }).then((res) => {
        console.log('[Evaluation] Subject analysis result:', res);
        if (res.topics && res.topics.length > 0) {
          setSubjectTopics(res.topics);
          setSubjectBookTitle(res.bookTitle || '');
          // Guardar las descripciones de temas si existen
          if (res.topicDescriptions) {
            setTopicDescriptions(res.topicDescriptions);
          } else {
            setTopicDescriptions({});
          }
          toast({
            title: translate('quizPdfAnalyzeDone') || 'Análisis completado',
            description: `${translate('quizPdfTopicsFound') || 'Temas detectados'}: ${res.topics.length}`,
            variant: 'default',
          });
        }
      }).catch((e) => {
        console.error('[Evaluation] Error analizando asignatura:', e);
      }).finally(() => {
        setIsAnalyzingSubject(false);
      });
    } else if (!selectedSubject) {
      // Limpiar cuando no hay asignatura
      setSubjectTopics([]);
      setSelectedSubjectTopic('');
      setSubjectBookTitle('');
      setTopicDescriptions({});
    }
  }, [selectedCourse, selectedSubject, currentUiLanguage, toast, translate]);

  // Cuando se selecciona un tema de la asignatura, actualizar el campo de tema
  const handleSubjectTopicSelect = useCallback((value: string) => {
    setSelectedSubjectTopic(value);
    if (value) setTopic(value);
  }, []);

  const [isAutoStartMode, setIsAutoStartMode] = useState(false);
  const [isTaskEvaluationSession, setIsTaskEvaluationSession] = useState(false);
  const [showReadyTransition, setShowReadyTransition] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const hasAutoStarted = useRef(false);

  // Función para detectar si es evaluación de tarea de forma robusta
  const isTaskEvaluationDetection = useCallback(() => {
    // Método 1: Estado React
    if (isTaskEvaluationSession) {
      console.log('📍 Task detected via React state');
      return true;
    }
    
    // Método 2: localStorage
    if (localStorage.getItem('isTaskEvaluation') === 'true') {
      console.log('📍 Task detected via localStorage');
      return true;
    }
    
    // Método 3: sessionStorage (respaldo adicional)
    if (sessionStorage.getItem('isTaskEvaluation') === 'true') {
      console.log('📍 Task detected via sessionStorage');
      return true;
    }
    
    // Método 4: URL params
    const autoStart = searchParams.get('autoStart');
    const taskId = searchParams.get('taskId');
    if (autoStart === 'true' || taskId) {
      console.log('📍 Task detected via URL params:', { autoStart, taskId });
      return true;
    }
    
    // Método 5: Estado de auto-start
    if (isAutoStartMode) {
      console.log('📍 Task detected via isAutoStartMode');
      return true;
    }
    
    console.log('📍 No task evaluation detected');
    return false;
  }, [isTaskEvaluationSession, searchParams, isAutoStartMode]);

  // useEffect para recuperar estado al montar el componente - MEJORADO
  useEffect(() => {
    const savedTaskEvaluation = localStorage.getItem('isTaskEvaluation') === 'true';
    const sessionTaskEvaluation = sessionStorage.getItem('isTaskEvaluation') === 'true';
    
    if (savedTaskEvaluation || sessionTaskEvaluation) {
      console.log('🔄 Recovering task evaluation state from storage:', { localStorage: savedTaskEvaluation, sessionStorage: sessionTaskEvaluation });
      setIsTaskEvaluationSession(true);
      setIsAutoStartMode(true); // TAMBIÉN establecer isAutoStartMode para consistencia
      
      // Verificar si necesitamos recuperar estado de evaluación finalizada
      const savedEvaluationFinished = localStorage.getItem('evaluationFinished') === 'true';
      if (savedEvaluationFinished) {
        console.log('🔄 Recovering finished evaluation state');
        setEvaluationFinished(true);
        setShowResultDialog(false); // Asegurar que muestre la pantalla de revisión
      }
    }
  }, []); // Solo ejecutar una vez al montar

  // useEffect para manejar parámetros de URL - optimizado para evitar loops
  useEffect(() => {
    const courseFromQuery = searchParams.get('course');
    const bookFromQueryParam = searchParams.get('book');
    const topicFromQuery = searchParams.get('topic');
    const autoStart = searchParams.get('autoStart');
    const taskId = searchParams.get('taskId');

    console.log('🔍 useEffect - URL Parameters:', {
      courseFromQuery,
      bookFromQueryParam,
      topicFromQuery,
      autoStart,
      taskId,
      hasAutoStarted: hasAutoStarted.current
    });

    // Establecer si estamos en modo de tarea
    const isTaskMode = autoStart === 'true' || !!taskId;
    
    console.log('🎯 Task Mode Detection:', {
      autoStart_is_true: autoStart === 'true',
      taskId_present: !!taskId,
      isTaskMode,
      currentTaskState: isTaskEvaluationSession
    });
    
    // Solo actualizar estado si hay cambios reales
    if (isTaskMode !== isTaskEvaluationSession) {
      console.log('🔄 Updating task evaluation state:', isTaskMode);
      setIsAutoStartMode(isTaskMode);
      setIsTaskEvaluationSession(isTaskMode);

      // Guardar en ambos storages si es evaluación de tarea
      if (isTaskMode) {
        localStorage.setItem('isTaskEvaluation', 'true');
        sessionStorage.setItem('isTaskEvaluation', 'true');
        console.log('✅ Setting isTaskEvaluation=true in both storages');
      } else {
        // Si no es tarea, limpiar storages Y campos del formulario
        localStorage.removeItem('isTaskEvaluation');
        sessionStorage.removeItem('isTaskEvaluation');
        localStorage.removeItem('evaluationFinished');
        console.log('🧹 Cleaning isTaskEvaluation from both storages');
        
        // NUEVO: También limpiar campos si venimos de cerrar una tarea
        if (isTaskEvaluationSession || isAutoStartMode) {
          console.log('🧹 Clearing form fields after task closure');
          setSelectedCourse('');
          setSelectedBook('');
          setSelectedSubject(''); // AGREGAR LIMPIEZA DE SUBJECT
          setTopic('');
          setCurrentTopicForDisplay('');
          setInitialBookFromQuery(undefined);
        }
      }
    }

    // Actualizar datos del formulario solo si es necesario
    if (courseFromQuery && selectedCourse !== decodeURIComponent(courseFromQuery)) {
      setSelectedCourse(decodeURIComponent(courseFromQuery));
    }
    if (bookFromQueryParam) {
      const decodedBook = decodeURIComponent(bookFromQueryParam);
      if (selectedBook !== decodedBook) {
        setInitialBookFromQuery(decodedBook);
        setSelectedBook(decodedBook);
      }
    } else if (initialBookFromQuery !== undefined) {
      setInitialBookFromQuery(undefined);
    }
    if (topicFromQuery && topic !== decodeURIComponent(topicFromQuery)) {
      setTopic(decodeURIComponent(topicFromQuery));
    }

    // Auto-start solo una vez y solo si tenemos todos los parámetros necesarios
    if (autoStart === 'true' && courseFromQuery && bookFromQueryParam && topicFromQuery && !hasAutoStarted.current) {
      hasAutoStarted.current = true;
      console.log('🚀 Auto-starting task evaluation with params:', {
        course: decodeURIComponent(courseFromQuery),
        book: decodeURIComponent(bookFromQueryParam),
        topic: decodeURIComponent(topicFromQuery),
        taskId
      });
      
      // Pequeño delay para asegurar que el estado se ha actualizado
      setTimeout(() => {
        handleCreateEvaluation();
      }, 100);
    }
  }, [searchParams.toString(), selectedCourse, selectedBook, topic, isTaskEvaluationSession, initialBookFromQuery]); // Dependencias optimizadas

  // useEffect para configurar 15 preguntas por defecto en modo profesor
  useEffect(() => {
    if (user?.role === 'teacher') {
      setSelectedQuestionCount(15);
    }
  }, [user?.role]);

  // useEffect para sincronizar idioma del contexto con localStorage
  useEffect(() => {
    console.log('🔄 Language context changed:', { currentUiLanguage });
    if (currentUiLanguage && (currentUiLanguage === 'en' || currentUiLanguage === 'es')) {
      // Force sync with localStorage to ensure consistency
      localStorage.setItem('smart-student-lang', currentUiLanguage);
      console.log('🔄 Language synced to localStorage:', currentUiLanguage);
      
      // Also sync with document.documentElement.lang
      document.documentElement.lang = currentUiLanguage;
      console.log('🔄 Language synced to document.lang:', currentUiLanguage);
    }
  }, [currentUiLanguage]);

  const calculateScore = useCallback(() => {
    let correctAnswers = 0;
    evaluationQuestions.forEach((q, index) => {
      const userAnswer = userAnswers[index];
      if (q.type === 'TRUE_FALSE' && userAnswer === q.correctAnswer) {
        correctAnswers++;
      } else if (q.type === 'MULTIPLE_CHOICE' && userAnswer === q.correctAnswerIndex) {
        correctAnswers++;
      } else if (q.type === 'MULTIPLE_SELECTION' && Array.isArray(userAnswer) && Array.isArray(q.correctAnswerIndices)) {
        // Check if user selected exactly the correct answers
        const userAnswerSorted = [...userAnswer].sort();
        const correctAnswerSorted = [...q.correctAnswerIndices].sort();
        if (userAnswerSorted.length === correctAnswerSorted.length &&
            userAnswerSorted.every((val, idx) => val === correctAnswerSorted[idx])) {
          correctAnswers++;
        }
      }
    });
    return correctAnswers;
  }, [evaluationQuestions, userAnswers]);

  const saveEvaluationToHistory = useCallback((finalScore: number, totalQuestions: number) => {
    if ((!selectedBook && !selectedSubject) || !currentTopicForDisplay || !selectedCourse || !user) return;

    const newHistoryItem: EvaluationHistoryItem = {
      id: new Date().toISOString(),
      date: new Date().toLocaleDateString('es-ES', { 
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }) + ', ' + new Date().toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }) + ' Hrs',
      courseName: selectedCourse, 
      bookTitle: selectedBook || selectedSubject,
      topic: currentTopicForDisplay,
      score: finalScore,
      totalQuestions: totalQuestions,
    };

    // Helper function to check if error is quota related
    const isQuotaError = (err: unknown): boolean => {
      if (err instanceof Error) {
        return err.name === 'QuotaExceededError' || 
               err.message.includes('quota') ||
               err.message.includes('QUOTA_BYTES') ||
               err.message.includes('storage');
      }
      return false;
    };

    // Helper function to safely save to localStorage with aggressive cleanup
    const trySaveWithCleanup = (item: EvaluationHistoryItem, maxItems: number): boolean => {
      try {
        const historyKey = `evaluationHistory_${user.username}`;
        const existingHistoryString = localStorage.getItem(historyKey);
        const existingHistory: EvaluationHistoryItem[] = existingHistoryString ? JSON.parse(existingHistoryString) : [];
        const updatedHistory = [item, ...existingHistory].slice(0, maxItems);
        localStorage.setItem(historyKey, JSON.stringify(updatedHistory));
        console.log(`✅ Evaluation history saved. Total items: ${updatedHistory.length}`);
        return true;
      } catch {
        return false;
      }
    };

    // Helper function to clean other localStorage data
    const cleanOtherLocalStorageData = () => {
      try {
        // Remove old/temporary localStorage keys that might be taking space
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (
            key.startsWith('temp_') ||
            key.startsWith('debug_') ||
            key.includes('_old') ||
            key.includes('_backup')
          )) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        console.log(`🧹 Cleaned ${keysToRemove.length} temporary localStorage keys`);
      } catch (e) {
        console.warn('Could not clean localStorage:', e);
      }
    };

    try {
      // First attempt: try to save with up to 50 items
      if (trySaveWithCleanup(newHistoryItem, 50)) {
        return; // Success!
      }
      
      // If failed, try cleanup and reduce to 20 items
      console.warn('🚨 LocalStorage may be full. Cleaning up...');
      cleanOtherLocalStorageData();
      
      if (trySaveWithCleanup(newHistoryItem, 20)) {
        toast({
          title: 'Historial limitado',
          description: 'Se ha reducido el historial de evaluaciones para liberar espacio.',
          variant: 'default',
        });
        return;
      }
      
      // Try with just 5 items
      if (trySaveWithCleanup(newHistoryItem, 5)) {
        toast({
          title: 'Historial limitado',
          description: 'Se ha reducido el historial de evaluaciones para liberar espacio.',
          variant: 'default',
        });
        return;
      }
      
      // Final attempt: clear all history and save just this one
      try {
        const historyKey = `evaluationHistory_${user.username}`;
        localStorage.removeItem(historyKey);
        localStorage.setItem(historyKey, JSON.stringify([newHistoryItem]));
        console.log('✅ Evaluation history reset. Starting fresh with current evaluation.');
        toast({
          title: 'Historial reiniciado',
          description: 'Se ha reiniciado el historial de evaluaciones por falta de espacio.',
          variant: 'default',
        });
        return;
      } catch (e) {
        console.error('Complete failure to save evaluation history:', e);
        // Silent failure - don't show error toast, the evaluation was still completed
        console.warn('⚠️ No se pudo guardar en historial local, pero la evaluación se completó correctamente.');
      }
    } catch (error) {
      console.error("Failed to save evaluation history:", error);
      // Only show error if it's not a quota issue (which was already handled)
      if (!isQuotaError(error)) {
        console.warn('⚠️ Error inesperado al guardar historial. La evaluación se completó correctamente.');
      }
    }
  }, [selectedCourse, selectedBook, selectedSubject, currentTopicForDisplay, user, toast, translate, currentUiLanguage]);

  const handleFinishEvaluation = useCallback(async () => {
    const finalScore = calculateScore();
    setScore(finalScore);
    
    const totalQuestions = evaluationQuestions.length;
    const percentage = totalQuestions > 0 ? (finalScore / totalQuestions) * 100 : 0;
    setCompletionPercentage(percentage);
    // Guardar evaluación en la nueva base de datos (Supabase/IDB)
    try {
      await contentDB.saveEvaluation({
        id: crypto.randomUUID(),
        userId: (user as any)?.id || null,
        username: user?.username || null,
        courseId: selectedCourse || null,
        sectionId: null,
        subjectName: selectedBook || selectedSubject || null,
        topic: currentTopicForDisplay || topic,
        score: finalScore,
        totalQuestions: totalQuestions,
        percentage: Math.round(percentage),
        timeSpentSeconds: startTime ? Math.floor((Date.now() - startTime.getTime()) / 1000) : undefined,
        language: currentUiLanguage,
        createdAt: new Date().toISOString()
      });
    } catch (e) {
      console.warn('[Evaluación] No se pudo persistir evaluación en BD', e);
    }

    if (percentage === 100) {
      setMotivationalMessageKey('evalMotivationalPerfect');
    } else if (percentage >= 50) {
      setMotivationalMessageKey('evalMotivationalGood');
    } else {
      setMotivationalMessageKey('evalMotivationalImprovement');
    }
    
    // Calcular tiempo gastado
    const timeSpent = startTime ? Math.floor((Date.now() - startTime.getTime()) / 1000) : 0;
    
    // Preservar estado de evaluación de tarea al finalizar - MEJORADO
    const autoStart = searchParams.get('autoStart') === 'true';
    const taskId = searchParams.get('taskId');
    const isCurrentlyTaskEvaluation = isTaskEvaluationSession || isAutoStartMode;
    
    if (autoStart || taskId || isCurrentlyTaskEvaluation) {
      console.log('💾 Preserving task evaluation state after finishing evaluation');
      localStorage.setItem('isTaskEvaluation', 'true');
      sessionStorage.setItem('isTaskEvaluation', 'true');
      localStorage.setItem('evaluationFinished', 'true'); // NUEVO: Preservar estado finalizado
      setIsTaskEvaluationSession(true);
      setIsAutoStartMode(true);

      // Si es una evaluación de tarea, enviar los resultados usando server action
      if (taskId && user) {
        try {
          setIsSubmittingEvaluation(true);
          
          console.log('🚀 Submitting evaluation with data:', {
            taskId,
            studentId: user.username,
            score: finalScore,
            totalQuestions,
            completionPercentage: percentage,
            timeSpent,
            evaluationTitle,
            course: selectedCourse,
            subject: selectedBook,
            topic: currentTopicForDisplay
          });
          
          const result = await submitEvaluationAction({
            taskId: taskId,
            studentId: user.username,
            studentName: user.username,
            answers: userAnswers,
            score: finalScore,
            totalQuestions: totalQuestions,
            completionPercentage: percentage,
            timeSpent: timeSpent,
            evaluationTitle: evaluationTitle,
            course: selectedCourse,
            subject: selectedBook,
            topic: currentTopicForDisplay
          });

          console.log('📥 Server action result:', result);

          if (result.success) {
            // Actualizar localStorage del lado del cliente con los datos del servidor
            if (result.submissionData) {
              const existingSubmissions = JSON.parse(localStorage.getItem('taskSubmissions') || '[]');
              existingSubmissions.push(result.submissionData);
              localStorage.setItem('taskSubmissions', JSON.stringify(existingSubmissions));
              console.log('✅ Updated taskSubmissions in localStorage');
            }

            // Actualizar el estado de la tarea para este estudiante
            const userTasksKey = `userTasks_${user.username}`;
            let userTasks = JSON.parse(localStorage.getItem(userTasksKey) || '[]');
            console.log('📋 Current user tasks before update:', userTasks);
            
            let taskIndex = userTasks.findIndex((task: any) => task.id === taskId);
            console.log('🔍 Found task at index:', taskIndex, 'for taskId:', taskId);
            
            // Si la tarea no existe en el userTasks del estudiante, crearla desde las tareas globales
            if (taskIndex === -1) {
              console.log('⚠️ Task not found in user tasks, attempting to create from global tasks');
              const globalTasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
              const globalTask = globalTasks.find((task: any) => task.id === taskId);
              
              if (globalTask) {
                console.log('✅ Found task in global tasks, adding to user tasks:', globalTask);
                userTasks.push(globalTask);
                taskIndex = userTasks.length - 1;
              } else {
                console.error('❌ Task not found in global tasks either. Creating basic task structure.');
                // Crear estructura básica de tarea si no se encuentra
                const basicTask = {
                  id: taskId,
                  title: evaluationTitle || 'Evaluación',
                  description: `Evaluación de ${currentTopicForDisplay}`,
                  subject: selectedBook,
                  course: selectedCourse,
                  assignedBy: 'evaluacion', // Cambiar de 'system' a 'evaluacion'
                  assignedByName: `${evaluationTitle || 'Evaluación'} (${selectedCourse})`, // Usar título y curso
                  assignedTo: 'course',
                  dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Mañana
                  createdAt: new Date().toISOString(),
                  status: 'pending',
                  priority: 'medium',
                  taskType: 'evaluation',
                  evaluationConfig: {
                    topic: currentTopicForDisplay,
                    questionCount: totalQuestions,
                    timeLimit: INITIAL_TIME_LIMIT / 60 // convertir a minutos
                  }
                };
                userTasks.push(basicTask);
                taskIndex = userTasks.length - 1;
                console.log('✅ Created basic task structure:', basicTask);
              }
            }
            
            if (taskIndex !== -1) {
              // Cambiar estado de pendiente a finalizada
              const oldStatus = userTasks[taskIndex].status;
              userTasks[taskIndex].status = 'completed';
              userTasks[taskIndex].completedAt = new Date().toISOString();
              userTasks[taskIndex].score = finalScore;
              userTasks[taskIndex].completionPercentage = percentage;
              
              localStorage.setItem(userTasksKey, JSON.stringify(userTasks));
              console.log(`✅ Task status updated from "${oldStatus}" to "completed" for student:`, user.username);
              console.log('📋 Updated user tasks:', userTasks);
              
              // TODO: Eliminar notificación de evaluación pendiente para este estudiante
              // TaskNotificationManager.removeEvaluationNotificationOnCompletion(taskId, user.username);
              console.log('🗑️ Task evaluation completed for student:', user.username);
              
              // Disparar evento para actualizar notificaciones en tiempo real
              window.dispatchEvent(new Event('taskNotificationsUpdated'));
              console.log('🔄 Dispatched taskNotificationsUpdated event');
              
              // Disparar evento personalizado para notificar a otras páginas
              window.dispatchEvent(new CustomEvent('evaluationCompleted', {
                detail: {
                  taskId: taskId,
                  studentUsername: user.username,
                  score: finalScore,
                  completionPercentage: percentage,
                  completedAt: new Date().toISOString()
                }
              }));
              console.log('🚀 Dispatched evaluationCompleted event');
            } else {
              console.error('❌ Could not create or find task even after attempting to create it');
            }

            // También actualizar el historial de evaluaciones del estudiante
            const evaluationHistoryKey = `evaluationHistory_${user.username}`;
            const evaluationHistory = JSON.parse(localStorage.getItem(evaluationHistoryKey) || '[]');
            
            const historyEntry = {
              id: result.submissionId,
              evaluationTitle: evaluationTitle,
              course: selectedCourse,
              subject: selectedBook,
              topic: currentTopicForDisplay,
              score: finalScore,
              totalQuestions: totalQuestions,
              completionPercentage: percentage,
              timeSpent: timeSpent,
              completedAt: new Date().toISOString(),
              taskId: taskId
            };
            
            evaluationHistory.push(historyEntry);
            localStorage.setItem(evaluationHistoryKey, JSON.stringify(evaluationHistory));
            console.log('✅ Updated evaluation history for student:', user.username);
          }

          console.log('✅ Evaluation submitted successfully via server action');
          
          toast({
            title: translate('evalCompletedTitle'),
            description: result.message,
            variant: 'default'
          });              // NUEVO: Sincronizar resultados con la tarea global del profesor
              syncEvaluationResultsToGlobalTask(taskId, user.username, {
                score: finalScore,
                totalQuestions: totalQuestions,
                completionPercentage: percentage,
                completedAt: new Date().toISOString(),
                attempt: 1 // Intento 1 por defecto
              });

              // NUEVO: Crear notificación para el profesor cuando un estudiante completa la evaluación
              try {
                // Obtener información de la tarea global para encontrar al profesor
                const globalTasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
                const currentTask = globalTasks.find((task: any) => task.id === taskId);
                
                if (currentTask) {
                  console.log('🔔 Creating evaluation completion notification for evaluation:', currentTask.title);
                  console.log('🔍 [DEBUG] Current task data:', currentTask);
                  
                  // 🔥 CORRECCIÓN: Lógica mejorada para determinar el profesor
                  let teacherUsername = 'teacher'; // fallback por defecto
                  
                  // Método 1: Usar assignedBy si es válido
                  if (currentTask.assignedBy && 
                      currentTask.assignedBy !== 'system' && 
                      currentTask.assignedBy !== 'evaluacion') {
                    teacherUsername = currentTask.assignedBy;
                    console.log('🎯 [DEBUG] Using assignedBy as teacher:', teacherUsername);
                  } else {
                    // Método 2: Buscar profesor logueado actualmente
                    const currentUser = JSON.parse(localStorage.getItem('smart-student-user') || '{}');
                    if (currentUser.role === 'teacher' && currentUser.username) {
                      teacherUsername = currentUser.username;
                      console.log('🎯 [DEBUG] Using current logged teacher:', teacherUsername);
                    } else {
                      // Método 3: Buscar primer profesor en usuarios
                      const usersObj = JSON.parse(localStorage.getItem('smart-student-users') || '{}');
                      const teachers = Object.entries(usersObj).filter(([_, userData]: [string, any]) => 
                        userData.role === 'teacher'
                      );
                      if (teachers.length > 0) {
                        teacherUsername = teachers[0][0]; // Usar username del primer profesor
                        console.log('🎯 [DEBUG] Using first available teacher:', teacherUsername);
                      } else {
                        console.log('⚠️ [DEBUG] No teachers found, using fallback:', teacherUsername);
                      }
                    }
                  }
                  
                  console.log('✅ [DEBUG] Final teacherUsername determined:', teacherUsername);
                  
                  // 🔥 MEJORA: Obtener displayName mejorado del estudiante
                  let studentDisplayName = user.username; // fallback
                  const u: any = user as any; // algunas propiedades no están en el tipo base
                  if (u.displayName) {
                    studentDisplayName = u.displayName;
                  } else if (u.firstName && u.lastName) {
                    studentDisplayName = `${u.firstName} ${u.lastName}`;
                  } else if (u.firstName) {
                    studentDisplayName = u.firstName;
                  }
                  console.log('✅ [DEBUG] Student display name:', studentDisplayName);
                  
                  TaskNotificationManager.createEvaluationCompletedNotification(
                    taskId,
                    currentTask.title || evaluationTitle,
                    selectedCourse,
                    selectedBook,
                    user.username,
                    studentDisplayName, // 🔥 MEJORADO: usar displayName mejorado
                    teacherUsername, // teacherUsername
                    {
                      score: finalScore,
                      totalQuestions: totalQuestions,
                      completionPercentage: percentage,
                      completedAt: new Date().toISOString()
                    }
                  );

                  // Disparar evento para actualizar notificaciones del profesor en tiempo real
                  window.dispatchEvent(new Event('taskNotificationsUpdated'));
                  console.log('✅ Evaluation completion notification created for teacher');
                  
                  // 📧 ENVIAR EMAIL AL ESTUDIANTE Y APODERADO cuando el estudiante termina la evaluación
                  try {
                    const currentYear = new Date().getFullYear();
                    const studentId = (user as any).id || user.username;
                    
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
                      console.log(`📧 [EVALUACIÓN] Apoderados por guardians-year: ${guardianIds.length}`);
                    }
                    
                    // Método 2: Buscar en smart-student-guardian-students (relaciones)
                    if (guardianIds.length === 0) {
                      const guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-students') || '[]');
                      if (guardianRelations.length > 0) {
                        const guardianIdsFromRelations = guardianRelations
                          .filter((r: any) => r.studentId === studentId)
                          .map((r: any) => r.guardianId);
                        guardianIds = [...new Set(guardianIdsFromRelations)] as string[];
                        console.log(`📧 [EVALUACIÓN] Apoderados por relaciones: ${guardianIds.length}`);
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
                            (u.assignedStudents?.includes(studentId) || 
                             u.assignedStudents?.includes(user.username) ||
                             u.studentIds?.includes(studentId) ||
                             u.studentIds?.includes(user.username) ||
                             u.children?.includes(studentId))
                          )
                          .map((u: any) => u.id);
                        console.log(`📧 [EVALUACIÓN] Apoderados por users: ${guardianIds.length}`);
                      }
                    }
                    
                    // Agregar apoderados a los destinatarios
                    recipientIds.push(...guardianIds);
                    
                    console.log(`📧 [EVALUACIÓN] Enviando email a ${recipientIds.length} destinatario(s) (1 estudiante + ${guardianIds.length} apoderados)`);
                    
                    // Obtener nombre legible del curso CON SECCIÓN
                    const courseDisplayName = getCourseDisplayName(selectedCourse);
                    
                    // Generar mensaje motivador basado en el porcentaje
                    const pct = Math.round(percentage);
                    let motivationalMessage = '';
                    if (pct >= 90) {
                      motivationalMessage = '🌟 ¡Excelente trabajo! Has demostrado un dominio sobresaliente del tema. ¡Sigue así!';
                    } else if (pct >= 80) {
                      motivationalMessage = '🎯 ¡Muy bien! Has logrado un gran resultado. Estás muy cerca de la excelencia.';
                    } else if (pct >= 70) {
                      motivationalMessage = '👍 ¡Buen trabajo! Has aprobado con un buen resultado. Con un poco más de práctica llegarás aún más lejos.';
                    } else if (pct >= 60) {
                      motivationalMessage = '✅ ¡Lo lograste! Has aprobado la evaluación. Sigue esforzándote para mejorar.';
                    } else if (pct >= 50) {
                      motivationalMessage = '💪 Estás cerca de aprobar. Repasa los temas y no te rindas, ¡tú puedes!';
                    } else if (pct >= 30) {
                      motivationalMessage = '📚 Necesitas repasar algunos temas. No te desanimes, cada intento es una oportunidad de aprender.';
                    } else {
                      motivationalMessage = '🌱 Este es solo el comienzo. Revisa el material y vuelve a intentarlo. ¡El esfuerzo siempre da frutos!';
                    }
                    
                    sendEmailOnNotification(
                      'evaluation_completed',
                      recipientIds,
                      {
                        title: `${studentDisplayName} ha completado una evaluación`,
                        content: `${studentDisplayName} ha completado la evaluación "${currentTask.title || evaluationTitle}" con un resultado de ${finalScore}/${totalQuestions} (${pct}%)`,
                          taskTitle: currentTask.title || evaluationTitle,
                          senderName: 'Smart Student',
                          courseName: courseDisplayName,
                          grade: pct, // CORREGIDO: Enviar porcentaje, no respuestas correctas
                          feedback: motivationalMessage // CORREGIDO: Mensaje motivador
                        }
                      ).then(() => {
                        console.log(`📧 [EVALUACIÓN] Email enviado exitosamente a ${recipientIds.length} destinatarios`);
                      }).catch((emailError) => {
                        console.warn('⚠️ [EVALUACIÓN] Error enviando email:', emailError);
                      });
                  } catch (emailError) {
                    console.warn('⚠️ [EVALUACIÓN] Error en envío de email:', emailError);
                  }
                } else {
                  console.log('ℹ️ No task found, skipping teacher notification');
                }
              } catch (error) {
                console.error('❌ Error creating evaluation completion notification:', error);
              }

        } catch (error) {
          console.error('❌ Error submitting evaluation:', error);
          toast({
            title: translate('evalCompletedErrorTitle'),
            description: translate('evalCompletedErrorDesc'),
            variant: 'destructive'
          });
        } finally {
          setIsSubmittingEvaluation(false);
        }
      } else {
        console.log('ℹ️ Not a task evaluation or no user, skipping server action submission');
      }
    }
    
    setTimerActive(false); 
    setEvaluationFinished(true);
    setShowResultDialog(true);
    if (totalQuestions > 0) { 
        saveEvaluationToHistory(finalScore, totalQuestions);
    }
  }, [calculateScore, evaluationQuestions.length, saveEvaluationToHistory, searchParams, isTaskEvaluationSession, isAutoStartMode, startTime, user, userAnswers, evaluationTitle, selectedCourse, selectedBook, currentTopicForDisplay, toast]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    if (evaluationStarted && !evaluationFinished && timerActive) {
      if (timeLeft > 0) {
        intervalId = setInterval(() => {
          setTimeLeft((prevTime) => prevTime - 1);
        }, 1000);
      } else { 
        setTimerActive(false); 
        // Mostrar popup de tiempo terminado
        setShowTimeUpDialog(true);
      }
    }
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [evaluationStarted, evaluationFinished, timerActive, timeLeft, handleFinishEvaluation, toast, translate]);

  // Efecto para manejar la cuenta regresiva de la transición
  useEffect(() => {
    let countdownInterval: NodeJS.Timeout | null = null;
    
    if (showReadyTransition) {
      setCountdown(3);
      countdownInterval = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            clearInterval(countdownInterval!);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    
    return () => {
      if (countdownInterval) {
        clearInterval(countdownInterval);
      }
    };
  }, [showReadyTransition]);

  useEffect(() => {
    if (evaluationQuestions.length > 0) {
      setUserAnswers(Array(evaluationQuestions.length).fill(null));
    }
  }, [evaluationQuestions]);

  const handleCreateEvaluation = useCallback(async () => {
    console.log('🚀 handleCreateEvaluation called - Initial state:', {
      selectedCourse,
      selectedBook,
      selectedSubject,
      topic,
      searchParams: Object.fromEntries(searchParams.entries())
    });
    
    // Siempre priorizar parámetros de URL si están disponibles, para evitar problemas de estado
    const courseFromQuery = searchParams.get('course');
    const bookFromQuery = searchParams.get('book');
    const topicFromQuery = searchParams.get('topic');
    const autoStartFromQuery = searchParams.get('autoStart');
    const questionCountFromQuery = searchParams.get('questionCount');
    const timeLimitFromQuery = searchParams.get('timeLimit');
    
    let courseToUse = courseFromQuery ? decodeURIComponent(courseFromQuery) : selectedCourse;
    let bookToUse = bookFromQuery ? decodeURIComponent(bookFromQuery) : (selectedSubject || selectedBook);
    let topicToUse = topicFromQuery ? decodeURIComponent(topicFromQuery) : topic;
    let questionCountToUse = questionCountFromQuery ? parseInt(questionCountFromQuery) : selectedQuestionCount;
    // Calcular tiempo límite: si viene de URL (en minutos), convertir a segundos; sino, calcular dinámicamente
    let timeLimitToUse = timeLimitFromQuery 
      ? parseInt(timeLimitFromQuery) * 60 
      : calculateTimeLimit(questionCountToUse);
    
    console.log('📊 Evaluation Parameters:', {
      questionCount: questionCountToUse,
      timeLimit: timeLimitToUse,
      timeLimitMinutes: Math.round(timeLimitToUse / 60),
      fromURL: { questionCount: questionCountFromQuery, timeLimit: timeLimitFromQuery },
      isTaskEvaluation: autoStartFromQuery === 'true'
    });
    
    // Establecer localStorage si es una evaluación de tarea
    if (autoStartFromQuery === 'true' || isAutoStartMode) {
      localStorage.setItem('isTaskEvaluation', 'true');
      console.log('Setting isTaskEvaluation to true in localStorage');
    }
    
    console.log('handleCreateEvaluation - Parameters:', { 
      fromURL: { course: courseFromQuery, book: bookFromQuery, topic: topicFromQuery, autoStart: autoStartFromQuery },
      fromState: { selectedCourse, selectedBook, selectedSubject, topic },
      toUse: { courseToUse, bookToUse, topicToUse, questionCountToUse, timeLimitToUse },
      isAutoStartMode 
    });
    
    // Validación mejorada para libro/asignatura
    if (!bookToUse || bookToUse.trim() === '') {
      console.error('No book or subject selected. Current state:', { 
        selectedBook, 
        selectedSubject,
        bookFromQuery, 
        bookToUse, 
        isAutoStartMode,
        searchParams: Object.fromEntries(searchParams.entries())
      });
      toast({ 
        title: translate('errorGenerating'), 
        description: translate('noBookSelected') || 'Por favor selecciona un curso y una asignatura antes de crear la evaluación', 
        variant: 'destructive'
      });
      return;
    }
    
    // Validación mejorada para curso
    if (!courseToUse || courseToUse.trim() === '') {
      console.error('No course selected. Current state:', { 
        selectedCourse, 
        courseFromQuery, 
        courseToUse 
      });
      toast({ 
        title: translate('errorGenerating'), 
        description: 'Por favor selecciona un curso antes de crear la evaluación', 
        variant: 'destructive'
      });
      return;
    }
    const trimmedTopic = topicToUse.trim();
    if (!trimmedTopic) {
      toast({ title: translate('errorGenerating'), description: translate('noTopicProvided'), variant: 'destructive'});
      return;
    }

    // Start progress simulation but don't let it reach 100% automatically
    const progressInterval = startProgress('evaluation', 25000); // Much longer duration to prevent auto-completion
    setEvaluationStarted(false);
    setEvaluationFinished(false);
    setEvaluationQuestions([]);
    setCurrentQuestionIndex(0);
    setUserAnswers([]);
    setScore(0);
    setMotivationalMessageKey('');
    setCurrentTopicForDisplay(trimmedTopic);
    
    // Set the time limit from parameters
    setTimeLeft(timeLimitToUse);
    console.log('⏱️ Setting time limit to:', timeLimitToUse, 'seconds');

    try {
      // First, extract PDF content
      let pdfContent = '';
      try {
        const pdfResponse = await fetch('/api/extract-pdf-content', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            bookTitle: bookToUse, // preferido
            subject: selectedSubject || undefined,
            course: courseToUse || undefined,
            topic: trimmedTopic // AGREGAR EL TEMA ESPECÍFICO
          }),
        });
        
        if (pdfResponse.ok) {
          const pdfData = await pdfResponse.json();
          pdfContent = pdfData.pdfContent || '';
          // Si la API resolvió un título de libro exacto, úsalo para la generación
          if (pdfData.bookTitle && pdfData.bookTitle !== bookToUse) {
            console.log('🔁 Replacing bookToUse with resolved title from API:', pdfData.bookTitle);
            bookToUse = pdfData.bookTitle;
          }
        } else {
          console.warn('Failed to extract PDF content, using fallback generation');
        }
      } catch (pdfError) {
        console.warn('Error extracting PDF content:', pdfError);
      }

      // Generate dynamic evaluation using PDF content
      console.log('🌍 CREATE EVALUATION - Using React context language:', currentUiLanguage);
      
      const evaluationResponse = await fetch('/api/generate-dynamic-evaluation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookTitle: bookToUse, // Usar el valor correcto
          course: courseToUse,
          subject: selectedSubject || undefined,
          topic: trimmedTopic,
          language: currentUiLanguage, // USAR DIRECTAMENTE EL CONTEXTO DE REACT
          pdfContent: pdfContent,
          questionCount: questionCountToUse,
          timeLimit: timeLimitToUse
        }),
      });

      if (!evaluationResponse.ok) {
        throw new Error('Failed to generate dynamic evaluation');
      }

      const evaluationData = await evaluationResponse.json();
      const result = evaluationData.data;
      
      if (result && result.questions && result.questions.length === questionCountToUse) {
        setEvaluationTitle(result.evaluationTitle);
        setEvaluationQuestions(shuffleArray(result.questions));
        console.log('Setting timer to:', timeLimitToUse, 'seconds (', timeLimitToUse/60, 'minutes)');
        setTimeLeft(timeLimitToUse);
        
        console.log('✅ Evaluation created with custom parameters:', {
          questionCount: result.questions.length,
          timeLimit: timeLimitToUse,
          title: result.evaluationTitle
        });
        
        // Stop progress and set to 100% when evaluation is ready
        stopProgress(progressInterval);
        
        // Si estamos en modo autoStart, mostrar transición antes de iniciar
        if (isAutoStartMode) {
          setShowReadyTransition(true);
          setTimeout(() => {
            setShowReadyTransition(false);
            setTimerActive(true);
            setStartTime(new Date());
            setEvaluationStarted(true);
            setEvaluationFinished(false);
          }, 2000); // 2 segundos de transición
        } else {
          setTimerActive(true);
          setStartTime(new Date());
          setEvaluationStarted(true);
          setEvaluationFinished(false);
        }
        
        // Show success notification only for manual mode
        if (!isAutoStartMode) {
          toast({ 
            title: translate('evalGeneratedTitle'), 
            description: translate('evalGeneratedDesc'),
            variant: 'default'
          });
        }
      } else {
        console.warn(`Expected ${questionCountToUse} questions, got ${result?.questions?.length || 0}`);
        console.log('API response format unexpected, falling back to generateEvaluationContent');
        throw new Error('API format mismatch - using fallback');
      }
    } catch (error) {
      console.log("API generation failed, using fallback method:", error);
      
      // Fallback to original method if dynamic generation fails
      try {
        console.log("Using generateEvaluationAction as fallback...");
        console.log('🌍 Language from React context for fallback:', currentUiLanguage);
        
        // Obtener la descripción del tema si existe
        const topicDesc = selectedSubjectTopic && topicDescriptions[selectedSubjectTopic] 
          ? topicDescriptions[selectedSubjectTopic].description 
          : undefined;
        
        const result = await generateEvaluationAction({
          bookTitle: bookToUse, // Usar el valor correcto
          topic: trimmedTopic,
          topicDescription: topicDesc, // Pasar la descripción del tema para orientación
          language: currentUiLanguage as 'en' | 'es', // USAR DIRECTAMENTE EL CONTEXTO DE REACT
          questionCount: questionCountToUse,
          timeLimit: timeLimitToUse,
          course: courseToUse, // Pasar el curso para contenido apropiado a la edad
        });
        
        if (result && result.questions && result.questions.length === questionCountToUse) {
          setEvaluationTitle(result.evaluationTitle);
          setEvaluationQuestions(shuffleArray(result.questions));
          setTimeLeft(timeLimitToUse);
          
          // Stop progress and set to 100% when evaluation is ready
          stopProgress(progressInterval);
          
          // Si estamos en modo autoStart, mostrar transición antes de iniciar
          if (isAutoStartMode) {
            setShowReadyTransition(true);
            setTimeout(() => {
              setShowReadyTransition(false);
              setTimerActive(true);
              setStartTime(new Date());
              setEvaluationStarted(true);
              setEvaluationFinished(false);
            }, 2000); // 2 segundos de transición
          } else {
            setTimerActive(true);
            setStartTime(new Date());
            setEvaluationStarted(true);
            setEvaluationFinished(false);
          }
          
          console.log('✅ Evaluation created successfully with custom parameters via fallback:', {
            questionCount: result.questions.length,
            timeLimit: timeLimitToUse,
            title: result.evaluationTitle
          });
          
          // Show success notification only for manual mode
          if (!isAutoStartMode) {
            toast({ 
              title: translate('evalGeneratedTitle'), 
              description: translate('evalGeneratedDesc'),
              variant: 'default'
            });
          }
        } else {
          console.warn(`Expected ${questionCountToUse} questions, got ${result?.questions?.length || 0}`);
          throw new Error('Fallback generation also failed to produce correct question count');
        }
      } catch (fallbackError) {
        console.error("Fallback generation failed:", fallbackError);
        toast({ 
          title: translate('errorGenerating'), 
          description: translate('evalErrorGenerationFormat', {defaultValue: "No se pudo generar la evaluación con el número de preguntas solicitado"}), 
          variant: 'destructive'
        });
        setEvaluationStarted(false);
        // Stop progress on error
        stopProgress(progressInterval);
      }
    }
  }, [selectedBook, selectedCourse, topic, currentUiLanguage, toast, translate, startProgress, stopProgress, isAutoStartMode, searchParams]);

  const handleAnswerSelect = (answer: UserAnswer) => {
    const newAnswers = [...userAnswers];
    newAnswers[currentQuestionIndex] = answer;
    setUserAnswers(newAnswers);
  };

  const handleMultipleSelectionToggle = (optionIndex: number) => {
    const newAnswers = [...userAnswers];
    const currentAnswer = newAnswers[currentQuestionIndex];
    
    if (Array.isArray(currentAnswer)) {
      // If the option is already selected, remove it
      if (currentAnswer.includes(optionIndex)) {
        newAnswers[currentQuestionIndex] = currentAnswer.filter(idx => idx !== optionIndex);
      } else {
        // Add the option to the selection
        newAnswers[currentQuestionIndex] = [...currentAnswer, optionIndex];
      }
    } else {
      // Initialize as an array with the first selection
      newAnswers[currentQuestionIndex] = [optionIndex];
    }
    
    setUserAnswers(newAnswers);
  };

  const handleNextQuestion = () => {
    if (currentQuestionIndex < evaluationQuestions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    }
  };

  const handlePreviousQuestion = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
    }
  };

  const handleRepeatEvaluation = async () => {
    if (!selectedBook && !selectedSubject) {
      toast({ 
        title: translate('errorGenerating'), 
        description: translate('noBookSelected'), 
        variant: 'destructive'
      });
      return;
    }

    // Obtener parámetros originales de la evaluación
    const questionCountFromQuery = searchParams.get('questionCount');
    const timeLimitFromQuery = searchParams.get('timeLimit');
    let questionCountToUse = questionCountFromQuery ? parseInt(questionCountFromQuery) : selectedQuestionCount;
    // Convertir minutos a segundos para timeLimitToUse
    let timeLimitToUse = timeLimitFromQuery ? parseInt(timeLimitFromQuery) * 60 : 120;
    
    console.log('🔄 Repeating evaluation with original parameters:', {
      questionCount: questionCountToUse,
      timeLimit: timeLimitToUse,
      timeLimitMinutes: timeLimitFromQuery ? parseInt(timeLimitFromQuery) : 2
    });

    // Start progress simulation but don't let it reach 100% automatically
    const progressInterval = startProgress('evaluation', 25000); // Much longer duration to prevent auto-completion
    
    // Reset state
    setCurrentQuestionIndex(0);
    setUserAnswers([]);
    setEvaluationFinished(false); 
    setShowResultDialog(false);
    setScore(0);
    setMotivationalMessageKey('');
    setEvaluationQuestions([]);
    setTimerActive(false);
    setTimeLeft(timeLimitToUse);

    try {
      // First, extract PDF content
      let pdfContent = '';
      try {
        const bookForPdf = selectedBook || selectedSubject;
        const pdfResponse = await fetch('/api/extract-pdf-content', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            bookTitle: bookForPdf,
            course: selectedCourse || undefined,
            subject: selectedSubject || undefined,
            topic: currentTopicForDisplay // AGREGAR EL TEMA ESPECÍFICO
          }),
        });
        
        if (pdfResponse.ok) {
          const pdfData = await pdfResponse.json();
          pdfContent = pdfData.pdfContent || '';
        } else {
          console.warn('Failed to extract PDF content for repeat evaluation, using fallback generation');
        }
      } catch (pdfError) {
        console.warn('Error extracting PDF content for repeat evaluation:', pdfError);
      }

      // Generate NEW dynamic evaluation using PDF content
      console.log('🌍 REPEAT EVALUATION - Using React context language:', currentUiLanguage);
      
      const bookForEvaluation = selectedBook || selectedSubject;
      
      const evaluationResponse = await fetch('/api/generate-dynamic-evaluation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookTitle: bookForEvaluation,
          course: selectedCourse || undefined,
          subject: selectedSubject || undefined,
          topic: currentTopicForDisplay,
          language: currentUiLanguage, // USAR DIRECTAMENTE EL CONTEXTO DE REACT
          pdfContent: pdfContent,
          questionCount: questionCountToUse,
          timeLimit: timeLimitToUse
        }),
      });

      if (!evaluationResponse.ok) {
        throw new Error('Failed to generate new dynamic evaluation');
      }

      const evaluationData = await evaluationResponse.json();
      const result = evaluationData.data;
      
      if (result && result.questions && result.questions.length === questionCountToUse) {
        setEvaluationTitle(result.evaluationTitle);
        setEvaluationQuestions(shuffleArray(result.questions));
        setUserAnswers(Array(result.questions.length).fill(null));
        setTimeLeft(timeLimitToUse);
        setTimerActive(true);
        setStartTime(new Date());
        setEvaluationStarted(true);
        
        // Stop progress when evaluation is ready
        stopProgress(progressInterval);
        
        console.log('✅ Repeat evaluation created with custom parameters:', {
          questionCount: result.questions.length,
          timeLimit: timeLimitToUse
        });
        
        // Show success notification for new evaluation
        toast({ 
          title: translate('evalGeneratedTitle'), 
          description: translate('evalNewEvaluationGenerated', {defaultValue: 'Nueva evaluación generada con preguntas diferentes'}),
          variant: 'default'
        });
      } else {
        throw new Error('Failed to generate new evaluation with proper format');
      }
    } catch (error) {
      console.error("Error generating new evaluation for repeat:", error);
      
      // Fallback to original method if dynamic generation fails
      try {
        console.log("🔄 ATTEMPTING FALLBACK GENERATION FOR REPEAT...");
        console.log('🌍 Language from React context for repeat fallback:', currentUiLanguage);
        
        const bookForFallback = selectedBook || selectedSubject;
        
        // Obtener la descripción del tema si existe
        const topicDesc = selectedSubjectTopic && topicDescriptions[selectedSubjectTopic] 
          ? topicDescriptions[selectedSubjectTopic].description 
          : undefined;
        
        const result = await generateEvaluationAction({
          bookTitle: bookForFallback,
          topic: currentTopicForDisplay,
          topicDescription: topicDesc, // Pasar la descripción del tema para orientación
          language: currentUiLanguage as 'en' | 'es', // USAR DIRECTAMENTE EL CONTEXTO DE REACT
          questionCount: questionCountToUse,
          timeLimit: timeLimitToUse,
          course: selectedCourse, // Pasar el curso para contenido apropiado a la edad
        });
        
        if (result && result.questions && result.questions.length === questionCountToUse) {
          setEvaluationTitle(result.evaluationTitle);
          setEvaluationQuestions(shuffleArray(result.questions));
          setUserAnswers(Array(result.questions.length).fill(null));
          setTimeLeft(timeLimitToUse);
          setTimerActive(true);
          setStartTime(new Date());
          setEvaluationStarted(true);
          
          // Stop progress when evaluation is ready
          stopProgress(progressInterval);
          
          toast({ 
            title: translate('evalGeneratedTitle'), 
            description: translate('evalNewEvaluationGenerated', {defaultValue: 'Nueva evaluación generada'}),
            variant: 'default'
          });
        } else {
          throw new Error('Fallback generation also failed for repeat');
        }
      } catch (fallbackError) {
        console.error("Fallback generation failed for repeat:", fallbackError);
        // If all fails, just reset to the original questions but shuffle them
        setCurrentQuestionIndex(0);
        setUserAnswers(Array(evaluationQuestions.length).fill(null));
        setEvaluationFinished(false); 
        setShowResultDialog(false);
        setScore(0);
        setMotivationalMessageKey('');
        setTimeLeft(timeLimitToUse);
        setTimerActive(true);
        setStartTime(new Date());
        setEvaluationStarted(true);
        
        // Stop progress when fallback is ready
        stopProgress(progressInterval);
        
        toast({ 
          title: translate('evalGeneratedTitle'), 
          description: translate('evalFallbackRepeat', {defaultValue: 'Evaluación reiniciada con preguntas reordenadas'}),
          variant: 'default'
        });
      }
    }
  };

  const handleStartNewEvaluation = () => {
    setEvaluationStarted(false);
    setEvaluationFinished(false);
    setEvaluationQuestions([]);
    setCurrentQuestionIndex(0);
    setUserAnswers([]);
    setScore(0);
    setMotivationalMessageKey('');
    setTopic('');
    setSelectedCourse(''); 
    setSelectedBook(''); 
    setSelectedQuestionCount(15);
    setInitialBookFromQuery(undefined);
    setCurrentTopicForDisplay('');
    setShowResultDialog(false); 
    setTimeLeft(INITIAL_TIME_LIMIT);
    setTimerActive(false);
  };

  const handleCloseDialogAndShowReview = () => {
    setShowResultDialog(false);
    
    // MEJORADO: Preservar estado de evaluación de tarea cuando se cierra el diálogo
    const autoStart = searchParams.get('autoStart') === 'true';
    const taskId = searchParams.get('taskId');
    const isCurrentlyTaskEvaluation = isTaskEvaluationSession || isAutoStartMode;
    
    if (autoStart || taskId || isCurrentlyTaskEvaluation) {
      console.log('💾 Preserving task evaluation state when closing results dialog');
      localStorage.setItem('isTaskEvaluation', 'true');
      sessionStorage.setItem('isTaskEvaluation', 'true');
      localStorage.setItem('evaluationFinished', 'true');
      setIsTaskEvaluationSession(true);
      setIsAutoStartMode(true);
    }
  };

  const handleTimeUpDialogClose = () => {
    setShowTimeUpDialog(false);
    handleFinishEvaluation();
  };

  const handleCloseTaskEvaluation = useCallback(() => {
    console.log('🔄 Closing task evaluation...');
    
    // Resetear TODOS los estados relacionados con la evaluación
    setShowResultDialog(false);
    setIsTaskEvaluationSession(false);
    setIsAutoStartMode(false);
    setEvaluationStarted(false);
    setEvaluationFinished(false);
    setEvaluationQuestions([]);
    setCurrentQuestionIndex(0);
    setUserAnswers([]);
    setScore(0);
    setMotivationalMessageKey('');
    
    // NUEVO: Limpiar campos del formulario para que aparezcan en blanco
    setSelectedCourse('');
    setSelectedBook('');
    setTopic('');
    setSelectedQuestionCount(15);
    setCurrentTopicForDisplay('');
    setInitialBookFromQuery(undefined);
    
    // NUEVO: Evitar que aparezca pantalla de "Preparando evaluación"
    setShowReadyTransition(false);
    
    // NUEVO: Resetear timer
    setTimeLeft(INITIAL_TIME_LIMIT);
    setTimerActive(false);
    
    // Limpiar todos los métodos de persistencia - MEJORADO
    localStorage.removeItem('isTaskEvaluation');
    sessionStorage.removeItem('isTaskEvaluation');
    localStorage.removeItem('evaluationFinished'); // NUEVO: Limpiar estado finalizado
    console.log('🧹 Cleared task evaluation state from all storages');
    
    // Redirigir a la página de tareas en lugar de evaluación
    router.push('/dashboard/tareas');
  }, [router]);

  // Función para sincronizar resultados de evaluación con la tarea global (para que el profesor pueda verlos)
  const syncEvaluationResultsToGlobalTask = (
    taskId: string, 
    studentUsername: string, 
    results: {
      score: number;
      totalQuestions: number;
      completionPercentage: number;
      completedAt: string;
      attempt: number;
    }
  ) => {
    try {
      // Obtener tareas globales
      const globalTasks = JSON.parse(localStorage.getItem('smart-student-tasks') || '[]');
      const taskIndex = globalTasks.findIndex((task: any) => task.id === taskId);
      
      if (taskIndex !== -1) {
        // Inicializar evaluationResults si no existe
        if (!globalTasks[taskIndex].evaluationResults) {
          globalTasks[taskIndex].evaluationResults = {};
        }
        
        // Guardar resultados del estudiante
        globalTasks[taskIndex].evaluationResults[studentUsername] = results;
        
        // Guardar de vuelta en localStorage
        localStorage.setItem('smart-student-tasks', JSON.stringify(globalTasks));
        // Notificar a otros listeners en la misma pestaña (Calificaciones sincroniza desde aquí)
        try {
          window.dispatchEvent(new StorageEvent('storage', {
            key: 'smart-student-tasks',
            newValue: JSON.stringify(globalTasks)
          }));
        } catch {}
        try {
          window.dispatchEvent(new CustomEvent('evaluationCompleted', { detail: { taskId } }));
        } catch {}
        
        console.log(`[SyncResults] ✅ Saved results for ${studentUsername} in task ${taskId}:`, results);
        console.log(`[SyncResults] 📊 Score: ${results.score}/${results.totalQuestions} (${results.completionPercentage.toFixed(1)}%)`);
      } else {
        console.warn(`[SyncResults] ⚠️ Task ${taskId} not found in global tasks`);
      }
    } catch (error) {
      console.error('[SyncResults] ❌ Error syncing evaluation results:', error);
    }
  };

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  };

  const currentQuestion = evaluationQuestions[currentQuestionIndex];

  // Pantalla de transición "¡Evaluación Lista!"
  if (showReadyTransition) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-green-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
        <Card className="w-full max-w-lg shadow-xl border-0">
          <CardHeader className="items-center pb-6 text-center">
            <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
              <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <CardTitle className="text-3xl font-bold font-headline text-green-600 mb-2">
              {translate('evalReadyTitle')}
            </CardTitle>
            <CardDescription className="text-lg text-muted-foreground">
              {translate('evalReadyDesc', { topic })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 text-center">
            <div className="bg-gradient-to-r from-green-50 to-green-100 dark:from-green-900/30 dark:to-green-800/30 p-5 rounded-xl border border-green-200 dark:border-green-700">
              <h4 className="font-bold text-green-700 dark:text-green-300 mb-3">
                {translate('evalReadyIncludes')}
              </h4>
              <div className="space-y-2 text-sm text-green-600 dark:text-green-400">
                <div>{translate('evalReadyQuestions', { topic })}</div>
                <div>{translate('evalReadyTimeLimit')}</div>
                <div>{translate('evalReadyQuestionTypes')}</div>
                <div>{translate('evalReadyScoring')}</div>
              </div>
            </div>
            
            <div className="text-center">
              <div className="text-lg font-semibold text-green-600 mb-2">
                {translate('evalReadyStarting')}
              </div>
              <div className="text-6xl font-bold text-green-500 animate-pulse">
                {countdown}
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                {translate('evalReadyPrepare')}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Si estamos en modo autoStart y aún no ha comenzado la evaluación, mostrar pantalla de carga
  // PERO SOLO si realmente tenemos parámetros de tarea en la URL
  if (!evaluationStarted && isAutoStartMode && 
      (searchParams.get('autoStart') === 'true' || searchParams.get('taskId'))) {
    // Obtener parámetros dinámicos para la pantalla de carga
    const courseFromQuery = searchParams.get('course');
    const bookFromQuery = searchParams.get('book');
    const topicFromQuery = searchParams.get('topic');
    const questionCountFromQuery = searchParams.get('questionCount');
    const timeLimitFromQuery = searchParams.get('timeLimit');
    
    const displayCourse = courseFromQuery ? decodeURIComponent(courseFromQuery) : selectedCourse;
    const displayBook = bookFromQuery ? decodeURIComponent(bookFromQuery) : selectedBook;
    const displayTopic = topicFromQuery ? decodeURIComponent(topicFromQuery) : topic;
  const displayQuestionCount = questionCountFromQuery ? parseInt(questionCountFromQuery) : 15;
  // timeLimitFromQuery viene en minutos; si no viene, mostrar 2 min por defecto
  const displayTimeLimit = timeLimitFromQuery ? parseInt(timeLimitFromQuery) : 2;
    
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
        <Card className="w-full max-w-lg shadow-xl border-0">
          <CardHeader className="items-center pb-6 text-center">
            <div className="relative mb-6">
              <div className="w-24 h-24 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin"></div>
              {aiIsLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xl font-bold text-purple-600">{progress}%</span>
                </div>
              )}
            </div>
            <CardTitle className="text-3xl font-bold font-headline text-purple-600 mb-2">
              {translate('evalPreparingTitle')}
            </CardTitle>
            
            {/* Estado dinámico del progreso */}
            {aiIsLoading && (
              <div className="mb-4">
                <div className="text-lg font-medium text-purple-700 dark:text-purple-300 animate-pulse">
                  {progressText || 'Generando preguntas personalizadas...'}
                </div>
              </div>
            )}
            
            <CardDescription className="text-base text-muted-foreground max-w-2xl">
              {translate('evalPreparingDesc', { topic: displayTopic })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-gradient-to-r from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/30 p-5 rounded-xl border border-purple-200 dark:border-purple-700">
              <h4 className="font-bold text-purple-700 dark:text-purple-300 mb-3 flex items-center">
                {translate('evalPreparingDetails')}
              </h4>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="text-purple-600 dark:text-purple-400">
                  <strong>{translate('evalPreparingCourse')}</strong> {displayCourse}
                </div>
                <div className="text-purple-600 dark:text-purple-400">
                  <strong>{translate('evalPreparingSubject')}</strong> {displayBook}
                </div>
                <div className="text-purple-600 dark:text-purple-400">
                  <strong>{translate('evalPreparingTopic')}</strong> {displayTopic}
                </div>
                <div className="text-purple-600 dark:text-purple-400">
                  <strong>{translate('evalPreparingQuestions')}</strong> {displayQuestionCount}
                </div>
                <div className="text-purple-600 dark:text-purple-400 col-span-2">
                  <strong>{translate('evalPreparingTime')}</strong> {displayTimeLimit} {translate('minutes')}
                </div>
              </div>
            </div>
            
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-2">
                {translate('evalPreparingAutoGenerate')}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate('evalPreparingWait')}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!evaluationStarted) {
    return (
      <div className="flex flex-col items-center text-center">
        <Card className="w-full max-w-lg shadow-lg">
          <CardHeader className="items-center">
            <ClipboardList className="w-10 h-10 text-purple-500 dark:text-purple-400 mb-3" />
            <CardTitle className="text-3xl font-bold font-headline">{translate('evalPageTitle')}</CardTitle>
            <CardDescription className="mt-2 text-muted-foreground max-w-2xl">
              {translate('evalPageSub')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <BookCourseSelector
              selectedCourse={selectedCourse}
              selectedBook={selectedBook}
              selectedSubject={selectedSubject}
              showSubjectSelector={true}
              showBookSelector={false}
              accentColor="purple"
              onCourseChange={setSelectedCourse}
              onBookChange={setSelectedBook}
              onSubjectChange={setSelectedSubject}
              initialBookNameToSelect={initialBookFromQuery}
            />

            {/* Sección automática de temas desde el libro de la asignatura seleccionada */}
            {selectedCourse && selectedSubject && (
              <div className="space-y-3 p-4 border border-purple-500/30 rounded-lg bg-purple-500/5">
                <div className="space-y-1">
                  <Label className="text-left block font-semibold text-purple-600 dark:text-purple-400">
                    <BookOpen className="w-4 h-4 inline mr-2" />
                    {subjectIcon} {translate('evalSubjectTopicsTitle') || 'Temas de la Asignatura'}
                  </Label>
                  {subjectBookTitle && (
                    <p className="text-left text-xs text-muted-foreground">
                      📚 {subjectBookTitle}
                    </p>
                  )}
                </div>

                {isAnalyzingSubject ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {translate('evalAnalyzingSubject') || 'Analizando temas de la asignatura con IA...'}
                  </div>
                ) : subjectTopics.length > 0 ? (
                  <div className="space-y-2">
                    <Label className="text-left block text-sm">
                      {translate('evalSelectTopic') || 'Selecciona un tema para la evaluación:'}
                    </Label>
                    <Select value={selectedSubjectTopic} onValueChange={handleSubjectTopicSelect}>
                      <SelectTrigger>
                        <SelectValue placeholder={translate('evalChooseTopic') || 'Elige un tema…'} />
                      </SelectTrigger>
                      <SelectContent className="select-accent-purple">
                        {subjectTopics.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    {/* Mostrar descripción del tema seleccionado */}
                    {selectedSubjectTopic && topicDescriptions[selectedSubjectTopic] && (
                      <div className="mt-3 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-purple-500">📖</span>
                          <h4 className="font-semibold text-purple-700 dark:text-purple-300 text-sm">
                            {translate('topicDescriptionLabel') || 'Descripción:'}
                          </h4>
                        </div>
                        <p className="text-xs text-purple-600 dark:text-purple-400">
                          {topicDescriptions[selectedSubjectTopic].description}
                        </p>
                      </div>
                    )}
                    
                    <p className="text-left text-xs text-muted-foreground">
                      💡 {translate('evalTopicHint') || 'La evaluación incluirá preguntas variadas sobre el tema seleccionado.'}
                    </p>
                  </div>
                ) : (
                  <p className="text-left text-xs text-muted-foreground">
                    {translate('evalNoTopics') || 'No se encontraron temas. Puedes escribir el tema manualmente.'}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="question-count-select" className="text-left block">
                {translate('questionCountLabel')}
              </Label>
              <Select
                value={selectedQuestionCount.toString()}
                onValueChange={(value) => setSelectedQuestionCount(parseInt(value))}
                disabled={!selectedSubject}
              >
                <SelectTrigger id="question-count-select" className="text-base md:text-sm">
                  <SelectValue placeholder={translate('evalQuestionCountPlaceholder', { defaultValue: 'Selecciona la cantidad de preguntas' })} />
                </SelectTrigger>
                <SelectContent className="select-accent-purple">
                  <SelectItem value="5">5 preguntas</SelectItem>
                  <SelectItem value="10">10 preguntas</SelectItem>
                  <SelectItem value="15">15 preguntas</SelectItem>
                  <SelectItem value="20">20 preguntas</SelectItem>
                  <SelectItem value="25">25 preguntas</SelectItem>
                  <SelectItem value="30">30 preguntas</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="eval-topic-input" className="text-left block">{translate('evalTopicPlaceholder')}</Label>
              <Textarea
                id="eval-topic-input"
                rows={2}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={translate('evalTopicPlaceholder')}
                className="text-base md:text-sm"
                disabled={!selectedSubject}
              />
            </div>
            <Button
              onClick={handleCreateEvaluation}
              disabled={aiIsLoading || !selectedSubject || !topic.trim()}
              className={cn(
                "w-full font-semibold py-3 text-base md:text-sm home-card-button-purple"
              )}
            >
              {aiIsLoading ? (
                <>{translate('loading')} {progress}%</>
              ) : (
                <>
                  <PlayCircle className="w-5 h-5 mr-2" />
                  {translate('evalCreateBtn')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (aiIsLoading) {
     return (
        <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
            <Card className="w-full max-w-md p-8 text-center shadow-xl">
                <div className="animate-pulse flex flex-col items-center space-y-4">
                    <ClipboardList className="w-16 h-16 text-muted-foreground/50" />
                    <p className="text-xl font-semibold text-muted-foreground">
                        {translate('evalGeneratingTitle', { defaultValue: "Generating Evaluation..." })}
                    </p>
                    <div className="w-3/4 h-4 bg-muted-foreground/20 rounded"></div>
                    <div className="w-1/2 h-4 bg-muted-foreground/20 rounded"></div>
                </div>
            </Card>
        </div>
    );
  }

  if (evaluationFinished && !showResultDialog) {
    return (
      <Card className="w-full max-w-2xl mx-auto shadow-xl">
        <CardHeader className="text-center border-b pb-4">
          <CardTitle className="text-2xl font-bold font-headline">{evaluationTitle}</CardTitle>
          <CardDescription>
            {translate('evalReviewYourAnswers', { defaultValue: "Review your answers. Final Score:" })} {score} / {evaluationQuestions.length}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 space-y-6">
          {evaluationQuestions.map((q, idx) => (
            <div key={q.id} className="p-4 border rounded-lg bg-card shadow">
              <p className="font-semibold mb-3 text-lg">
                {translate('evalQuestionLabel', { current: String(idx + 1), total: String(evaluationQuestions.length), defaultValue:"Question {{current}}/{{total}}" })}: {q.questionText}
              </p>
              {q.type === 'TRUE_FALSE' && (
                <div className="space-y-2 text-sm">
                  <p>{translate('evalYourAnswer', {defaultValue:"Your answer"})}: <span className={cn("font-medium", userAnswers[idx] === q.correctAnswer ? "text-green-600 dark:text-green-400" : "text-destructive")}>{userAnswers[idx] === null ? translate('evalNoAnswer', {defaultValue:"Not answered"}) : (userAnswers[idx] ? translate('evalTrue') : translate('evalFalse'))}</span></p>
                  <p>{translate('evalCorrectAnswer', {defaultValue:"Correct answer"})}: <span className="font-medium text-green-600 dark:text-green-400">{q.correctAnswer ? translate('evalTrue') : translate('evalFalse')}</span></p>
                </div>
              )}
              {q.type === 'MULTIPLE_CHOICE' && (
                <div className="space-y-2 text-sm">
                   <p>{translate('evalYourAnswer', {defaultValue:"Your answer"})}: <span className={cn("font-medium", userAnswers[idx] === q.correctAnswerIndex ? "text-green-600 dark:text-green-400" : "text-destructive")}>
                     {userAnswers[idx] === null ? translate('evalNoAnswer', {defaultValue:"Not answered"}) : q.options[userAnswers[idx] as number]}
                    </span></p>
                   <p>{translate('evalCorrectAnswer', {defaultValue:"Correct answer"})}: <span className="font-medium text-green-600 dark:text-green-400">{q.options[q.correctAnswerIndex]}</span></p>
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground italic">{translate('evalExplanation', {defaultValue:"Explanation"})}: {q.explanation}</p>
            </div>
          ))}
           <div className="mt-8 pt-6 border-t flex flex-col sm:flex-row gap-3 justify-center">
            {/* Verificar si es evaluación de tarea asignada por profesor */}
            {(() => {
              // Detección robusta con logging detallado
              const reactState = isTaskEvaluationSession;
              const localStorageState = localStorage.getItem('isTaskEvaluation') === 'true';
              const sessionStorageState = sessionStorage.getItem('isTaskEvaluation') === 'true';
              const autoStartParam = searchParams.get('autoStart') === 'true';
              const taskIdParam = !!searchParams.get('taskId');
              const autoStartModeState = isAutoStartMode;
              
              console.log('🔍🔍🔍 REVIEW SCREEN - DETAILED DETECTION:', {
                reactState,
                localStorageState,
                sessionStorageState,
                autoStartParam,
                taskIdParam,
                autoStartModeState,
                allURLParams: Object.fromEntries(searchParams.entries()),
                localStorage_raw: localStorage.getItem('isTaskEvaluation'),
                sessionStorage_raw: sessionStorage.getItem('isTaskEvaluation'),
                evaluationFinished,
                showResultDialog
              });
              
              // Una evaluación es de tarea si CUALQUIERA de estos es verdadero
              const isTaskEvaluation = reactState || localStorageState || sessionStorageState || autoStartParam || taskIdParam || autoStartModeState;
              
              console.log('🎯 FINAL DECISION:', {
                isTaskEvaluation,
                reasoning: isTaskEvaluation ? 'Task evaluation detected' : 'Normal evaluation detected',
                decision: isTaskEvaluation ? 'SHOW CLOSE BUTTON' : 'SHOW REPEAT & NEW BUTTONS',
                currentState: {
                  evaluationFinished,
                  showResultDialog,
                  evaluationStarted
                }
              });

              // Si es evaluación de tarea: solo mostrar botón Cerrar
              if (isTaskEvaluation) {
                console.log('✅ Showing CLOSE button for task evaluation (REVIEW SCREEN)');
                return (
                  <Button onClick={handleCloseTaskEvaluation} className="w-full sm:w-auto home-card-button-purple">
                    {translate('evalCloseButtonText')}
                  </Button>
                );
              }
              
              // Si es evaluación normal: mostrar botones Repetir y Nueva Evaluación
              console.log('❌ Showing REPEAT & NEW buttons for normal evaluation (REVIEW SCREEN)');
              return (
                <>
                  <Button onClick={handleRepeatEvaluation} className="w-full sm:w-auto home-card-button-purple">
                      {translate('evalRetakeButton', {defaultValue: "Repetir Evaluación"})}
                  </Button>
                  <Button onClick={handleStartNewEvaluation} variant="outline" className="w-full sm:w-auto">
                      {translate('evalNewEvaluationButton', {defaultValue: "Nueva Evaluación"})}
                  </Button>
                </>
              );
            })()}
           </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="w-full max-w-2xl mx-auto shadow-xl">
        <CardHeader className="text-center border-b pb-4">
          <CardTitle className="text-2xl font-bold font-headline">{evaluationTitle}</CardTitle>
          <CardDescription className="flex items-center justify-center space-x-4">
            <span>{translate('evalQuestionProgress', { current: String(currentQuestionIndex + 1), total: String(evaluationQuestions.length) })}</span>
            {evaluationStarted && !evaluationFinished && (
              <span className="font-mono text-base text-primary tabular-nums flex items-center">
                <Timer className="w-4 h-4 mr-1.5" />
                {translate('evalTimeLeft', { time: formatTime(timeLeft) })}
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 min-h-[250px] flex flex-col justify-between">
          {currentQuestion && (
            <div>
              <p className="text-lg font-medium mb-6 text-left md:text-center">{currentQuestion.questionText}</p>
              {currentQuestion.type === 'TRUE_FALSE' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Button
                    variant="ghost"
                    className={cn(
                        "py-3 text-base w-full",
                        userAnswers[currentQuestionIndex] === true ?
                        'home-card-button-purple' : 
                        'border border-primary text-primary hover:bg-primary/10 dark:hover:bg-primary/20' 
                    )}
                    onClick={() => handleAnswerSelect(true)}
                  >
                    {translate('evalTrue')}
                  </Button>
                  <Button
                    variant="ghost"
                     className={cn(
                        "py-3 text-base w-full",
                        userAnswers[currentQuestionIndex] === false ?
                        'home-card-button-purple' : 
                        'border border-primary text-primary hover:bg-primary/10 dark:hover:bg-primary/20' 
                    )}
                    onClick={() => handleAnswerSelect(false)}
                  >
                    {translate('evalFalse')}
                  </Button>
                </div>
              )}
              {currentQuestion.type === 'MULTIPLE_CHOICE' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {currentQuestion.options.map((option, index) => (
                    <Button
                      key={index}
                      variant="ghost"
                      className={cn(
                        "py-3 text-base justify-start text-left h-auto whitespace-normal w-full",
                        userAnswers[currentQuestionIndex] === index ?
                           'home-card-button-purple' : 
                           'border border-primary text-primary hover:bg-primary/10 dark:hover:bg-primary/20' 
                      )}
                      onClick={() => handleAnswerSelect(index)}
                    >
                      <span className="mr-2 font-semibold">{String.fromCharCode(65 + index)}.</span> {option}
                    </Button>
                  ))}
                </div>
              )}
              {currentQuestion.type === 'MULTIPLE_SELECTION' && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground italic mb-4">
                    {translate('evalMultipleSelectionInstruction', {defaultValue: 'Selecciona todas las respuestas correctas:'})}
                  </p>
                  <div className="grid grid-cols-1 gap-3">
                    {currentQuestion.options.map((option, index) => {
                      const isSelected = Array.isArray(userAnswers[currentQuestionIndex]) && 
                                       (userAnswers[currentQuestionIndex] as number[]).includes(index);
                      return (
                        <Button
                          key={index}
                          variant="ghost"
                          className={cn(
                            "py-3 text-base justify-start text-left h-auto whitespace-normal w-full",
                            isSelected ?
                               'home-card-button-purple' : 
                               'border border-primary text-primary hover:bg-primary/10 dark:hover:bg-primary/20' 
                          )}
                          onClick={() => handleMultipleSelectionToggle(index)}
                        >
                          <span className="mr-2 font-semibold">{String.fromCharCode(65 + index)}.</span> 
                          <span className="mr-2">
                            {isSelected ? '✓' : '☐'}
                          </span>
                          {option}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          
          <div className={cn(
            'flex items-center mt-8 w-full',
            currentQuestionIndex === 0 ? 'justify-end' : 'justify-between'
          )}>
            {/* Botón Anterior - solo visible cuando no es la primera pregunta */}
            {currentQuestionIndex > 0 && (
              <Button variant="outline" onClick={handlePreviousQuestion} className="text-base py-3 px-6">
                <ChevronLeft className="w-5 h-5 mr-2" />
                {translate('evalPreviousButton')}
              </Button>
            )}

            {/* Botón Siguiente/Finalizar */}
            {currentQuestionIndex < evaluationQuestions.length - 1 ? (
              <Button onClick={handleNextQuestion} className="text-base py-3 px-6 home-card-button-purple">
                {translate('evalNextButton')}
                <ChevronRight className="w-5 h-5 ml-2" />
              </Button>
            ) : (
              <Button onClick={handleFinishEvaluation} className="text-base py-3 px-6 bg-green-500 hover:bg-green-600 text-white dark:bg-green-600 dark:hover:bg-green-700">
                <Award className="w-5 h-5 mr-2" />
                {translate('evalFinishButton')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dialog para cuando se acaba el tiempo */}
      <AlertDialog open={showTimeUpDialog} onOpenChange={setShowTimeUpDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader className="items-center text-center">
            <Timer className="w-16 h-16 text-red-500 mb-3" />
            <AlertDialogTitle className="text-2xl font-headline text-red-600 dark:text-red-400">
              {translate('evalTimeUpTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base text-muted-foreground mt-2">
              {translate('evalTimeUpDesc')}
            </AlertDialogDescription>
            <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-700 dark:text-red-300 text-center">
                {translate('evalTimeUpMessage')}
              </p>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6">
            <Button onClick={handleTimeUpDialogClose} className="w-full home-card-button-purple">
              {translate('evalTimeUpCloseButton')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResultDialog} onOpenChange={setShowResultDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader className="items-center text-center">
            <PartyPopper className="w-16 h-16 text-yellow-500 mb-3" />
            <AlertDialogTitle className="text-2xl font-headline">{translate('evalResultTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-muted-foreground mt-2">
              {translate('evalYourScore', { score: String(score), totalPoints: String(evaluationQuestions.length) })}
            </AlertDialogDescription>
            {/* Mostrar porcentaje de completitud */}
            <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="flex items-center justify-center gap-2">
                <Award className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <span className="text-lg font-semibold text-blue-700 dark:text-blue-300">
                  {translate('evalCompletedPercentage', { percentage: completionPercentage.toFixed(1) })}
                </span>
              </div>
              {isSubmittingEvaluation && (
                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 text-center">
                  {translate('evalSendingResults')}
                </p>
              )}
            </div>
            {motivationalMessageKey && (
              <p className="mt-3 text-sm text-foreground text-center">
                {translate(motivationalMessageKey)}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6">
            {(() => {
              // Detección robusta con logging detallado
              const reactState = isTaskEvaluationSession;
              const localStorageState = localStorage.getItem('isTaskEvaluation') === 'true';
              const sessionStorageState = sessionStorage.getItem('isTaskEvaluation') === 'true';
              const autoStartParam = searchParams.get('autoStart') === 'true';
              const taskIdParam = !!searchParams.get('taskId');
              const autoStartModeState = isAutoStartMode;
              
              console.log('🔍🔍🔍 RESULTS DIALOG - DETAILED DETECTION:', {
                reactState,
                localStorageState,
                sessionStorageState,
                autoStartParam,
                taskIdParam,
                autoStartModeState,
                allURLParams: Object.fromEntries(searchParams.entries()),
                localStorage_raw: localStorage.getItem('isTaskEvaluation'),
                sessionStorage_raw: sessionStorage.getItem('isTaskEvaluation')
              });
              
              // Una evaluación es de tarea si CUALQUIERA de estos es verdadero
              const isTaskEvaluation = reactState || localStorageState || sessionStorageState || autoStartParam || taskIdParam || autoStartModeState;
              
              console.log('🎯 FINAL DECISION (DIALOG):', {
                isTaskEvaluation,
                reasoning: isTaskEvaluation ? 'Task evaluation detected' : 'Normal evaluation detected',
                decision: isTaskEvaluation ? 'SHOW CLOSE BUTTON' : 'SHOW REPEAT & CLOSE BUTTONS'
              });
              
              // Si es evaluación de tarea: botón para ir a revisión, no cerrar directamente
              if (isTaskEvaluation) {
                console.log('✅ Showing REVIEW button for task evaluation (RESULTS DIALOG)');
                return (
                  <Button onClick={handleCloseDialogAndShowReview} className="w-full home-card-button-purple">
                    Ver Revisión
                  </Button>
                );
              }
              
              // Si es evaluación normal: mostrar botones Repetir y Cerrar
              console.log('❌ Showing REPEAT & CLOSE buttons for normal evaluation (RESULTS DIALOG)');
              return (
                <div className="flex flex-col sm:flex-row gap-3 justify-center items-center w-full">
                  <Button onClick={handleRepeatEvaluation} className="w-full sm:w-auto min-w-[140px] home-card-button-purple">
                    {translate('evalRepeatButton')}
                  </Button>
                  <Button onClick={handleCloseDialogAndShowReview} variant="outline" className="w-full sm:w-auto min-w-[140px]">
                    {translate('evalCloseButton')}
                  </Button>
                </div>
              );
            })()}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

