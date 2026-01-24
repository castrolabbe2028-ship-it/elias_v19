"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Eye, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/auth-context"
import { useLanguage } from "@/contexts/language-context"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type AnalyzedQuestion = {
  id: string
  type: 'tf' | 'mc' | 'ms' | 'des'
  text: string
  options?: string[]
  optionsWithCorrect?: Array<{ text: string; correct: boolean }>
  correctIndex?: number
  answer?: boolean
  prompt?: string
}

type AnalysisResult = {
  success: boolean
  title?: string
  topic?: string
  questions: AnalyzedQuestion[]
  counts: { tf: number; mc: number; ms: number; des: number }
  totalQuestions: number
  error?: string
}

type Course = { id: string; name: string }
type Section = { id: string; name: string; courseId?: string; course?: { id?: string } }
type Subject = { id: string; name: string }

type Props = {
  onTestCreated?: (test: any) => void
}

const COURSES_KEY = "smart-student-courses"
const SECTIONS_KEY = "smart-student-sections"
const SUBJECTS_KEY = "smart-student-subjects"
const TEACHER_ASSIGNMENTS_KEY = "smart-student-teacher-assignments"
const USERS_KEY = "smart-student-users"
const ADMIN_COURSES_KEY = "smart-student-admin-courses"
const ADMIN_SECTIONS_KEY = "smart-student-admin-sections"
const TASKS_KEY = "smart-student-tasks"

export default function ManualTestBuilder({ onTestCreated }: Props) {
  const { user } = useAuth() as any
  const { translate, language } = useLanguage()
  
  // Estados de archivo
  const [file, setFile] = useState<File | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string>("")
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // Estados de formulario (curso/sección/asignatura)
  const [courses, setCourses] = useState<Course[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [teacherAssignments, setTeacherAssignments] = useState<any[]>([])
  const [allUsers, setAllUsers] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  
  const [courseId, setCourseId] = useState<string>("")
  const [sectionId, setSectionId] = useState<string>("")
  const [subjectId, setSubjectId] = useState<string>("")
  const [topic, setTopic] = useState<string>("")
  
  // Ponderación
  const [weights, setWeights] = useState<{ tf: number; mc: number; ms: number; des: number }>({ tf: 25, mc: 25, ms: 25, des: 25 })
  const [totalPoints, setTotalPoints] = useState<number>(100)
  
  // Preview modal
  const [previewOpen, setPreviewOpen] = useState(false)
  
  // Cargar datos
  useEffect(() => {
    try {
      const csBase = JSON.parse(localStorage.getItem(COURSES_KEY) || "[]")
      const ssBase = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "[]")
      const csAdmin = JSON.parse(localStorage.getItem(ADMIN_COURSES_KEY) || "[]")
      const ssAdmin = JSON.parse(localStorage.getItem(ADMIN_SECTIONS_KEY) || "[]")
      const sb = JSON.parse(localStorage.getItem(SUBJECTS_KEY) || "[]")
      const ta = JSON.parse(localStorage.getItem(TEACHER_ASSIGNMENTS_KEY) || "[]")
      const us = JSON.parse(localStorage.getItem(USERS_KEY) || "[]")
      const tk = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]")

      setCourses([...(Array.isArray(csAdmin) ? csAdmin : []), ...(Array.isArray(csBase) ? csBase : [])])
      setSections([...(Array.isArray(ssAdmin) ? ssAdmin : []), ...(Array.isArray(ssBase) ? ssBase : [])])
      setSubjects(Array.isArray(sb) ? sb : [])
      setTeacherAssignments(Array.isArray(ta) ? ta : [])
      setAllUsers(Array.isArray(us) ? us : [])
      setTasks(Array.isArray(tk) ? tk : [])
    } catch (e) {
      console.error("[ManualTestBuilder] Error cargando datos locales", e)
    }
  }, [])
  
  // Construir asignaciones efectivas
  const effectiveAssignments = useMemo(() => {
    const list: any[] = []
    const push = (a: any) => { if (a) list.push(a) }

    if (Array.isArray(teacherAssignments) && teacherAssignments.length > 0) {
      teacherAssignments.forEach(push)
    }

    {
      const me = (allUsers || []).find((u: any) => u && (u.id === user?.id || u.username === user?.username))
      const ti = me?.teachingAssignments || []
      if (Array.isArray(ti) && ti.length > 0) {
        const subjectByName = new Map<string, string>()
        subjects.forEach((s: any) => { if (s?.name && s?.id) subjectByName.set(String(s.name), String(s.id)) })
        ti.forEach((ta: any) => {
          const subjName = ta?.subject || ta?.subjectName
          const subjId = (subjName && subjectByName.get(String(subjName))) || undefined
          const courseNames: string[] = Array.isArray(ta?.courses) ? ta.courses : []
          courses.forEach((c: any) => {
            if (!c?.id || !c?.name) return
            if (courseNames.includes(c.name)) {
              sections
                .filter((s: any) => String(s.courseId) === String(c.id))
                .forEach((sec: any) => {
                  push({
                    teacherId: me?.id,
                    teacherUsername: me?.username,
                    sectionId: sec?.id,
                    courseId: c.id,
                    subjectId: subjId,
                    subjectName: subjName,
                  })
                })
            }
          })
        })
      }
    }

    const seen = new Set<string>()
    const unique = list.filter((a: any) => {
      const key = [a.teacherId || a.teacherUsername, a.courseId || a.course, a.sectionId || a.section, a.subjectId || a.subjectName || '']
        .map((v) => String(v || ''))
        .join('|')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return unique
  }, [teacherAssignments, allUsers, user?.id, user?.username, subjects, courses, sections])
  
  // Chips Curso (Sección)
  const courseSectionChips = useMemo(() => {
    if (!user) return [] as Array<{ key: string; courseId: string; sectionId: string; label: string }>
    const secMap = new Map<string, Section>()
    sections.forEach((s: any) => { if (s && s.id) secMap.set(String(s.id), s) })
    const courseMap = new Map<string, Course>()
    courses.forEach((c: any) => { if (c && c.id) courseMap.set(String(c.id), c) })
    const my = (effectiveAssignments || []).filter((a: any) =>
      a && (a.teacherId === user.id || a.teacherUsername === user.username || a.teacher === user.username)
    )
    const seen = new Set<string>()
    const out: Array<{ key: string; courseId: string; sectionId: string; label: string }> = []
    my.forEach((a: any) => {
      const sid = String(a.sectionId || a.section || a.sectionUUID || a.section_id || a.sectionID || "")
      if (!sid) return
      const sec = secMap.get(sid)
      let cid = String((sec && (sec.courseId || sec.course?.id)) || a.courseId || a.course || a.courseUUID || a.course_id || a.courseID || "")
      if (!cid) return
      const course = courseMap.get(cid)
      const courseName = (course?.name || a.courseName || a.courseLabel || a.course_text || "").toString().trim()
      const sectionName = (sec?.name || a.sectionName || a.sectionLabel || "").toString().trim()
      const key = `${cid}-${sid}`
      if (seen.has(key)) return
      seen.add(key)
      if (!courseName || courseName.toLowerCase() === "curso" || !sectionName) return
      const label = `${courseName} ${sectionName}`
      out.push({ key, courseId: cid, sectionId: sid, label })
    })
    return out
  }, [effectiveAssignments, sections, courses, user])
  
  // Chips Asignaturas
  const subjectChips = useMemo(() => {
    if (!user || !sectionId) return [] as Array<{ key: string; label: string }>
    const list = (effectiveAssignments || []).filter((a: any) => {
      if (!(a && (a.teacherId === user.id || a.teacherUsername === user.username || a.teacher === user.username))) return false
      const secOk = String(a.sectionId || a.section || a.sectionUUID || a.section_id) === String(sectionId)
      return secOk
    })
    const nameById = new Map<string, string>()
    subjects.forEach((s: any) => { if (s && s.id) nameById.set(String(s.id), s.name || String(s.id)) })
    const seen = new Set<string>()
    const out: Array<{ key: string; label: string }> = []
    list.forEach((a: any) => {
      const sid = a.subjectId || a.subject || a.subjectUUID || a.subject_id
      const sname = a.subjectName || (sid ? nameById.get(String(sid)) : undefined)
      const key = String(sid || sname || "")
      const label = String(sname || sid || "")
      if (key && !seen.has(key)) { seen.add(key); out.push({ key, label }) }
    })
    return out
  }, [effectiveAssignments, sectionId, subjects, user])
  
  // Manejar selección de archivo
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      setFile(selectedFile)
      setAnalysisResult(null)
      setError("")
    }
  }, [])
  
  // Analizar PDF con IA
  const handleAnalyze = useCallback(async () => {
    if (!file) {
      setError(translate('testsManualPDFRequired'))
      return
    }
    
    setAnalyzing(true)
    setError("")
    setAnalysisResult(null)
    
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('language', language)
      
      const response = await fetch('/api/tests/analyze-pdf', {
        method: 'POST',
        body: formData
      })
      
      const result = await response.json()
      
      if (!result.success) {
        setError(result.error || translate('testsManualPDFError'))
        return
      }
      
      setAnalysisResult(result)
      
      // Auto-establecer tema si se detectó
      if (result.topic && !topic) {
        setTopic(result.topic)
      }
      
      // Ajustar pesos según tipos detectados
      const counts = result.counts
      const activeTypes = Object.entries(counts).filter(([_, count]) => (count as number) > 0)
      if (activeTypes.length > 0) {
        const equalWeight = Math.floor(100 / activeTypes.length)
        const newWeights = { tf: 0, mc: 0, ms: 0, des: 0 }
        activeTypes.forEach(([type]) => {
          newWeights[type as keyof typeof newWeights] = equalWeight
        })
        // Ajustar para que sume 100
        const sum = Object.values(newWeights).reduce((a, b) => a + b, 0)
        if (sum < 100 && activeTypes.length > 0) {
          newWeights[activeTypes[0][0] as keyof typeof newWeights] += (100 - sum)
        }
        setWeights(newWeights)
      }
      
    } catch (err: any) {
      console.error('[ManualTestBuilder] Error analyzing PDF:', err)
      setError(translate('testsManualPDFError'))
    } finally {
      setAnalyzing(false)
    }
  }, [file, language, topic, translate])
  
  // Verificar validez
  const isValid = useMemo(() => {
    return !!sectionId && !!subjectId && !!analysisResult?.success && analysisResult.questions.length > 0
  }, [sectionId, subjectId, analysisResult])
  
  // Crear prueba
  const handleCreateTest = useCallback(() => {
    if (!isValid || !analysisResult || !user) return
    
    const now = Date.now()
    const title = analysisResult.title || topic || 'Prueba Manual'
    
    // Resolver nombre de asignatura
    const subjName = (() => {
      const found = subjects.find((x: any) => String(x?.id) === String(subjectId))
      if (found?.name) return found.name
      const byName = subjects.find((x: any) => String(x?.name) === String(subjectId))
      return byName?.name || subjectId
    })()
    
    // Transformar preguntas al formato esperado
    const questions = analysisResult.questions.map((q, idx) => {
      const base: any = {
        id: `${q.type}_${now}_${idx}`,
        type: q.type,
        text: q.text
      }
      
      switch (q.type) {
        case 'tf':
          base.answer = q.answer ?? false
          break
        case 'mc':
          base.options = q.options || []
          base.correctIndex = q.correctIndex ?? 0
          break
        case 'ms':
          base.options = q.optionsWithCorrect || []
          break
        case 'des':
          base.prompt = q.prompt || q.text
          break
      }
      
      return base
    })
    
    const test = {
      id: `test_manual_${now}`,
      title,
      description: `Prueba creada desde PDF: ${file?.name || 'documento'}`,
      createdAt: now,
      courseId,
      sectionId,
      subjectId,
      subjectName: subjName,
      topic: topic || analysisResult.topic || title,
      counts: analysisResult.counts,
      weights,
      totalPoints,
      total: analysisResult.totalQuestions,
      questions,
      status: 'ready' as const,
      progress: 100,
      ownerId: user.id,
      ownerUsername: user.username,
      isManual: true, // Marcar como creada manualmente
      sourceFile: file?.name
    }
    
    onTestCreated?.(test)
    
    // Reset form
    setFile(null)
    setAnalysisResult(null)
    setTopic("")
    setCourseId("")
    setSectionId("")
    setSubjectId("")
    setWeights({ tf: 25, mc: 25, ms: 25, des: 25 })
    setTotalPoints(100)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [isValid, analysisResult, user, subjects, subjectId, topic, file, courseId, sectionId, weights, totalPoints, onTestCreated])
  
  // Renderizar pregunta en preview
  const renderQuestionPreview = (q: AnalyzedQuestion, idx: number) => {
    const typeLabels: Record<string, string> = {
      tf: translate('testsTF'),
      mc: translate('testsMC'),
      ms: translate('testsMS'),
      des: translate('testsDES')
    }
    
    return (
      <div key={q.id} className="border rounded-lg p-3 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-200">
            {idx + 1}. {typeLabels[q.type] || q.type.toUpperCase()}
          </span>
        </div>
        <p className="text-sm mb-2">{q.text}</p>
        
        {q.type === 'tf' && (
          <div className="text-xs text-muted-foreground">
            {language === 'es' ? 'Respuesta:' : 'Answer:'} {q.answer ? (language === 'es' ? 'Verdadero' : 'True') : (language === 'es' ? 'Falso' : 'False')}
          </div>
        )}
        
        {q.type === 'mc' && q.options && (
          <div className="space-y-1">
            {q.options.map((opt, optIdx) => (
              <div key={optIdx} className={cn(
                "text-xs px-2 py-1 rounded",
                optIdx === q.correctIndex ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200" : "bg-muted"
              )}>
                {String.fromCharCode(65 + optIdx)}. {opt}
              </div>
            ))}
          </div>
        )}
        
        {q.type === 'ms' && q.optionsWithCorrect && (
          <div className="space-y-1">
            {q.optionsWithCorrect.map((opt, optIdx) => (
              <div key={optIdx} className={cn(
                "text-xs px-2 py-1 rounded",
                opt.correct ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200" : "bg-muted"
              )}>
                {String.fromCharCode(65 + optIdx)}. {opt.text} {opt.correct && '✓'}
              </div>
            ))}
          </div>
        )}
        
        {q.type === 'des' && (
          <div className="text-xs text-muted-foreground italic">
            {language === 'es' ? 'Pregunta de desarrollo' : 'Essay question'}
          </div>
        )}
      </div>
    )
  }
  
  return (
    <div className="space-y-4">
      {/* Hint sobre tipos soportados */}
      <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
        {translate('testsManualSupportedTypes')}
      </div>
      
      {/* Área de carga de archivo */}
      <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-fuchsia-400 transition-colors">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
          onChange={handleFileSelect}
          className="hidden"
          id="pdf-upload"
        />
        
        {!file ? (
          <label htmlFor="pdf-upload" className="cursor-pointer">
            <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium mb-1">{translate('testsManualSelectPDF')}</p>
            <p className="text-xs text-muted-foreground">{translate('testsManualNoFile')}</p>
          </label>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <FileText className="w-8 h-8 text-fuchsia-600" />
            <div className="text-left">
              <p className="text-sm font-medium truncate max-w-[200px]">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
            <button
              type="button"
              onClick={() => { setFile(null); setAnalysisResult(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
              className="p-1 hover:bg-muted rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      
      {/* Botón Analizar */}
      {file && !analysisResult && (
        <Button
          onClick={handleAnalyze}
          disabled={analyzing}
          className="w-full bg-fuchsia-600 hover:bg-fuchsia-700 text-white"
        >
          {analyzing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {translate('testsManualAnalyzing')}
            </>
          ) : (
            translate('testsManualAnalyzeBtn')
          )}
        </Button>
      )}
      
      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 dark:bg-red-900/20 p-3 rounded">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      
      {/* Resultado del análisis */}
      {analysisResult?.success && (
        <div className="space-y-4 border rounded-lg p-4 bg-green-50/50 dark:bg-green-900/10">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
            <CheckCircle className="w-5 h-5" />
            <span className="font-medium">{translate('testsManualAnalysisComplete')}</span>
          </div>
          
          {/* Resumen */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">{translate('testsManualDetectedQuestions')}:</span>
              <span className="ml-2 font-medium">{analysisResult.totalQuestions}</span>
            </div>
            {analysisResult.topic && (
              <div>
                <span className="text-muted-foreground">{translate('testsTopicLabel')}:</span>
                <span className="ml-2 font-medium">{analysisResult.topic}</span>
              </div>
            )}
          </div>
          
          {/* Desglose por tipo */}
          <div className="flex flex-wrap gap-2">
            {analysisResult.counts.tf > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
                {translate('testsTF')}: {analysisResult.counts.tf}
              </span>
            )}
            {analysisResult.counts.mc > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200">
                {translate('testsMC')}: {analysisResult.counts.mc}
              </span>
            )}
            {analysisResult.counts.ms > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200">
                {translate('testsMS')}: {analysisResult.counts.ms}
              </span>
            )}
            {analysisResult.counts.des > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200">
                {translate('testsDES')}: {analysisResult.counts.des}
              </span>
            )}
          </div>
          
          {/* Botón para ver preview */}
          <Button
            variant="outline"
            onClick={() => setPreviewOpen(true)}
            className="w-full border-fuchsia-200 text-fuchsia-800 hover:bg-fuchsia-100 dark:border-fuchsia-800 dark:text-fuchsia-200"
          >
            <Eye className="w-4 h-4 mr-2" />
            {translate('testsManualPreview')}
          </Button>
        </div>
      )}
      
      {/* Selección de Curso/Sección/Asignatura */}
      {analysisResult?.success && (
        <>
          {/* Curso/Sección */}
          <div className="space-y-2">
            <label className="block text-xs font-medium">{translate('testsCourseLabel')}</label>
            <div className="flex flex-wrap gap-2">
              {courseSectionChips.map((c) => {
                const selected = String(sectionId) === String(c.sectionId)
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => { setCourseId(String(c.courseId)); setSectionId(String(c.sectionId)); setSubjectId("") }}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs border transition-colors",
                      selected
                        ? "bg-fuchsia-600 text-white border-fuchsia-500"
                        : "bg-muted text-foreground/80 border-transparent hover:bg-muted/80"
                    )}
                    title={c.label}
                  >
                    {c.label}
                  </button>
                )
              })}
              {courseSectionChips.length === 0 && (
                <span className="text-xs text-muted-foreground">{translate('testsNoCourses')}</span>
              )}
            </div>
          </div>
          
          {/* Asignatura */}
          <div className="space-y-2">
            <label className="block text-xs font-medium">{translate('testsSubjectLabel')}</label>
            <div className="flex flex-wrap gap-2">
              {sectionId === "" && (
                <span className="text-xs text-muted-foreground">{translate('testsSelectCourseOrSectionHint')}</span>
              )}
              {sectionId !== "" && subjectChips.map((s) => {
                const selected = String(subjectId) === String(s.key)
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSubjectId(String(s.key))}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs border transition-colors",
                      selected
                        ? "bg-fuchsia-600 text-white border-fuchsia-500"
                        : "bg-muted text-foreground/80 border-transparent hover:bg-muted/80"
                    )}
                    title={s.label}
                  >
                    {s.label}
                  </button>
                )
              })}
              {sectionId && subjectChips.length === 0 && (
                <span className="text-xs text-muted-foreground">{translate('testsNoSubjectsForSection')}</span>
              )}
            </div>
          </div>
          
          {/* Tema (editable) */}
          <div>
            <label className="block text-xs font-medium mb-1">{translate('testsTopicLabel')}</label>
            <input
              className="w-full rounded border bg-background p-2 text-sm"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={translate('testsTopicPlaceholder')}
            />
          </div>
          
          {/* Ponderación y puntaje */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              <div className="font-medium">{translate('testsWeightsLabel')}</div>
              <div>
                TF {weights.tf}% · MC {weights.mc}% · MS {weights.ms}% · DES {weights.des}%
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{translate('testsTotalPointsLabel')}</label>
              <input
                type="number"
                min={1}
                step={1}
                className="w-28 rounded border bg-background p-2 text-sm"
                value={totalPoints}
                onChange={(e) => setTotalPoints(Math.max(1, Number(e.target.value || 0)))}
              />
            </div>
          </div>
          
          {/* Botón crear */}
          <Button
            onClick={handleCreateTest}
            disabled={!isValid}
            className={cn(
              "w-full",
              isValid
                ? "bg-fuchsia-600 hover:bg-fuchsia-700 text-white"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
          >
            {translate('testsManualConfirmCreate')}
          </Button>
        </>
      )}
      
      {/* Modal de Preview */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{translate('testsManualPreview')}</DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            {analysisResult?.title && (
              <h3 className="font-semibold mb-4">{analysisResult.title}</h3>
            )}
            {analysisResult?.questions.map((q, idx) => renderQuestionPreview(q, idx))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
