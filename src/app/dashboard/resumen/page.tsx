
"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/contexts/language-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Newspaper, Download, Network, FileQuestion, ClipboardList, BookOpen, Loader2 } from 'lucide-react';
import { BookCourseSelector } from '@/components/common/book-course-selector';
import { useToast } from "@/hooks/use-toast";
import { useAIProgress } from "@/hooks/use-ai-progress";
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { contentDB } from '@/lib/sql-content';
import { useAuth } from '@/contexts/auth-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { analyzeMathPdfTopics } from '@/ai/flows/analyze-math-pdf-topics';

// Types for API response
interface GenerateSummaryResponse {
  summary: string;
  keyPoints?: string[];
  progress: string;
}

// Helper function to convert basic Markdown to HTML for the main summary
function simpleMarkdownToHtml(mdText: string): string {
  if (!mdText) return '';

  let html = mdText;

  // Normalize line endings
  html = html.replace(/\r\n?/g, '\n');

  // Headings (##, ###) - Add proper spacing
  html = html.replace(/^### +(.*?) *(\n|$)/gm, '<h3 class="text-lg font-semibold mt-6 mb-3">$1</h3>\n');
  html = html.replace(/^## +(.*?) *(\n|$)/gm, '<h2 class="text-xl font-bold mt-8 mb-4">$1</h2>\n');
  html = html.replace(/^# +(.*?) *(\n|$)/gm, '<h1 class="text-2xl font-bold mt-10 mb-6">$1</h1>\n');

  // Bold (**)
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italics (*)
  html = html.replace(/(?<!\*)\*(?!\s)(.*?[^\s\*])\*(?!\*)/g, '<em>$1</em>');


  // Paragraphs from blocks separated by one or more blank lines
  // Blocks that are already Hx tags are preserved.
  // Single newlines within a paragraph block are converted to <br />.
  html = html
    .split(/\n\s*\n/) // Split by one or more blank lines
    .map((block) => {
      const trimmedBlock = block.trim();
      if (trimmedBlock === '') {
        return ''; // Skip empty blocks
      }
      // If it's already an Hx tag (from our conversion above)
      if (trimmedBlock.match(/^<(h[1-6])[^>]*>.*?<\/\1>/i)) {
        return trimmedBlock; 
      }
      // Otherwise, wrap in <p> and convert internal single newlines to <br>
      return `<p class="mb-4">${trimmedBlock.replace(/\n/g, '<br />')}</p>`;
    })
    .join('');

  return html;
}

// Helper function for inline Markdown formatting (e.g., for key points)
function formatInlineMarkdown(text: string): string {
  if (!text) return '';
  let html = text;
  // Normalize line endings (though less critical for single lines)
  html = html.replace(/\r\n?/g, '\n');
  // Bold (**)
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italics (*) - careful not to match bold's asterisks
  html = html.replace(/(?<!\*)\*(?!\s)(.*?[^\s\*])\*(?!\*)/g, '<em>$1</em>');
  // Convert any literal newlines within a key point to <br /> (AI should ideally provide single lines for points)
  html = html.replace(/\n/g, '<br />');
  return html;
}


export default function ResumenPage() {
  const { translate, language: currentUiLanguage } = useLanguage();
  const { toast } = useToast();
  const { progress, progressText, isLoading, startProgress, stopProgress } = useAIProgress();
  const { user } = useAuth();
  const [selectedCourse, setSelectedCourse] = useState('');
  const [selectedBook, setSelectedBook] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [includeKeyPoints, setIncludeKeyPoints] = useState(false);
  const [summaryResult, setSummaryResult] = useState<{ summary: string; keyPoints?: string[] } | null>(null);
  const [keyPointsRequested, setKeyPointsRequested] = useState(false);
  const [currentTopicForDisplay, setCurrentTopicForDisplay] = useState('');
  
  // Estados para análisis de PDF de matemáticas
  const [mathTopics, setMathTopics] = useState<string[]>([]);
  const [selectedMathTopic, setSelectedMathTopic] = useState('');
  const [isAnalyzingPdf, setIsAnalyzingPdf] = useState(false);
  const [isMathSelection, setIsMathSelection] = useState(false);

  // Detectar si es matemáticas y analizar el PDF automáticamente
  useEffect(() => {
    const checkMathSubject = async () => {
      const subjectLower = selectedSubject.toLowerCase();
      const isMath = subjectLower.includes('matemat') || 
                     subjectLower.includes('math') || 
                     subjectLower.includes('álgebra') || 
                     subjectLower.includes('algebra') ||
                     subjectLower.includes('geometr') ||
                     subjectLower.includes('cálculo') ||
                     subjectLower.includes('calculo') ||
                     subjectLower.includes('trigonometr') ||
                     subjectLower.includes('aritmética') ||
                     subjectLower.includes('aritmetica');
      
      setIsMathSelection(isMath);
      
      if (isMath && selectedCourse) {
        setIsAnalyzingPdf(true);
        setMathTopics([]);
        setSelectedMathTopic('');
        
        try {
          // Analizar el PDF de matemáticas de la biblioteca
          const result = await analyzeMathPdfTopics({
            courseLevel: selectedCourse,
            language: currentUiLanguage
          });
          
          if (result.topics && result.topics.length > 0) {
            setMathTopics(result.topics);
            toast({
              title: translate('mathTopicsDetected') || '📚 Temas detectados',
              description: `${result.topics.length} ${translate('mathTopicsFound') || 'temas de matemáticas encontrados en el PDF'}`,
              variant: 'default'
            });
          }
        } catch (error) {
          console.error('Error analyzing math PDF:', error);
        } finally {
          setIsAnalyzingPdf(false);
        }
      } else {
        setMathTopics([]);
        setSelectedMathTopic('');
      }
    };
    
    checkMathSubject();
  }, [selectedSubject, selectedCourse, currentUiLanguage]);

  // Cuando se selecciona un tema de matemáticas, actualizar el campo de tema
  const handleMathTopicSelect = (topicValue: string) => {
    setSelectedMathTopic(topicValue);
    if (topicValue) {
      setTopic(topicValue);
    }
  };

  const handleGenerateSummary = async () => {
    if (!selectedSubject) {
      toast({ 
        title: translate('errorGenerating'), 
        description: translate('noSubjectSelected'), 
        variant: 'destructive'
      });
      return;
    }
    if (!topic.trim()) {
      toast({ 
        title: translate('errorGenerating'), 
        description: translate('noTopicProvided'), 
        variant: 'destructive'
      });
      return;
    }

    setSummaryResult(null);
    setKeyPointsRequested(includeKeyPoints); 
    const topicForSummary = topic.trim() || "General Summary";
    setCurrentTopicForDisplay(topicForSummary); 

    // Start progress simulation with a longer duration to better match API response time
    const progressInterval = startProgress('summary', 15000);

    try {
      const requestBody = {
        bookTitle: selectedSubject,
        topic: topicForSummary,
        includeKeyPoints: includeKeyPoints,
        language: currentUiLanguage,
        course: selectedCourse, // Include course for better content matching
      };
      
      console.log('Sending request to API:', requestBody);
      
      const response = await fetch('/api/generate-summary', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result: GenerateSummaryResponse = await response.json();
      
      if (result && result.summary) {
        setSummaryResult({
          summary: result.summary, 
          keyPoints: result.keyPoints
        });

        // Persistir en BD (Supabase/IDB)
        try {
          await contentDB.saveSummary({
            id: crypto.randomUUID(),
            userId: (user as any)?.id || null,
            username: user?.username || null,
            courseId: selectedCourse || null,
            sectionId: null,
            subjectName: selectedBook || selectedSubject || null,
            topic: topicForSummary,
            content: result.summary,
            keyPoints: result.keyPoints || null,
            language: currentUiLanguage,
            createdAt: new Date().toISOString()
          });
        } catch (e) {
          console.warn('[Resumen] No se pudo persistir en BD, se continuará con contador LS.', e);
        }
        
        // Show success notification
        toast({ 
          title: translate('summaryGeneratedTitle'), 
          description: translate('summaryGeneratedDesc'),
          variant: 'default'
        });
        
        // Increment summaries count
        const currentCount = parseInt(localStorage.getItem('summariesCreatedCount') || '0', 10);
        try {
          localStorage.setItem('summariesCreatedCount', (currentCount + 1).toString());
          try { window.dispatchEvent(new Event('localStorageUpdate')); } catch {}
          try { window.dispatchEvent(new Event('toolCountersUpdated')); } catch {}
        } catch (e: any) {
          if (e?.name === 'QuotaExceededError' || e?.message?.includes('quota')) {
            // Limpiar algunas claves grandes e intentar nuevamente
            const keysToRemove = [
              'smart-student-tasks',
              'smart-student-task-comments',
              'smart-student-evaluations',
              'smart-student-evaluation-results',
              'smart-student-users',
              'smart-student-courses',
              'smart-student-sections',
              'smart-student-student-assignments'
            ];
            keysToRemove.forEach(key => localStorage.removeItem(key));
            try {
              localStorage.setItem('summariesCreatedCount', (currentCount + 1).toString());
              try { window.dispatchEvent(new Event('localStorageUpdate')); } catch {}
              try { window.dispatchEvent(new Event('toolCountersUpdated')); } catch {}
            } catch (err) {
              toast({ title: translate('errorGenerating'), description: 'No se pudo guardar el contador de resúmenes. Libera espacio en tu navegador.', variant: 'destructive'});
            }
          } else {
            throw e;
          }
        }
      } else {
        throw new Error('No summary content received');
      }
    } catch (error) {
      console.error("Error generating summary:", error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      
      toast({ 
        title: translate('errorGenerating'), 
        description: errorMessage, 
        variant: 'destructive'
      });
    } finally {
      stopProgress(progressInterval);
    }
  };

  const handleDownloadPdf = () => {
    if (!summaryResult?.summary) return;

    const title = `${translate('summaryTitlePrefix')} - ${currentTopicForDisplay.toUpperCase()}`;
    // Use the same Markdown to HTML conversion for PDF content
    const summaryHtmlForPdf = simpleMarkdownToHtml(summaryResult.summary);

    let contentHtml = `
      <html>
        <head>
          <title>${title}</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap');
            body { font-family: 'Space Grotesk', sans-serif; margin: 25px; line-height: 1.8; text-align: justify; }
            h1, h2, h3 { font-family: 'Space Grotesk', sans-serif; }
            h1 { text-align: center; font-size: 1.8em; margin-bottom: 1.5em; font-weight: 700; }
            h2 { font-size: 1.4em; margin-top: 2em; margin-bottom: 1em; font-weight: 600; border-bottom: 2px solid #333; padding-bottom: 0.5em; }
            h3 { font-size: 1.2em; margin-top: 1.5em; margin-bottom: 0.75em; font-weight: 500; }
            p { margin-bottom: 1.2em; text-indent: 0; }
            strong { font-weight: 600; }
            em { font-style: italic; }
            ul { list-style-type: disc; padding-left: 25px; margin-bottom: 1.5em; }
            li { margin-bottom: 0.8em; line-height: 1.6; }
            .mb-4 { margin-bottom: 1.2em; }
          </style>
        </head>
        <body>
          <h1>${title}</h1>
          <h2>${translate('summaryContentTitle')}</h2>
          <div>${summaryHtmlForPdf}</div>
    `;

    if (keyPointsRequested && summaryResult.keyPoints && summaryResult.keyPoints.length > 0) {
      contentHtml += `<h2>${translate('summaryKeyPointsTitle')}</h2><ul>`;
      summaryResult.keyPoints.forEach(point => {
        // Use formatInlineMarkdown for key points in PDF too
        contentHtml += `<li>${formatInlineMarkdown(point)}</li>`;
      });
      contentHtml += `</ul>`;
    }

    contentHtml += `
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

  const formattedSummaryHtml = summaryResult?.summary ? simpleMarkdownToHtml(summaryResult.summary) : '';

  return (
    <div className="flex flex-col items-center text-center">
      <Card className="w-full max-w-lg shadow-lg">
        <CardHeader className="items-center">
          <Newspaper className="w-10 h-10 text-blue-500 dark:text-blue-400 mb-3" />
          <CardTitle className="text-3xl font-bold font-headline text-center">
            {translate('summaryPageTitleLine1')}
            <br />
            {translate('summaryPageTitleLine2')}
          </CardTitle>
          <CardDescription className="mt-2 text-muted-foreground max-w-2xl text-center">
            {translate('summaryPageSub')}
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
            onBookChange={(book) => {
              setSelectedBook(book);
            }}
            onSubjectChange={setSelectedSubject}
          />
          
          {/* Análisis automático de PDF para Matemáticas */}
          {isMathSelection && (
            <div className="space-y-3 p-4 bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-lg border border-blue-500/20">
              <div className="flex items-center gap-2 text-sm font-medium text-blue-400">
                <BookOpen className="w-4 h-4" />
                <span>{translate('summaryMathPdfAnalysis')}</span>
              </div>
              
              {isAnalyzingPdf ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{translate('summaryAnalyzingMathPdf')}</span>
                </div>
              ) : mathTopics.length > 0 ? (
                <div className="space-y-2">
                  <Label className="text-left block text-sm">
                    {translate('summarySelectMathTopic')}
                  </Label>
                  <Select value={selectedMathTopic} onValueChange={handleMathTopicSelect}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={translate('summaryChooseMathTopic')} />
                    </SelectTrigger>
                    <SelectContent>
                      {mathTopics.map((mathTopic, index) => (
                        <SelectItem key={index} value={mathTopic}>
                          📐 {mathTopic}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {translate('summaryMathTopicHint')}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {translate('summaryNoMathTopicsFound')}
                </p>
              )}
            </div>
          )}
          
          <div className="space-y-2">
            <Label htmlFor="summary-topic-input" className="text-left block">{translate('summaryTopicPlaceholder')}</Label>
            <Textarea
              id="summary-topic-input"
              rows={3}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={translate('summaryTopicPlaceholder')}
              className="text-base md:text-sm"
            />
          </div>
          
          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-key-points"
              checked={includeKeyPoints}
              onCheckedChange={(checked) => setIncludeKeyPoints(Boolean(checked))}
            />
            <Label htmlFor="include-key-points" className="text-sm font-medium">
              {translate('summaryIncludeKeyPointsShort')}
            </Label>
          </div>
          <Button
            onClick={handleGenerateSummary}
            disabled={isLoading}
            className={cn(
              "w-full font-semibold py-3 text-base md:text-sm home-card-button-blue",
              "hover:brightness-110 hover:shadow-lg hover:scale-105 transition-all duration-200"
            )}
          >
            {isLoading ? (
              progress >= 100 ? 
                <>{translate('loading')} Finalizando...</> :
                <>{translate('loading')} {progress}%</>
            ) : (
              <>{translate('summaryGenerateBtn')}</>
            )}
          </Button>
        </CardContent>
      </Card>

      {summaryResult && !isLoading && (
        <Card className="mt-6 w-full max-w-lg text-left shadow-md">
          <CardHeader>
            <CardTitle className="font-headline text-center">
              {translate('summaryTitlePrefix').toUpperCase()} - {currentTopicForDisplay.toUpperCase()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div 
              dangerouslySetInnerHTML={{ __html: formattedSummaryHtml }} 
              className="prose dark:prose-invert max-w-none text-sm leading-relaxed font-headline text-justify" 
            />
            {keyPointsRequested && (
              <div className="mt-6">
                <h3 className="text-lg font-semibold mb-2 font-headline text-left">{translate('summaryKeyPointsTitle')}</h3>
                {summaryResult.keyPoints && summaryResult.keyPoints.length > 0 ? (
                  <ul className="list-disc list-inside space-y-3 text-sm font-headline text-left">
                    {summaryResult.keyPoints.map((point, index) => {
                      const formattedPoint = formatInlineMarkdown(point);
                      return <li key={index} dangerouslySetInnerHTML={{ __html: formattedPoint }} className="mb-2" />;
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground font-headline text-left">{translate('summaryNoKeyPointsGenerated')}</p>
                )}
              </div>
            )}
             <div className="mt-8 pt-6 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              <Button
                onClick={handleDownloadPdf}
                className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-blue text-xs sm:text-sm"
              >
                <Download className="mr-2 h-4 w-4" /> {translate('summaryActionDownloadPdf')}
              </Button>
              <Button asChild className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-yellow text-xs sm:text-sm">
                <Link href="/dashboard/mapa-mental">
                  <Network className="mr-2 h-4 w-4" /> {translate('summaryActionCreateMap')}
                </Link>
              </Button>
              <Button asChild className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-cyan text-xs sm:text-sm">
                <Link href="/dashboard/cuestionario">
                  <FileQuestion className="mr-2 h-4 w-4" /> {translate('summaryActionCreateQuiz')}
                </Link>
              </Button>
              <Button asChild className="font-semibold py-2 px-6 rounded-lg transition-colors home-card-button-purple text-xs sm:text-sm">
                <Link href="/dashboard/evaluacion">
                  <ClipboardList className="mr-2 h-4 w-4" /> {translate('summaryActionCreateEval')}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
    

    
