
"use client";

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/contexts/language-context';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { FileQuestion, Sparkles, Download, Newspaper, Network, ClipboardList, BookOpen, Loader2 } from 'lucide-react';
import { BookCourseSelector } from '@/components/common/book-course-selector';
import { generateQuiz } from '@/ai/flows/generate-quiz';
import { analyzeSubjectTopics } from '@/ai/flows/analyze-subject-topics';
import { useToast } from "@/hooks/use-toast";
import { useAIProgress } from "@/hooks/use-ai-progress";
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { contentDB } from '@/lib/sql-content';
import { useAuth } from '@/contexts/auth-context';

// Cache para evitar regenerar el mismo quiz
const quizCache = new Map<string, { quiz: string; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

export default function CuestionarioPage() {
  const { translate, language: currentUiLanguage } = useLanguage();
  const { toast } = useToast();
  const { progress, progressText, isLoading, startProgress, stopProgress } = useAIProgress();
  const { user } = useAuth();
  const [selectedCourse, setSelectedCourse] = useState('');
  const [selectedBook, setSelectedBook] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [quizResult, setQuizResult] = useState('');
  const [currentTopicForDisplay, setCurrentTopicForDisplay] = useState('');
  
  // Estados para análisis automático de temas de cualquier asignatura
  const [subjectTopics, setSubjectTopics] = useState<string[]>([]);
  const [selectedSubjectTopic, setSelectedSubjectTopic] = useState<string>('');
  const [isAnalyzingSubject, setIsAnalyzingSubject] = useState(false);
  const [subjectBookTitle, setSubjectBookTitle] = useState<string>('');
  
  // Ref para evitar llamadas duplicadas
  const isGeneratingRef = useRef(false);
  const hasAnalyzedRef = useRef<string>('');

  // Detectar el tipo de asignatura para mostrar icono apropiado
  const subjectIcon = useMemo(() => {
    const s = `${selectedBook || ''} ${selectedSubject || ''}`.toLowerCase();
    if (/matem|math|algebra|geometr/i.test(s)) return '🔢';
    if (/lenguaje|comunicacion|language|literatura/i.test(s)) return '📚';
    if (/ciencia|natural|science|biolog/i.test(s)) return '🔬';
    if (/historia|geography|social|civica/i.test(s)) return '🌍';
    return '📖';
  }, [selectedBook, selectedSubject]);

  // Limpiar estados cuando cambia el curso o la asignatura
  useEffect(() => {
    setQuizResult('');
    setCurrentTopicForDisplay('');
    setTopic('');
  }, [selectedCourse, selectedSubject]);

  // Analizar automáticamente los temas cuando se selecciona cualquier asignatura
  useEffect(() => {
    const analyzeKey = `${selectedCourse}_${selectedSubject}`;
    
    if (selectedCourse && selectedSubject && hasAnalyzedRef.current !== analyzeKey) {
      hasAnalyzedRef.current = analyzeKey;
      setIsAnalyzingSubject(true);
      setSubjectTopics([]);
      setSelectedSubjectTopic('');
      setSubjectBookTitle('');
      
      console.log('[Quiz] Starting subject analysis for:', selectedCourse, selectedSubject);
      
      analyzeSubjectTopics({
        courseName: selectedCourse,
        subjectName: selectedSubject,
        language: currentUiLanguage,
      }).then((res) => {
        console.log('[Quiz] Subject analysis result:', res);
        if (res.topics && res.topics.length > 0) {
          setSubjectTopics(res.topics);
          setSubjectBookTitle(res.bookTitle || '');
          toast({
            title: translate('quizPdfAnalyzeDone') || 'Análisis completado',
            description: `${translate('quizPdfTopicsFound') || 'Temas detectados'}: ${res.topics.length}`,
            variant: 'default',
          });
        }
      }).catch((e) => {
        console.error('[Quiz] Error analizando asignatura:', e);
      }).finally(() => {
        setIsAnalyzingSubject(false);
      });
    } else if (!selectedSubject) {
      // Limpiar cuando no hay asignatura
      setSubjectTopics([]);
      setSelectedSubjectTopic('');
      setSubjectBookTitle('');
    }
  }, [selectedCourse, selectedSubject, currentUiLanguage, toast, translate]);

  // Cuando se selecciona un tema de la asignatura, actualizar el campo de tema
  const handleSubjectTopicSelect = useCallback((value: string) => {
    setSelectedSubjectTopic(value);
    if (value) setTopic(value);
  }, []);

  // Función para generar clave de caché
  const getCacheKey = useCallback((book: string, subject: string, course: string, topicStr: string, lang: string) => {
    return `${book || subject}_${course}_${topicStr.toLowerCase().trim()}_${lang}`;
  }, []);

  // Función para verificar caché
  const getFromCache = useCallback((key: string) => {
    const cached = quizCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.quiz;
    }
    if (cached) {
      quizCache.delete(key); // Limpiar caché expirado
    }
    return null;
  }, []);

  // Función para guardar en caché
  const saveToCache = useCallback((key: string, quiz: string) => {
    // Limpiar entradas antiguas si hay más de 10
    if (quizCache.size > 10) {
      const oldestKey = quizCache.keys().next().value;
      if (oldestKey) quizCache.delete(oldestKey);
    }
    quizCache.set(key, { quiz, timestamp: Date.now() });
  }, []);

  // Función optimizada para persistir quiz (no bloquea UI)
  const persistQuizAsync = useCallback((quizData: {
    quiz: string;
    topic: string;
    book: string;
    course: string;
  }) => {
    // Ejecutar en siguiente tick para no bloquear
    setTimeout(async () => {
      try {
        await contentDB.saveQuiz({
          id: crypto.randomUUID(),
          userId: (user as any)?.id || null,
          username: user?.username || null,
          courseId: quizData.course || null,
          sectionId: null,
          subjectName: quizData.book || null,
          topic: quizData.topic,
          quiz: quizData.quiz,
          language: currentUiLanguage,
          createdAt: new Date().toISOString()
        });
      } catch (e) { 
        console.warn('[Quiz] No se pudo persistir en BD', e); 
      }
    }, 0);
  }, [user, currentUiLanguage]);

  // Función optimizada para actualizar contador (no bloquea UI)
  const updateQuizCounterAsync = useCallback(() => {
    setTimeout(() => {
      try {
        const currentCount = parseInt(localStorage.getItem('quizzesCreatedCount') || '0', 10);
        localStorage.setItem('quizzesCreatedCount', (currentCount + 1).toString());
        window.dispatchEvent(new Event('localStorageUpdate'));
      } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || e?.message?.includes('quota')) {
          // Limpiar claves grandes/innecesarias
          ['smart-student-tasks', 'smart-student-task-comments', 'smart-student-evaluations',
           'smart-student-evaluation-results', 'smart-student-users', 'smart-student-courses',
           'smart-student-sections', 'smart-student-student-assignments'
          ].forEach(key => localStorage.removeItem(key));
          // Reintentar
          try {
            const count = parseInt(localStorage.getItem('quizzesCreatedCount') || '0', 10);
            localStorage.setItem('quizzesCreatedCount', (count + 1).toString());
          } catch {}
        }
      }
    }, 0);
  }, []);

  const handleGenerateQuiz = async () => {
    if (!selectedBook && !selectedSubject) {
      toast({ title: translate('errorGenerating'), description: translate('noBookSelected'), variant: 'destructive'});
      return;
    }
    const currentTopic = topic.trim();
    if (!currentTopic) {
      toast({ title: translate('errorGenerating'), description: translate('noTopicProvided'), variant: 'destructive'});
      return;
    }
    
    // Evitar llamadas duplicadas
    if (isGeneratingRef.current) {
      console.log('[Quiz] Generación ya en progreso, ignorando...');
      return;
    }
    
    // Verificar caché primero
    const cacheKey = getCacheKey(selectedBook, selectedSubject, selectedCourse, currentTopic, currentUiLanguage);
    const cachedQuiz = getFromCache(cacheKey);
    if (cachedQuiz) {
      console.log('[Quiz] Usando resultado en caché');
      setQuizResult(cachedQuiz);
      setCurrentTopicForDisplay(currentTopic);
      toast({ 
        title: translate('quizGeneratedTitle'), 
        description: `${translate('quizGeneratedDesc')} (caché)`,
        variant: 'default'
      });
      return;
    }
    
    isGeneratingRef.current = true;
    setQuizResult('');
    setCurrentTopicForDisplay(currentTopic);
    
    // Start progress simulation
    const progressInterval = startProgress('quiz', 7000);
    
    try {
      // Llamada única a Server Action - sin fallback API redundante
      const result = await generateQuiz({
        bookTitle: selectedBook || selectedSubject,
        topic: currentTopic,
        courseName: selectedCourse || "General", 
        language: currentUiLanguage,
      });
      
      setQuizResult(result.quiz);
      
      // Guardar en caché
      saveToCache(cacheKey, result.quiz);
      
      // Persistir de forma asíncrona (no bloquea UI)
      persistQuizAsync({
        quiz: result.quiz,
        topic: currentTopic,
        book: selectedBook || selectedSubject,
        course: selectedCourse
      });
      
      // Show success notification
      toast({ 
        title: translate('quizGeneratedTitle'), 
        description: translate('quizGeneratedDesc'),
        variant: 'default'
      });
      
      // Actualizar contador de forma asíncrona
      updateQuizCounterAsync();
    } catch (error) {
      console.error("Error generating quiz:", error);
      toast({ title: translate('errorGenerating'), description: (error as Error).message, variant: 'destructive'});
      setQuizResult(`<p class="text-destructive">${translate('errorGenerating')}</p>`);
    } finally {
      isGeneratingRef.current = false;
      stopProgress(progressInterval);
    }
  };

  const handleDownloadQuizPdf = () => {
    if (!quizResult || !currentTopicForDisplay) return;

    const titlePrefix = currentUiLanguage === 'es' ? translate('quizTitlePrefix', {defaultValue: 'CUESTIONARIO'}) : translate('quizTitlePrefix', {defaultValue: 'QUIZ'});
    const title = `${titlePrefix} - ${currentTopicForDisplay.toUpperCase()}`;
    
    const contentHtml = `
      <html>
        <head>
          <title>${title}</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap');
            body { font-family: 'Space Grotesk', sans-serif; margin: 25px; line-height: 1.8; }
            h1, h2, h3 { font-family: 'Space Grotesk', sans-serif; }
            h2 { font-size: 1.6em; text-align: center; margin-bottom: 2em; font-weight: 700; } /* Quiz title */
            p { margin-bottom: 1.2em; }
            strong { font-weight: 600; }
            hr { margin-top: 1.5rem; margin-bottom: 1.5rem; border: 0; border-top: 2px solid #e5e7eb; }
            .prose { font-size: 14px; } /* Mimic prose styles */
            .question-block { margin-bottom: 2.5em; }
            .answer-space { margin-top: 1em; }
          </style>
        </head>
        <body>
          ${quizResult}
        </body>
      </html>
    `;
    
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(contentHtml);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => {
          printWindow.print();
      }, 500); 
    } else {
       toast({
        title: translate('errorGenerating'),
        description: translate('pdfDownloadErrorPopupBlocked'),
        variant: 'destructive',
      });
    }
  };


  return (
    <div className="flex flex-col items-center text-center">
      <Card className="w-full max-w-lg shadow-lg">
        <CardHeader className="items-center">
          <FileQuestion className="w-10 h-10 text-cyan-500 dark:text-cyan-400 mb-3" />
          <CardTitle className="text-3xl font-bold font-headline">{translate('quizPageTitle')}</CardTitle>
          <CardDescription className="mt-2 text-muted-foreground max-w-2xl">
            {translate('quizPageSub')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">

          <BookCourseSelector
            selectedCourse={selectedCourse}
            selectedBook={selectedBook}
            selectedSubject={selectedSubject}
            showSubjectSelector={true}
            showBookSelector={false}
            onCourseChange={setSelectedCourse}
            onBookChange={setSelectedBook}
            onSubjectChange={setSelectedSubject}
          />

          {/* Sección automática de temas desde el libro de la asignatura seleccionada */}
          {selectedCourse && selectedSubject && (
            <div className="space-y-3 p-4 border border-cyan-500/30 rounded-lg bg-cyan-500/5">
              <div className="space-y-1">
                <Label className="text-left block font-semibold text-cyan-600 dark:text-cyan-400">
                  <BookOpen className="w-4 h-4 inline mr-2" />
                  {subjectIcon} {translate('quizSubjectTopicsTitle') || 'Temas de la Asignatura'}
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
                  {translate('quizAnalyzingSubject') || 'Analizando temas de la asignatura con IA...'}
                </div>
              ) : subjectTopics.length > 0 ? (
                <div className="space-y-2">
                  <Label className="text-left block text-sm">
                    {translate('quizSelectTopic') || 'Selecciona un tema para generar el cuestionario:'}
                  </Label>
                  <Select value={selectedSubjectTopic} onValueChange={handleSubjectTopicSelect}>
                    <SelectTrigger>
                      <SelectValue placeholder={translate('quizChooseTopic') || 'Elige un tema…'} />
                    </SelectTrigger>
                    <SelectContent>
                      {subjectTopics.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-left text-xs text-muted-foreground">
                    💡 {translate('quizTopicHint') || 'El cuestionario incluirá preguntas variadas sobre el tema seleccionado.'}
                  </p>
                </div>
              ) : (
                <p className="text-left text-xs text-muted-foreground">
                  {translate('quizNoTopics') || 'No se encontraron temas. Puedes escribir el tema manualmente.'}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="quiz-topic-input" className="text-left block">{translate('quizTopicPlaceholder')}</Label>
            <Textarea
              id="quiz-topic-input"
              rows={2}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={translate('quizTopicPlaceholder')}
              className="text-base md:text-sm"
              disabled={!selectedSubject}
            />
          </div>
          <Button
            onClick={handleGenerateQuiz}
            disabled={isLoading}
            className={cn(
              "w-full font-semibold py-3 text-base md:text-sm home-card-button-cyan",
              "hover:brightness-110 hover:shadow-lg hover:scale-105 transition-all duration-200"
            )}
          >
            {isLoading ? (
              <>{translate('loading')} {progress}%</>
            ) : (
              <>
                <Sparkles className="w-5 h-5 mr-2" />
                {translate('quizGenerateBtn')}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {quizResult && !isLoading && (
        <Card className="mt-6 w-full max-w-lg text-left shadow-md">
          <CardContent className="pt-6">
            <div 
              dangerouslySetInnerHTML={{ __html: quizResult }} 
              className="prose dark:prose-invert max-w-none text-sm leading-relaxed quiz-content" 
            />
            
            <div className="mt-8 pt-6 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              <Button
                onClick={handleDownloadQuizPdf}
                className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-cyan text-xs sm:text-sm"
              >
                <Download className="mr-2 h-4 w-4" /> {translate('quizActionDownloadPdf')}
              </Button>
              <Button asChild className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-blue text-xs sm:text-sm">
                <Link href="/dashboard/resumen">
                  <Newspaper className="mr-2 h-4 w-4" /> {translate('quizActionCreateSummary')}
                </Link>
              </Button>
              <Button asChild className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-yellow text-xs sm:text-sm">
                <Link href="/dashboard/mapa-mental">
                  <Network className="mr-2 h-4 w-4" /> {translate('quizActionCreateMap')}
                </Link>
              </Button>
              <Button asChild className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-purple text-xs sm:text-sm">
                <Link href="/dashboard/evaluacion">
                  <ClipboardList className="mr-2 h-4 w-4" /> {translate('quizActionCreateEval')}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
