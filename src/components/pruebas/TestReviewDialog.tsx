"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Download, Upload } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/contexts/language-context"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { sendEmailOnNotification } from "@/services/email-notification.service"

type QuestionTF = { id: string; type: "tf"; text: string; answer: boolean; explanation?: string }
type QuestionMC = { id: string; type: "mc"; text: string; options: string[]; correctIndex: number }
type QuestionMS = { id: string; type: "ms"; text: string; options: Array<{ text: string; correct: boolean }> }
type QuestionDES = { id: string; type: "des"; prompt: string; sampleAnswer?: string }
type AnyQuestion = QuestionTF | QuestionMC | QuestionMS | QuestionDES

type Props = {
  open: boolean
  onOpenChange: (v: boolean) => void
  // Aceptamos el TestItem completo tal como se pasa desde PruebasPage
  test?: {
    id: string
    title: string
    description?: string
    questions?: AnyQuestion[]
    courseId?: string
    sectionId?: string
    subjectId?: string
    subjectName?: string
    topic?: string
    createdAt?: number
    // Campos para calcular puntos por pregunta
    counts?: { tf: number; mc: number; ms: number; des?: number }
    weights?: { tf: number; mc: number; ms: number; des: number }
    totalPoints?: number
  }
}

// 🆕 Calcular puntos por tipo de pregunta basándose en weights, totalPoints y counts
function calculatePointsPerQuestionType(test?: Props['test']): { tf: number; mc: number; ms: number; des: number } {
  // Preferir el conteo REAL según test.questions (más confiable que counts persistido)
  const questions = Array.isArray(test?.questions) ? test!.questions : []
  const countsFromQuestions = {
    tf: questions.filter((q: any) => q?.type === 'tf').length,
    mc: questions.filter((q: any) => q?.type === 'mc').length,
    ms: questions.filter((q: any) => q?.type === 'ms').length,
    des: questions.filter((q: any) => q?.type === 'des').length,
  }

  const fallbackCounts = test?.counts || { tf: 0, mc: 0, ms: 0, des: 0 }
  const counts = (countsFromQuestions.tf + countsFromQuestions.mc + countsFromQuestions.ms + countsFromQuestions.des) > 0
    ? countsFromQuestions
    : ({ tf: fallbackCounts.tf || 0, mc: fallbackCounts.mc || 0, ms: fallbackCounts.ms || 0, des: (fallbackCounts as any).des || 0 })

  const totalQuestions = (counts.tf || 0) + (counts.mc || 0) + (counts.ms || 0) + (counts.des || 0)
  const totalPoints = (typeof test?.totalPoints === 'number' && test?.totalPoints > 0)
    ? test.totalPoints
    : totalQuestions // fallback: 1 punto por pregunta si no se definió

  const activeTypes: Array<'tf'|'mc'|'ms'|'des'> = (['tf','mc','ms','des'] as const).filter((t) => (counts as any)[t] > 0)
  if (activeTypes.length === 0) return { tf: 0, mc: 0, ms: 0, des: 0 }

  // 🆕 Asegurar que weights tenga valores para todos los tipos activos
  const w = test?.weights || {}
  const safeWeights = {
    tf: Number((w as any).tf) || 0,
    mc: Number((w as any).mc) || 0,
    ms: Number((w as any).ms) || 0,
    des: Number((w as any).des) || 0,
  }
  
  // 🆕 Si hay preguntas de un tipo pero peso 0, asignar peso por defecto
  activeTypes.forEach((t) => {
    if (safeWeights[t] <= 0) {
      safeWeights[t] = 25 // Peso por defecto del 25%
      console.warn(`[OCR] ⚠️ Peso de ${t} era 0, usando valor por defecto: 25%`)
    }
  })
  
  let sumActive = activeTypes.reduce((acc, t) => acc + safeWeights[t], 0)
  
  // Si no hay pesos válidos, repartir equitativamente
  const normalized: Record<'tf'|'mc'|'ms'|'des', number> = { tf: 0, mc: 0, ms: 0, des: 0 }
  if (!sumActive || sumActive <= 0.0001) {
    const eq = 1 / activeTypes.length
    activeTypes.forEach((t) => { normalized[t] = eq })
  } else {
    activeTypes.forEach((t) => { normalized[t] = safeWeights[t] / sumActive })
  }

  const keys = ['tf','mc','ms','des'] as const
  const perTypePoints: Record<'tf'|'mc'|'ms'|'des', number> = { tf: 0, mc: 0, ms: 0, des: 0 }
  keys.forEach((t) => {
    perTypePoints[t] = totalPoints * normalized[t]
  })

  const result: Record<'tf'|'mc'|'ms'|'des', number> = { tf: 0, mc: 0, ms: 0, des: 0 }
  keys.forEach((t) => {
    const c = (counts as any)[t] || 0
    result[t] = c > 0 ? perTypePoints[t] / c : 0
  })
  
  console.log('[OCR] 📊 Puntos por pregunta calculados:', result)
  console.log('[OCR] 📊 TotalPoints:', totalPoints, 'Counts:', counts, 'SafeWeights:', safeWeights, 'Normalized:', normalized)
  return result
}

type OCRResult = {
  text: string
  confidence?: number
}

export default function TestReviewDialog({ open, onOpenChange, test }: Props) {
  const { translate } = useLanguage()
  const [file, setFile] = useState<File | null>(null)
  const [keyFile, setKeyFile] = useState<File | null>(null) // 🆕 Pauta / versión revisada (opcional)
  const [ocr, setOcr] = useState<OCRResult | null>(null)
  const [processing, setProcessing] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<{ current: number; total: number } | null>(null) // 🆕 Progreso OCR
  const [analysisProgress, setAnalysisProgress] = useState<{ step: string; percent: number } | null>(null)
  const [analyzingWithAI, setAnalyzingWithAI] = useState(false) // 🆕 Estado para análisis con IA
  const [aiAnalysis, setAiAnalysis] = useState<any>(null) // 🆕 Resultado del análisis con IA
  const [score, setScore] = useState<number | null>(null)
  const [editScore, setEditScore] = useState<number | null>(null)
  // Desglose por tipo: TF/MC/MS/DES
  const [breakdown, setBreakdown] = useState<{
    tf: { correct: number; total: number }
    mc: { correct: number; total: number }
    ms: { correct: number; total: number }
    des: { correct: number; total: number }
  } | null>(null)
  const [studentName, setStudentName] = useState<string>("")
  const [error, setError] = useState<string>("")
  const workerRef = useRef<any>(null)
  const [history, setHistory] = useState<ReviewRecord[]>([])
  const [verification, setVerification] = useState<{ sameDocument: boolean; coverage: number; studentFound: boolean; studentId?: string | null; hasAnswers?: boolean }>({ sameDocument: false, coverage: 0, studentFound: false, studentId: null, hasAnswers: true })
  const [students, setStudents] = useState<any[]>([])
  const [manualAssignId, setManualAssignId] = useState<string>("")
  // Edición directa en historial
  const [editHistTs, setEditHistTs] = useState<number | null>(null)
  const [editHistScore, setEditHistScore] = useState<number | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const keyUploadInputRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
  // Modal emergente para mensajes de estado (por requerimiento)
  const [statusModal, setStatusModal] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
  // 📝 NUEVO: Calificaciones preliminares del OCR (antes de guardar)
  const [preliminaryGrades, setPreliminaryGrades] = useState<Array<{
    studentName: string
    studentId: string | null
    studentInfo: any
    score: number // respuestas correctas
    pct: number // porcentaje
    pts: number // puntos
    saved: boolean // si ya fue guardada
    hasAnswers: boolean // 🆕 Si el estudiante realmente respondió
    detectedAnswers?: Array<{ questionNum: number; detected: string | null }> // 🆕 Respuestas detectadas
    questionsInOCR?: number // 🆕 Preguntas encontradas en OCR
  }>>([])
  const [savingGrades, setSavingGrades] = useState(false)
  // 🆕 Respuestas correctas de la pauta (para mostrar badges correctos)
  const [pautaAnswers, setPautaAnswers] = useState<Map<number, string | null>>(new Map())

  useEffect(() => {
    if (!open) {
      // reset al cerrar
      setFile(null)
      setKeyFile(null)
      setOcr(null)
      setProcessing(false)
      setOcrProgress(null) // 🆕 Reset progreso OCR
      setAnalyzingWithAI(false)
      setAiAnalysis(null)
      setScore(null)
  setEditScore(null)
      setStudentName("")
      setError("")
      setVerification({ sameDocument: false, coverage: 0, studentFound: false, studentId: null, hasAnswers: true })
    }
  }, [open])

  // Cargar historial de la prueba seleccionada
  useEffect(() => {
    if (!test?.id) return
    try {
      const key = getReviewKey(test.id)
      const raw = localStorage.getItem(key)
      if (raw) setHistory(JSON.parse(raw))
      else setHistory([])
    } catch (e) {
      console.warn('[TestReview] No se pudo cargar historial:', e)
      setHistory([])
    }
  }, [test?.id, open])

  // Utilidad: obtener estudiantes por sectionId desde múltiples fuentes
  const getStudentsForSection = useCallback((sectionId: string) => {
    const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]') as any[]
    const currentYear = new Date().getFullYear()
    
    // MÉTODO PRINCIPAL: Buscar en smart-student-students-{year}
    const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]') as any[]
    
    if (studentsForYear.length > 0) {
      // Filtrar estudiantes por sectionId
      const studentsInSection = studentsForYear.filter((s: any) => 
        String(s.sectionId) === String(sectionId)
      )
      
      if (studentsInSection.length > 0) {
        console.log(`📚 [TestReview] Encontrados ${studentsInSection.length} estudiantes en sección ${sectionId} desde students-${currentYear}`)
        studentsInSection.sort((a: any, b: any) => String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || '')))
        return studentsInSection
      }
    }
    
    // MÉTODO SECUNDARIO: Buscar en assignments (fallback)
    const assignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]') as any[]
    const ids = new Set(
      assignments
        .filter(a => String(a.sectionId) === String(sectionId))
        .map(a => String(a.studentId || a.studentUsername))
    )
    const list = users.filter(u => (u.role === 'student' || u.role === 'estudiante') && (ids.has(String(u.id)) || ids.has(String(u.username))))
    list.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')))
    
    console.log(`📚 [TestReview] Encontrados ${list.length} estudiantes en sección ${sectionId} desde assignments`)
    return list
  }, [])

  // Cargar estudiantes del curso/sección de la prueba
  useEffect(() => {
    try {
      if (!open) return
      if (!test?.sectionId) {
        setStudents([])
        return
      }
      const list = getStudentsForSection(String(test.sectionId))
      setStudents(list)
    } catch (e) {
      console.warn('[TestReview] No se pudo cargar estudiantes:', e)
      setStudents([])
    }
  }, [open, test?.sectionId, getStudentsForSection])

  const ensureWorker = useCallback(async () => {
    if (workerRef.current) return workerRef.current
    try {
      // Carga dinámica para reducir bundle inicial
      const Tesseract = await import("tesseract.js")
      workerRef.current = Tesseract
      return Tesseract
    } catch (e) {
      console.error("No se pudo cargar Tesseract.js", e)
      throw new Error("OCR no disponible")
    }
  }, [])

  // Cargar pdf.js desde CDN para evitar dependencias Node (canvas) en el bundle
  const ensurePdfJs = useCallback(async (): Promise<any> => {
    try {
      const w = window as any
      if (w.pdfjsLib) return w.pdfjsLib
      const loadScript = (src: string) => new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = src
        s.async = true
        s.onload = () => resolve()
        s.onerror = (err) => reject(err)
        document.head.appendChild(s)
      })
      // Versión fijada para consistencia con package.json
      const CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174'
      await loadScript(`${CDN_BASE}/pdf.min.js`)
      const pdfjsLib = (window as any).pdfjsLib
      if (pdfjsLib?.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN_BASE}/pdf.worker.min.js`
      }
      return pdfjsLib
    } catch (e) {
      console.error('No se pudo cargar pdf.js desde CDN', e)
      throw new Error('PDF.js no disponible')
    }
  }, [])

  const extractTextFromPDF = async (file: File): Promise<string> => {
    // Estrategia en dos pasos:
    // 1) Extraer texto nativo (si el PDF lo contiene)
    // 2) Si es escaneado (sin texto), renderizar páginas a <canvas> y pasar OCR con Tesseract
    try {
  const buf = await file.arrayBuffer()
  const pdfjs: any = await ensurePdfJs()
  const task = pdfjs.getDocument({ data: buf })
      const doc = await task.promise
      const maxPages = Math.min(3, doc.numPages)
      let textAll = ''
      for (let p = 1; p <= maxPages; p++) {
        const page = await doc.getPage(p)
        try {
          const textContent = await page.getTextContent()
          const pageText = (textContent.items || []).map((it: any) => (it.str || '')).join(' ').trim()
          if (pageText) textAll += (textAll ? '\n' : '') + pageText
        } catch {}
      }
      // Si ya obtuvimos suficiente texto, devolver
      if (normalize(textAll).length > 40) return textAll

      // Fallback OCR: renderizar páginas a canvas y correr Tesseract (navegador)
      try {
        const Tesseract = await ensureWorker()
        let ocrAll = ''
        for (let p = 1; p <= maxPages; p++) {
          const page = await doc.getPage(p)
          const viewport = page.getViewport({ scale: 1.8 })
          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          await page.render({ canvasContext: ctx, viewport }).promise
          const { data } = await Tesseract.recognize(canvas, 'spa+eng', {} as any)
          const pageOCR = (data?.text || '').trim()
          if (pageOCR) ocrAll += (ocrAll ? '\n' : '') + pageOCR
        }
        return ocrAll || '[PDF sin texto detectable tras OCR]'
      } catch (e2) {
        console.warn('[TestReview] PDF canvas OCR fallback error:', e2)
        return '[PDF detectado] No se pudo extraer texto automáticamente. Conviértelo a imagen (JPG/PNG) para un mejor OCR.'
      }
    } catch (e) {
      console.warn('[TestReview] PDF OCR fallback:', e)
      return '[PDF detectado] No se pudo extraer texto automáticamente. Conviértelo a imagen (JPG/PNG) para un mejor OCR.'
    }
  }

  // 📄 NUEVO: Extraer texto de CADA PÁGINA del PDF por separado (para PDFs de curso con múltiples estudiantes)
  const extractTextPerPage = async (file: File): Promise<Array<{ pageNum: number; text: string }>> => {
    const pages: Array<{ pageNum: number; text: string }> = []
    try {
      const buf = await file.arrayBuffer()
      const pdfjs: any = await ensurePdfJs()
      const task = pdfjs.getDocument({ data: buf })
      const doc = await task.promise
      const totalPages = doc.numPages
      
      for (let p = 1; p <= totalPages; p++) {
        const page = await doc.getPage(p)
        let pageText = ''
        
        // Intentar extraer texto nativo primero
        try {
          const textContent = await page.getTextContent()
          pageText = (textContent.items || []).map((it: any) => (it.str || '')).join(' ').trim()
        } catch {}
        
        // Si no hay texto nativo, usar OCR
        if (normalize(pageText).length < 30) {
          try {
            const Tesseract = await ensureWorker()
            const viewport = page.getViewport({ scale: 1.8 })
            const canvas = document.createElement('canvas')
            const ctx = canvas.getContext('2d')
            if (ctx) {
              canvas.width = Math.ceil(viewport.width)
              canvas.height = Math.ceil(viewport.height)
              await page.render({ canvasContext: ctx, viewport }).promise
              const { data } = await Tesseract.recognize(canvas, 'spa+eng', {} as any)
              pageText = (data?.text || '').trim()
            }
          } catch {}
        }
        
        pages.push({ pageNum: p, text: pageText })
      }
    } catch (e) {
      console.warn('[TestReview] Error extracting pages:', e)
    }
    return pages
  }

  // 🆕 Convertir PDF a imágenes (una por página) para análisis por visión
  const renderPdfToImages = async (file: File): Promise<Array<{ pageNum: number; dataUrl: string }>> => {
    const pages: Array<{ pageNum: number; dataUrl: string }> = []
    try {
      const buf = await file.arrayBuffer()
      const pdfjs: any = await ensurePdfJs()
      const task = pdfjs.getDocument({ data: buf })
      const doc = await task.promise
      const totalPages = doc.numPages

      for (let p = 1; p <= totalPages; p++) {
        const page = await doc.getPage(p)
        // Escala moderada + JPEG para reducir tamaño del payload
        const viewport = page.getViewport({ scale: 1.6 })
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvasContext: ctx, viewport }).promise
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
        pages.push({ pageNum: p, dataUrl })
      }
    } catch (e) {
      console.warn('[TestReview] Error renderPdfToImages:', e)
    }
    return pages
  }

  const runOCR = useCallback(async () => {
    if (!file) return
    setProcessing(true)
    setError("")
    try {
      const Tesseract = await ensureWorker()
      
      // 📄 DETECTAR SI ES PDF DE CURSO (múltiples estudiantes)
      const isCursoPDF = file.type === "application/pdf" && 
        (file.name.toLowerCase().includes('curso') || file.name.toLowerCase().includes('-curso'))
      
      if (isCursoPDF) {
        // ========== MODO CURSO: Agrupar páginas por estudiante y calificar cada prueba completa ==========
        console.log('[OCR] 📚 Detectado PDF de CURSO - procesando múltiples estudiantes...')
        const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0

        // 🆕 Intentar modo visión primero (mejor para PDFs escaneados y marcas)
        const pointsPerType = calculatePointsPerQuestionType(test)
        let usedVision = false

        try {
          // Si hay pauta/revisada, analizarla primero para obtener respuestas correctas reales
          let keyAnswerByQuestion = new Map<number, string | null>()
          let keyPointsByQuestion = new Map<number, number | null>()
          let keyQuestionsFound: number | null = null

          if (keyFile) {
            try {
              console.log('[PAUTA] 📋 Analizando pauta...')
              const keyImages = await renderPdfToImages(keyFile)
              if (keyImages.length > 0) {
                console.log(`[PAUTA] 📄 Pauta tiene ${keyImages.length} páginas`)
                const keyResp = await fetch('/api/analyze-ocr-vision', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    images: keyImages,
                    questionsCount: qTot,
                    title: `${test?.title || ''} (PAUTA)`,
                    topic: test?.topic || '',
                    subjectName: test?.subjectName || '',
                  }),
                })
                const keyData = await keyResp.json()
                console.log('[PAUTA] 🔍 Respuesta completa de análisis de pauta:', JSON.stringify(keyData, null, 2).substring(0, 2000))
                
                if (keyData?.success && keyData?.analysis?.pages && Array.isArray(keyData.analysis.pages)) {
                  keyQuestionsFound = typeof keyData.analysis.questionsFoundInDocument === 'number'
                    ? keyData.analysis.questionsFoundInDocument
                    : null

                  // Unir respuestas de todas las páginas de la pauta
                  for (const pg of keyData.analysis.pages) {
                    const answers = Array.isArray(pg?.answers) ? pg.answers : []
                    console.log(`[PAUTA] 📄 Página ${pg.pageNum || pg.pageIndex}: ${answers.length} respuestas`)
                    for (const a of answers) {
                      // 🔧 FIX: API usa "q" y "val", no "questionNum" y "detected"
                      const qn = Number(a?.q ?? a?.questionNum)
                      if (!Number.isFinite(qn) || qn <= 0) continue
                      const rawVal = a?.val ?? a?.detected
                      const det = rawVal === null || rawVal === undefined ? null : String(rawVal).trim()
                      const pts = (a?.points === null || a?.points === undefined) ? null : Number(a.points)
                      console.log(`[PAUTA] ✅ P${qn}: respuesta correcta = "${det}" (puntos: ${pts})`)
                      if (det) {
                        if (!keyAnswerByQuestion.get(qn)) keyAnswerByQuestion.set(qn, det)
                      } else {
                        if (!keyAnswerByQuestion.has(qn)) keyAnswerByQuestion.set(qn, null)
                      }
                      if (Number.isFinite(pts) && (pts as number) > 0) {
                        if (!keyPointsByQuestion.get(qn)) keyPointsByQuestion.set(qn, pts)
                      } else {
                        if (!keyPointsByQuestion.has(qn)) keyPointsByQuestion.set(qn, null)
                      }
                    }
                  }
                  
                  // Log final del mapa de respuestas correctas
                  console.log('[PAUTA] 📊 Resumen de respuestas correctas de la pauta:')
                  for (const [qn, val] of keyAnswerByQuestion.entries()) {
                    console.log(`  P${qn}: "${val}"`)
                  }
                } else {
                  console.warn('[PAUTA] ⚠️ No se obtuvieron respuestas válidas de la pauta')
                }
              }
            } catch (keyErr) {
              console.warn('[OCR/Vision] ⚠️ No se pudo analizar pauta; se continuará sin pauta:', keyErr)
              keyAnswerByQuestion = new Map()
              keyPointsByQuestion = new Map()
              keyQuestionsFound = null
            }
          }

          const imagePages = await renderPdfToImages(file)
          if (imagePages.length > 0) {
            // 🔍 PASO 1: Análisis inicial SOLO para identificar estudiantes (sin respuestas detalladas)
            console.log('[OCR/Vision] 📋 PASO 1: Identificando estudiantes en cada página...')
            const identResp = await fetch('/api/analyze-ocr-vision-identify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                images: imagePages,
              }),
            })

            const identData = await identResp.json()
            if (!identData?.success || !Array.isArray(identData?.pages)) {
              console.warn('[OCR/Vision] ⚠️ No se pudo identificar estudiantes, fallback a texto')
              throw new Error('No se pudo identificar estudiantes')
            }

            // Agrupar páginas por estudiante
            const groups = new Map<string, {
              studentName: string
              studentRut: string
              pageIndexes: number[]
            }>()

            for (let i = 0; i < identData.pages.length; i++) {
              const page = identData.pages[i]
              const name = String(page?.student?.name || '').trim()
              const rut = String(page?.student?.rut || '').replace(/[\.\s]/g, '').toUpperCase().trim()
              const key = rut || normalize(name) || `page-${i}`
              if (!groups.has(key)) {
                groups.set(key, { studentName: name, studentRut: rut, pageIndexes: [] })
              }
              groups.get(key)!.pageIndexes.push(i)
            }

            console.log(`[OCR/Vision] 📊 Identificados ${groups.size} estudiantes`)
            setOcrProgress({ current: 0, total: groups.size })

            // 📝 PASO 2: Procesar cada estudiante INDEPENDIENTEMENTE
            let processedCount = 0
            const preliminaryResults: Array<{
              studentName: string
              studentId: string | null
              studentInfo: any
              score: number
              pct: number
              pts: number
              saved: boolean
              hasAnswers: boolean
              detectedAnswers?: Array<{ questionNum: number; detected: string | null }>
              questionsInOCR?: number
            }> = []

            for (const [, group] of groups) {
              console.log(`[OCR/Vision] 📄 Procesando estudiante: ${group.studentName}...`)
              
              // Extraer solo las imágenes de este estudiante
              const studentImages = group.pageIndexes.map(idx => imagePages[idx])

              // Analizar solo las páginas de ESTE estudiante
              const visionResp = await fetch('/api/analyze-ocr-vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  images: studentImages,
                  questionsCount: qTot,
                  title: test?.title || '',
                  topic: test?.topic || '',
                  subjectName: test?.subjectName || '',
                }),
              })

              const visionData = await visionResp.json()
              
              // 🆕 DEBUG: Loguear respuesta completa de la API para diagnóstico
              console.log(`[OCR/Vision] 🔍 Respuesta API para ${group.studentName}:`, JSON.stringify(visionData, null, 2).substring(0, 3000))
              
              if (!visionData?.success || !Array.isArray(visionData?.analysis?.pages)) {
                console.warn(`[OCR/Vision] ⚠️ Error procesando estudiante ${group.studentName}`)
                processedCount++
                setOcrProgress({ current: processedCount, total: groups.size })
                continue
              }

              usedVision = true

              const docQuestionsFound = typeof visionData.analysis.questionsFoundInDocument === 'number'
                ? visionData.analysis.questionsFoundInDocument
                : null
              
              // 🆕 DEBUG: Loguear todas las respuestas que vienen de la API
              for (const pg of visionData.analysis.pages) {
                console.log(`[OCR/Vision] 📄 Página ${pg.pageNum || pg.pageIndex}: ${pg.answers?.length || 0} respuestas`)
                for (const ans of (pg.answers || [])) {
                  console.log(`[OCR/Vision]   → P${ans.q ?? ans.questionNum} (${ans.questionType ?? ans.type}): val="${ans.val ?? ans.detected}" | evidence="${ans.evidence}"`)
                }
              }

              // Procesar respuestas de este estudiante
              const studentName = group.studentName
              const studentInfo = findStudentInSection(studentName, test?.courseId, test?.sectionId)
              
              const answerByQuestion = new Map<number, string | null>()
              const pointsByQuestion = new Map<number, number | null>()
              let answeredCount = 0

              // Procesar todas las páginas de este estudiante
              for (const pg of visionData.analysis.pages) {
                const answers = Array.isArray(pg.answers) ? pg.answers : []
                for (const a of answers) {
                  // 🔧 FIX: API usa "q" y "val", no "questionNum" y "detected"
                  const qn = Number(a?.q ?? a?.questionNum)
                  if (!Number.isFinite(qn) || qn <= 0) continue
                  
                  // 🆕 VALIDACIÓN ANTI-ALUCINACIÓN: Solo si la evidencia CLARAMENTE indica vacío
                  const evidence = (a?.evidence || '').toUpperCase()
                  // Solo considerar vacío si:
                  // - Empieza con EMPTY
                  // - Contiene "SIN MARCA" o "SIN RESPUESTA"
                  // - Contiene "AMBOS VACÍOS" o "AMBOS PARÉNTESIS VACÍOS"
                  const isEmptyEvidence = evidence.startsWith('EMPTY') || 
                                          evidence.includes('SIN MARCA') ||
                                          evidence.includes('SIN RESPUESTA') ||
                                          evidence.includes('AMBOS VACÍOS') ||
                                          evidence.includes('AMBOS PARENTESIS VACIOS')
                  
                  // 🔧 FIX: API usa "val" no "detected"
                  const rawVal = a?.val ?? a?.detected
                  let detected = rawVal === null || rawVal === undefined ? null : String(rawVal)
                  
                  // Si la evidencia dice vacío, forzar null
                  if (isEmptyEvidence && detected !== null) {
                    console.warn(`[OMR/Vision] ⚠️ P${qn}: Evidencia="${a?.evidence}" indica VACÍO pero detected="${detected}" → FORZANDO null`)
                    detected = null
                  }
                  
                  const pts = (a?.points === null || a?.points === undefined) ? null : Number(a.points)
                  // 🔧 FIX: API usa "questionType" no "type"
                  const questionType = a?.questionType || a?.type || 'unknown'
                  
                  if (detected && String(detected).trim()) {
                    // 🆕 Log especial para desarrollo
                    if (questionType === 'des') {
                      console.log(`[OMR/Vision] 📝 P${qn} (DESARROLLO): texto="${detected.substring(0, 100)}..." | evidence="${evidence}"`)
                    } else {
                      console.log(`[OMR/Vision] ✏️ P${qn} (${questionType}): detected="${detected}" | evidence="${evidence}"`)
                    }
                    if (!answerByQuestion.get(qn)) {
                      answerByQuestion.set(qn, detected)
                    }
                  } else {
                    console.log(`[OMR/Vision] ⬜ P${qn} (${questionType}): SIN RESPUESTA | evidence="${evidence}"`)
                    if (!answerByQuestion.has(qn)) answerByQuestion.set(qn, null)
                  }

                  if (Number.isFinite(pts) && (pts as number) > 0) {
                    if (!pointsByQuestion.get(qn)) pointsByQuestion.set(qn, pts)
                  } else {
                    if (!pointsByQuestion.has(qn)) pointsByQuestion.set(qn, null)
                  }
                }
              }

              // 🆕 RE-CHEQUEO PARA PREGUNTAS DE DESARROLLO: SIEMPRE usar extractor especializado
              // El modelo de visión general suele fallar en extraer texto manuscrito correctamente
              const testQuestions = test?.questions || []
              console.log(`[OCR/Vision] 🔍 Verificando ${testQuestions.length} preguntas del test para re-chequeo de desarrollo...`)
              
              for (let qIdx = 0; qIdx < testQuestions.length; qIdx++) {
                const q = testQuestions[qIdx] as any
                const qNum = qIdx + 1
                if (q?.type === 'des') {
                  const currentVal = answerByQuestion.get(qNum)
                  console.log(`[OCR/Vision] 📋 P${qNum} es tipo DESARROLLO. Valor actual: "${currentVal || 'null'}"`)
                  
                  // SIEMPRE intentar extracción especializada para desarrollo (no confiar en visión general)
                  // Ejecutar extractor incluso si ya hay un valor, para mejorar la detección
                  const needsExtraction = !currentVal || currentVal === null || String(currentVal).trim() === '' || String(currentVal).trim().length < 5
                  
                  console.log(`[OCR/Vision] 🔍 P${qNum} DESARROLLO: needsExtraction=${needsExtraction}, studentImages=${studentImages.length}`)
                  
                  if (needsExtraction && studentImages.length > 0) {
                    console.log(`[OCR/Vision] 🔍 P${qNum} DESARROLLO sin respuesta válida. Usando extractor especializado en ${studentImages.length} páginas...`)
                    
                    // Intentar en CADA imagen del estudiante con el extractor especializado
                    for (let imgIdx = 0; imgIdx < studentImages.length; imgIdx++) {
                      const img = studentImages[imgIdx]
                      if (!img?.dataUrl) {
                        console.log(`[OCR/Vision] ⚠️ Página ${imgIdx + 1}: sin dataUrl`)
                        continue
                      }
                      
                      try {
                        console.log(`[OCR/Vision] 🔄 Extrayendo texto P${qNum} (DES) de página ${imgIdx + 1}/${studentImages.length}...`)
                        
                        // Usar endpoint especializado para desarrollo
                        const extractResp = await fetch('/api/extract-development-text', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            imageDataUrl: img.dataUrl,
                            questionNum: qNum,
                            questionText: q?.text || q?.prompt || '',
                          }),
                        })
                        const extractData = await extractResp.json()
                        
                        console.log(`[OCR/Vision] 📦 Respuesta extractor P${qNum}:`, JSON.stringify(extractData).substring(0, 200))
                        
                        if (extractData.success && extractData.extractedText && String(extractData.extractedText).trim().length > 2) {
                          console.log(`[OCR/Vision] ✅ Extractor P${qNum} (DES) página ${imgIdx + 1}: "${String(extractData.extractedText).substring(0, 50)}..."`)
                          answerByQuestion.set(qNum, String(extractData.extractedText))
                          break // Encontrado, salir del loop de páginas
                        } else {
                          console.log(`[OCR/Vision] ⬜ Extractor P${qNum} (DES) página ${imgIdx + 1}: sin texto válido (success=${extractData.success}, text="${extractData.extractedText}")`)
                        }
                      } catch (e) {
                        console.warn(`[OCR/Vision] ⚠️ Falló extractor P${qNum} (DES) página ${imgIdx + 1}:`, e)
                      }
                    }
                    
                    const finalVal = answerByQuestion.get(qNum)
                    if (!finalVal || String(finalVal).trim().length < 3) {
                      console.log(`[OCR/Vision] ⬜ P${qNum} (DES): sin respuesta detectada en ninguna de las ${studentImages.length} páginas`)
                    }
                  }
                }
              }
              // 🔁 RE-CHEQUEO AUTOMÁTICO (caso Sofía): si hay P1..P4 pero falta P5, pedir verificación focalizada
              // Esto ataca el caso donde Gemini omite una pregunta aunque exista una marca clara.
              const has1 = answerByQuestion.has(1)
              const has2 = answerByQuestion.has(2)
              const has3 = answerByQuestion.has(3)
              const has4 = answerByQuestion.has(4)
              const missing5 = !answerByQuestion.has(5) || answerByQuestion.get(5) === null
              const shouldHave5 = (qTot && qTot >= 5) || (docQuestionsFound && docQuestionsFound >= 5)

              if (has1 && has2 && has3 && has4 && missing5 && shouldHave5) {
                try {
                  const firstImg = Array.isArray(studentImages) && studentImages.length > 0 ? studentImages[0] : null
                  if (firstImg?.dataUrl) {
                    console.log(`[OCR/Vision] 🔁 Re-chequeo focalizado P5 para ${studentName}...`)
                    const base64Data = String(firstImg.dataUrl).split(',')[1] || ''
                    const recheckResp = await fetch('/api/analyze-ocr', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        imageBase64: base64Data,
                        questions: test?.questions || [],
                        pageNumber: firstImg.pageNum,
                        focusQuestionNums: [5],
                      }),
                    })
                    const recheckData = await recheckResp.json()
                    const reAnswers = recheckData?.analysis?.answers || recheckData?.answers || []
                    const hit = Array.isArray(reAnswers)
                      ? reAnswers.find((x: any) => Number(x?.q ?? x?.questionNum) === 5)
                      : null
                    const val = hit?.val ?? hit?.detected ?? null
                    if (val !== null && val !== undefined && String(val).trim() !== '') {
                      console.log(`[OCR/Vision] ✅ Re-chequeo P5: val="${val}" evidence="${hit?.evidence || ''}"`)
                      answerByQuestion.set(5, String(val))
                    } else {
                      console.log(`[OCR/Vision] ⬜ Re-chequeo P5: sigue sin respuesta (evidence="${hit?.evidence || ''}")`)
                      if (!answerByQuestion.has(5)) answerByQuestion.set(5, null)
                    }
                  }
                } catch (e) {
                  console.warn('[OCR/Vision] ⚠️ Falló re-chequeo focalizado P5:', e)
                }
              }
              
              // 🆕 Log estado final del map antes de contar
              console.log(`[OCR/Vision] 📊 Estado final answerByQuestion para ${group.studentName}:`)
              for (const [qn, val] of answerByQuestion.entries()) {
                const q = (test?.questions || [])[qn - 1] as any
                console.log(`  P${qn} (${q?.type || '?'}): ${val ? `"${String(val).substring(0, 30)}"` : 'null'}`)
              }
              
              for (const v of answerByQuestion.values()) if (v) answeredCount++
              const hasRealAnswers = answeredCount > 0
              console.log(`[OCR/Vision] 📊 answeredCount=${answeredCount}, hasRealAnswers=${hasRealAnswers}`)

              // Calificar: si hay pauta, comparar contra pauta; si no, comparar contra test.questions
              let studentCorrect = 0
              let studentPoints = 0
              const detectedAnswersList: Array<{ questionNum: number; detected: string | null }> = []

              const keyMaxQ = keyAnswerByQuestion.size > 0
                ? Math.max(...Array.from(keyAnswerByQuestion.keys()))
                : 0
              const maxQ = keyMaxQ || (qTot > 0 ? qTot : (docQuestionsFound || 0))
              const denom = maxQ > 0 ? maxQ : (docQuestionsFound || answerByQuestion.size || 1)

              // 🔧 FIX: Asegurar que TODAS las preguntas del test estén en answerByQuestion
              // Esto garantiza que las preguntas de desarrollo aparezcan aunque Gemini no las detecte
              const testQuestionsArray = test?.questions || []
              for (let qIdx = 0; qIdx < testQuestionsArray.length; qIdx++) {
                const qNum = qIdx + 1
                if (!answerByQuestion.has(qNum)) {
                  console.log(`[OCR/Vision] ⚠️ P${qNum} no fue detectada por Gemini, agregando como null`)
                  answerByQuestion.set(qNum, null)
                }
              }

              // Armar lista de detectadas (TODAS las preguntas del test)
              console.log(`[CALIFICAR] 🔎 Respuestas detectadas del estudiante "${studentName}":`)
              for (const [qn, det] of answerByQuestion.entries()) {
                console.log(`  P${qn}: "${det}"`)
                detectedAnswersList.push({ questionNum: qn, detected: det })
              }
              detectedAnswersList.sort((a, b) => a.questionNum - b.questionNum)

              // Total posible de puntos: si la pauta trae puntos, sumarlos; si no, usar totalPoints del test
              let totalPossiblePoints = 0
              if (keyPointsByQuestion.size > 0) {
                for (let qNum = 1; qNum <= denom; qNum++) {
                  const kp = keyPointsByQuestion.get(qNum)
                  if (typeof kp === 'number' && Number.isFinite(kp) && kp > 0) totalPossiblePoints += kp
                }
              }
              if (totalPossiblePoints <= 0.0001) {
                const qTotLocal = Array.isArray(test?.questions) ? test!.questions.length : denom
                const totalPtsLocal = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTotLocal
                totalPossiblePoints = typeof totalPtsLocal === 'number' && totalPtsLocal > 0 ? totalPtsLocal : 0
              }

              // 📊 DEBUG: Mostrar estado de pauta y preguntas del test
              console.log(`[CALIFICAR] 🧑‍🎓 CALIFICANDO: ${studentName}`)
              console.log(`[CALIFICAR] 📋 Preguntas a evaluar: ${denom}`)
              console.log(`[CALIFICAR] 🔑 Pauta cargada: ${keyAnswerByQuestion.size > 0 ? 'SÍ' : 'NO'}`)
              if (keyAnswerByQuestion.size > 0) {
                console.log(`[CALIFICAR] 📊 Respuestas de pauta:`, Object.fromEntries(keyAnswerByQuestion.entries()))
              }
              console.log(`[CALIFICAR] 📖 Preguntas del test:`, (test?.questions || []).map((q: any, i: number) => ({
                num: i + 1,
                type: q?.type,
                answer: q?.type === 'tf' ? (q?.answer ? 'V (true)' : 'F (false)') : q?.correctIndex !== undefined ? String.fromCharCode(65 + q.correctIndex) : 'N/A'
              })))
              
              for (let qNum = 1; qNum <= denom; qNum++) {
                const detected = answerByQuestion.get(qNum)
                const qDef = (test?.questions || [])[qNum - 1] as any
                
                // 🆕 Log para depuración de desarrollo
                if (qDef?.type === 'des') {
                  console.log(`[Vision] 🔍 P${qNum} (DES): detected="${detected}" len=${detected?.length || 0}`)
                }
                
                if (!detected) {
                  console.log(`[CALIFICAR] ⬜ P${qNum}: sin respuesta del estudiante`)
                  continue
                }

                // Puntos: preferir pauta -> PDF estudiante -> fallback por tipo
                const kp = keyPointsByQuestion.get(qNum)
                const sp = pointsByQuestion.get(qNum)
                const q = qDef
                const fallbackPts = q?.type === 'tf' ? pointsPerType.tf
                  : q?.type === 'mc' ? pointsPerType.mc
                  : q?.type === 'ms' ? pointsPerType.ms
                  : pointsPerType.des
                const questionPts = (typeof kp === 'number' && kp > 0) ? kp
                  : (typeof sp === 'number' && sp > 0) ? sp
                  : fallbackPts

                if (keyAnswerByQuestion.size > 0) {
                  const correct = keyAnswerByQuestion.get(qNum)
                  const studentAnswer = String(detected).trim().toUpperCase()
                  const correctAnswer = String(correct || '').trim().toUpperCase()
                  const isCorrect = correct && studentAnswer === correctAnswer
                  
                  console.log(`[CALIFICAR] 📝 P${qNum}: estudiante="${studentAnswer}" vs pauta="${correctAnswer}" → ${isCorrect ? '✅ CORRECTA' : '❌ INCORRECTA'}`)
                  
                  if (isCorrect) {
                    studentCorrect++
                    studentPoints += questionPts
                  }
                  continue
                }

                // Sin pauta: usar claves del test
                if (!q) {
                  console.log(`[CALIFICAR] ⚠️ P${qNum}: pregunta NO DEFINIDA en el test (q es ${typeof q})`)
                  continue
                }
                if (q?.type === 'tf') {
                  const correct = q.answer ? 'V' : 'F'
                  const isCorrect = String(detected).toUpperCase() === correct
                  console.log(`[CALIFICAR] 📝 P${qNum} (tf): estudiante="${String(detected).toUpperCase()}" vs test="${correct}" (q.answer=${q.answer}) → ${isCorrect ? '✅' : '❌'}`)
                  if (isCorrect) {
                    studentCorrect++
                    studentPoints += questionPts
                  }
                } else if (q?.type === 'mc') {
                  const correct = String.fromCharCode(65 + q.correctIndex)
                  const isCorrect = String(detected).toUpperCase() === correct
                  console.log(`[CALIFICAR] 📝 P${qNum} (mc): estudiante="${String(detected).toUpperCase()}" vs test="${correct}" → ${isCorrect ? '✅' : '❌'}`)
                  if (isCorrect) {
                    studentCorrect++
                    studentPoints += questionPts
                  }
                } else if (q?.type === 'ms') {
                  const correctLabels = (q.options || []).map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '').filter(Boolean)
                  const detectedLabels = String(detected).split(',').map((l: string) => l.trim().toUpperCase()).filter(Boolean)
                  if (correctLabels.length === detectedLabels.length && correctLabels.every((l: string) => detectedLabels.includes(l))) {
                    studentCorrect++
                    studentPoints += questionPts
                  }
                } else if (q?.type === 'des') {
                  // 🆕 Preguntas de desarrollo: si hay texto significativo, contar como respondida
                  const detectedText = String(detected).trim()
                  if (detectedText && detectedText.length > 5) {
                    studentCorrect++
                    studentPoints += questionPts
                    console.log(`[Vision] 📝 P${qNum} DESARROLLO: respuesta detectada (+${questionPts.toFixed(2)} pts)`)
                  }
                }
              }

              const pts = Math.round(studentPoints)
              const pct = totalPossiblePoints > 0 ? Math.round((pts / totalPossiblePoints) * 100) : (denom > 0 ? Math.round((studentCorrect / denom) * 100) : 0)

              preliminaryResults.push({
                studentName,
                studentId: studentInfo?.id || studentInfo?.username || null,
                studentInfo,
                score: studentCorrect,
                pct,
                pts,
                saved: false,
                hasAnswers: hasRealAnswers,
                detectedAnswers: detectedAnswersList,
                questionsInOCR: denom,
              })

              processedCount++
              setOcrProgress({ current: processedCount, total: groups.size })
            }

            setPreliminaryGrades(preliminaryResults)
            setOcrProgress(null)

            if (processedCount > 0) {
              const resumenTexto = preliminaryResults
                .map(r => `• ${r.studentName}: ${r.hasAnswers ? `${r.pts} pts (${r.pct}%)` : '❌ Sin respuestas detectadas'}`)
                .join('\n')

              setStudentName('')
              setScore(null)
              setBreakdown(null)
              setOcr({ text: `📋 PDF de Curso procesado (VISIÓN${keyAnswerByQuestion.size > 0 ? ' + PAUTA' : ''}): ${processedCount} estudiantes detectados.\n\n${resumenTexto}\n\n⚠️ Calificaciones PRELIMINARES. Presiona "Guardar Calificaciones" para confirmar y enviar notificaciones.` })
              setVerification({ sameDocument: true, coverage: 0.9, studentFound: true, studentId: null, hasAnswers: true })
              setEditScore(null)
            } else {
              setError('No se pudieron procesar estudiantes del PDF (visión).')
            }

            return
          }
        } catch (visionErr) {
          console.warn('[OCR/Vision] ⚠️ Error usando visión, fallback a texto:', visionErr)
        }

        if (!usedVision) {
          // ===== Fallback: flujo anterior (texto/OCR + IA texto) =====
          const pages = await extractTextPerPage(file)

          if (pages.length === 0) {
            setError('No se pudieron extraer páginas del PDF')
            return
          }
        
        // 🔍 PASO 1: Identificar estudiantes únicos por nombre o RUT en ENCABEZADO de cada página
        type PageWithStudent = { pageNum: number; text: string; studentName: string; studentRut: string; studentInfo: any }
        const pagesWithStudents: PageWithStudent[] = []
        
        // Función para extraer nombre y RUT del encabezado del PDF
        const extractFromHeader = (text: string): { name: string; rut: string } => {
          // Buscar en las primeras 15 líneas (encabezado típico)
          const lines = text.split('\n').slice(0, 15)
          const headerText = lines.join('\n')
          
          // Buscar RUT con varios formatos: "RUT: 10000000-8", "10.000.000-8", etc.
          const rutPatterns = [
            /RUT[:\s]*(\d{1,2}[\.\s]?\d{3}[\.\s]?\d{3}[-\s]?[\dkK])/i,
            /(\d{1,2}[\.\s]?\d{3}[\.\s]?\d{3}[-\s]?[\dkK])/i
          ]
          let detectedRut = ''
          for (const pattern of rutPatterns) {
            const match = headerText.match(pattern)
            if (match) {
              detectedRut = match[1].replace(/[\.\s]/g, '').toUpperCase()
              break
            }
          }
          
          // Buscar nombre después de "NOMBRE DEL ESTUDIANTE:" o similar
          const namePatterns = [
            /NOMBRE\s*(?:DEL)?\s*(?:ESTUDIANTE)?[:\s]+([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?)(?:\s*_|$|\n)/i,
            /ESTUDIANTE[:\s]+([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?)(?:\s*[-–]|\s*\d|$|\n)/i,
          ]
          let detectedName = ''
          for (const pattern of namePatterns) {
            const match = headerText.match(pattern)
            if (match) {
              detectedName = match[1].trim()
              // Limpiar caracteres extraños
              detectedName = detectedName.replace(/[_\-–]+$/, '').trim()
              if (detectedName.length > 3) break
            }
          }
          
          return { name: detectedName, rut: detectedRut }
        }
        
        for (const { pageNum, text } of pages) {
          if (!text || normalize(text).length < 20) continue
          
          // Extraer nombre y RUT desde el ENCABEZADO
          const { name: headerName, rut: headerRut } = extractFromHeader(text)
          
          let guessedName = headerName
          let detectedRut = headerRut
          
          // Si no encontramos nombre en el encabezado, usar fallback
          if (!guessedName || !isLikelyPersonName(guessedName)) {
            guessedName = guessStudentName(text, students)
            if (!isLikelyPersonName(guessedName)) {
              if (Array.isArray(students) && students.length > 0) {
                let best: { name: string, s: number } | null = null
                for (const s of students) {
                  const nm = String(s.displayName || s.username || '').trim()
                  if (!nm) continue
                  const sc = similarityByTokens(nm, text)
                  if (!best || sc > best.s) best = { name: nm, s: sc }
                }
                if (best && best.s >= 0.30) guessedName = best.name
              }
            }
          }
          
          // Buscar estudiante en la sección (por RUT primero, luego por nombre)
          let studentInfo: any = null
          if (detectedRut) {
            studentInfo = students.find((s: any) => {
              const sRut = String(s.rut || '').replace(/[\.\s-]/g, '').toUpperCase()
              const cleanDetectedRut = detectedRut.replace(/[\.\s-]/g, '').toUpperCase()
              return sRut && cleanDetectedRut && sRut === cleanDetectedRut
            }) || null
            if (studentInfo) {
              guessedName = studentInfo.displayName || studentInfo.username || guessedName
            }
          }
          if (!studentInfo && guessedName) {
            studentInfo = findStudentInSection(guessedName, test?.courseId, test?.sectionId)
          }
          
          console.log(`[OCR] Página ${pageNum}: Nombre="${guessedName}" RUT="${detectedRut}" ${studentInfo ? '✅ Encontrado' : '❌ No encontrado'}`)
          
          pagesWithStudents.push({
            pageNum,
            text,
            studentName: guessedName || '',
            studentRut: detectedRut,
            studentInfo
          })
        }
        
        // 🔍 PASO 2: Agrupar páginas por estudiante (usando RUT o nombre como clave)
        const studentGroups = new Map<string, { pages: PageWithStudent[]; studentInfo: any; studentName: string }>()
        
        for (const page of pagesWithStudents) {
          // Usar RUT como clave principal, si no hay RUT usar nombre normalizado
          const key = page.studentRut || normalize(page.studentName)
          if (!key) continue
          
          if (!studentGroups.has(key)) {
            studentGroups.set(key, {
              pages: [],
              studentInfo: page.studentInfo,
              studentName: page.studentName
            })
          }
          studentGroups.get(key)!.pages.push(page)
        }
        
        const numStudents = studentGroups.size
        const totalPages = pagesWithStudents.length
        const pagesPerStudent = numStudents > 0 ? Math.round(totalPages / numStudents) : 0
        
        console.log(`[OCR] 📊 Detectados ${numStudents} estudiantes, ${totalPages} páginas total (≈${pagesPerStudent} páginas/estudiante)`)
        
        // 🆕 Calcular puntos por tipo de pregunta ANTES de procesar estudiantes
        const pointsPerType = calculatePointsPerQuestionType(test)
        
        // 🆕 Inicializar progreso
        setOcrProgress({ current: 0, total: numStudents })
        
        // 🔍 PASO 3: Calificar cada estudiante usando IA (más preciso que OCR manual)
        let processedCount = 0
        const preliminaryResults: Array<{
          studentName: string
          studentId: string | null
          studentInfo: any
          score: number
          pct: number
          pts: number
          saved: boolean
          hasAnswers: boolean // 🆕 Si realmente respondió
          detectedAnswers?: Array<{ questionNum: number; detected: string | null }>
          questionsInOCR?: number
        }> = []
        
        // 🆕 PASO 2.5: Renderizar PDF a imágenes (una vez para todos los estudiantes)
        const pdfImages = await renderPdfToImages(file)
        console.log(`[OCR/Vision] 🖼️ Renderizadas ${pdfImages.length} imágenes del PDF`)
        
        for (const [key, group] of studentGroups) {
          const { pages: studentPages, studentInfo, studentName } = group
          
          console.log(`[OCR] 📝 Calificando ${studentName} (${studentPages.length} páginas) usando VISIÓN...`)
          
          // 🤖 USAR GEMINI VISION para analizar cada página del estudiante
          let studentCorrect = 0
          let studentPts = 0
          let hasRealAnswers = false
          let detectedAnswersList: Array<{ questionNum: number; detected: string | null }> = []
          let questionsFoundInOCR = 0
          
          try {
            // 🆕 Analizar cada página del estudiante con VISIÓN
            for (const studentPage of studentPages) {
              const pdfImage = pdfImages.find(img => img.pageNum === studentPage.pageNum)
              if (!pdfImage) {
                console.warn(`[OCR/Vision] ⚠️ No se encontró imagen para página ${studentPage.pageNum}`)
                continue
              }
              
              // Extraer base64 sin el prefijo data:image/jpeg;base64,
              const base64Data = pdfImage.dataUrl.split(',')[1]
              
              const aiResponse = await fetch('/api/analyze-ocr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  imageBase64: base64Data,
                  questions: test?.questions || [],
                  studentName: studentName,
                  expectedStudents: students,
                  pageNumber: studentPage.pageNum
                })
              })
              
              const aiData = await aiResponse.json()
              console.log(`[OMR] 🤖 Respuesta IA para ${studentName} página ${studentPage.pageNum}:`, JSON.stringify(aiData, null, 2))
              
              // 🆕 LOG CRUDO - Ver exactamente qué devuelve la IA para cada pregunta
              if (aiData.success && aiData.analysis?.answers) {
                console.log(`[OMR] 📋 RESPUESTAS CRUDAS para ${studentName}:`)
                aiData.analysis.answers.forEach((a: any, i: number) => {
                  console.log(`[OMR]   RAW[${i}]: q=${a.q ?? a.questionNum}, val="${a.val ?? a.detected}", evidence="${a.evidence}"`)
                })
              }
              
              if (aiData.success && aiData.analysis) {
                const analysis = aiData.analysis
                const pageQuestionsFound = analysis.questionsFound || analysis.questionsFoundInOCR || 0
                questionsFoundInOCR += pageQuestionsFound
                
                // 🆕 LOG DETALLADO CON EVIDENCIA VISUAL
                // Soporta formato con evidence (nuevo) y formatos legacy
                const answers = analysis.answers || []
                console.log(`[OMR] 📊 ${studentName} p${studentPage.pageNum}: IA encontró ${pageQuestionsFound} preguntas totales`)
                console.log(`[OMR] 🔍 Confianza: ${analysis.confidence || analysis.confidenceLevel || 'N/A'}`)
                
                answers.forEach((ans: any, idx: number) => {
                  const qNum = ans.q ?? ans.questionNum ?? idx + 1
                  const val = ans.val ?? ans.detected ?? null
                  const evidence = (ans.evidence || ans.visualEvidence || 'sin evidencia').toUpperCase()
                  
                  // 🆕 VALIDACIÓN: Solo si la evidencia CLARAMENTE indica vacío
                  const isEmptyEvidence = evidence.startsWith('EMPTY') || 
                                          evidence.includes('SIN MARCA') ||
                                          evidence.includes('SIN RESPUESTA') ||
                                          evidence.includes('AMBOS VACÍOS') ||
                                          evidence.includes('AMBOS PARENTESIS VACIOS')
                  
                  if (isEmptyEvidence && val !== null) {
                    console.warn(`[OMR] ⚠️ P${qNum}: Evidencia indica VACÍO pero val="${val}" - CORRIGIENDO a null`)
                  }
                  
                  const finalVal = isEmptyEvidence ? null : val
                  const status = finalVal ? '✏️ RESPONDIDA' : '⬜ EN BLANCO'
                  console.log(`[OMR]   → P${qNum}: ${status} | Evidencia: "${ans.evidence || 'sin evidencia'}" | val="${finalVal || 'null'}"`)
                  
                  // Actualizar el valor en el array original para que el conteo sea correcto
                  if (ans.val !== undefined) ans.val = finalVal
                  if (ans.detected !== undefined) ans.detected = finalVal
                })
                
                // Determinar si tiene respuestas en esta página (usando valores corregidos)
                const answersWithResponse = answers.filter((a: any) => {
                  const val = a.val ?? a.detected ?? null
                  const evidence = (a.evidence || a.visualEvidence || '').toUpperCase()
                  const isEmptyEvidence = evidence.startsWith('EMPTY') || 
                                          evidence.includes('SIN MARCA') ||
                                          evidence.includes('SIN RESPUESTA') ||
                                          evidence.includes('AMBOS VACÍOS') ||
                                          evidence.includes('AMBOS PARENTESIS VACIOS')
                  // Si la evidencia dice vacío, NO contar como respondida
                  if (isEmptyEvidence) return false
                  return val !== null && val !== undefined && val !== ''
                })
                if (answersWithResponse.length > 0) {
                  hasRealAnswers = true
                }
                
                console.log(`[OMR] 📝 ${studentName} p${studentPage.pageNum}: ${answersWithResponse.length}/${pageQuestionsFound} preguntas respondidas (validadas)`)
                
                // Acumular respuestas detectadas de todas las páginas
                // 🆕 Soporta formato con evidence y validación anti-alucinación
                if (analysis.answers && Array.isArray(analysis.answers)) {
                  for (const ans of analysis.answers) {
                    const qNum = ans.q ?? ans.questionNum ?? 0
                    let val = ans.val ?? ans.detected ?? null
                    const evidence = ans.evidence || ans.visualEvidence || ''
                    
                    if (qNum === 0) continue
                    
                    // 🆕 VALIDACIÓN ANTI-ALUCINACIÓN: Solo si la evidencia CLARAMENTE indica vacío
                    const evidenceUpper = evidence.toUpperCase()
                    const isEmptyEvidence = evidenceUpper.startsWith('EMPTY') || 
                                            evidenceUpper.includes('SIN MARCA') ||
                                            evidenceUpper.includes('SIN RESPUESTA') ||
                                            evidenceUpper.includes('AMBOS VACÍOS') ||
                                            evidenceUpper.includes('AMBOS PARENTESIS VACIOS')
                    if (isEmptyEvidence) {
                      val = null
                    }
                    
                    // Buscar si ya existe esta pregunta (en caso de páginas múltiples)
                    const existingIdx = detectedAnswersList.findIndex(d => d.questionNum === qNum)
                    if (existingIdx >= 0) {
                      // Si ya existe y tiene respuesta, mantener la primera detectada
                      if (!detectedAnswersList[existingIdx].detected && val) {
                        detectedAnswersList[existingIdx].detected = val
                      }
                    } else {
                      detectedAnswersList.push({
                        questionNum: qNum,
                        detected: val
                      })
                    }
                  }
                }
                
                // Contar respuestas correctas y sumar puntos de esta página
                // 🆕 Con validación de evidencia anti-alucinación
                if (analysis.answers && Array.isArray(analysis.answers)) {
                  for (const rawAnswer of analysis.answers) {
                    const qNum = rawAnswer.q ?? rawAnswer.questionNum ?? 0
                    let val = rawAnswer.val ?? rawAnswer.detected ?? null
                    const evidence = rawAnswer.evidence || rawAnswer.visualEvidence || ''
                    
                    // 🆕 VALIDACIÓN: Solo si la evidencia CLARAMENTE indica vacío
                    const evidenceUpper2 = evidence.toUpperCase()
                    const isEmptyEvidence2 = evidenceUpper2.startsWith('EMPTY') || 
                                            evidenceUpper2.includes('SIN MARCA') ||
                                            evidenceUpper2.includes('SIN RESPUESTA') ||
                                            evidenceUpper2.includes('AMBOS VACÍOS') ||
                                            evidenceUpper2.includes('AMBOS PARENTESIS VACIOS')
                    if (isEmptyEvidence2) {
                      console.log(`[OMR] 🚫 ${studentName} P${qNum}: Evidencia="${evidence}" → FORZANDO null (anti-alucinación)`)
                      val = null
                    }
                    
                    // VALIDACIÓN ESTRICTA: Solo procesar si val NO es null/undefined/vacío
                    if (!val || (typeof val === 'string' && val.trim() === '')) {
                      console.log(`[OMR] ⏭️ ${studentName} P${qNum}: sin respuesta (val=${val})`)
                      continue
                    }
                    
                    const qIndex = qNum - 1
                    const q = (test?.questions || [])[qIndex] as any
                    if (!q) {
                      console.warn(`[OMR] ⚠️ ${studentName} P${qNum}: pregunta no existe en la prueba (qIndex=${qIndex}, total=${test?.questions?.length})`)
                      continue
                    }
                    
                    // 🆕 Log del tipo de pregunta para debug
                    console.log(`[OMR] 🔍 ${studentName} P${qNum}: tipo=${q.type}, val="${typeof val === 'string' ? val.substring(0, 30) : val}"`)
                    
                    // 🆕 DETECCIÓN INTELIGENTE: Si la respuesta es texto largo, tratarla como desarrollo
                    // Esto corrige casos donde el tipo guardado no coincide con la respuesta real
                    const valStr = typeof val === 'string' ? val.trim() : ''
                    const isLongText = valStr.length > 20
                    const isNotStandardAnswer = !['V', 'F', 'A', 'B', 'C', 'D', 'E', 'A,B', 'A,C', 'A,D', 'B,C', 'B,D', 'C,D', 'A,B,C', 'A,B,D', 'A,C,D', 'B,C,D', 'A,B,C,D'].includes(valStr.toUpperCase())
                    const shouldTreatAsDevelopment = isLongText && isNotStandardAnswer
                    
                    // Determinar el tipo efectivo de la pregunta
                    const effectiveType = shouldTreatAsDevelopment ? 'des' : q.type
                    if (shouldTreatAsDevelopment && q.type !== 'des') {
                      console.log(`[OMR] 🔄 ${studentName} P${qNum}: Respuesta larga detectada, tratando como DESARROLLO (tipo original: ${q.type})`)
                    }
                    
                    // Obtener puntos según el TIPO de pregunta
                    const questionPoints = effectiveType === 'tf' ? pointsPerType.tf
                      : effectiveType === 'mc' ? pointsPerType.mc
                      : effectiveType === 'ms' ? pointsPerType.ms
                      : pointsPerType.des
                    
                    if (effectiveType === 'tf') {
                      const correct = q.answer ? 'V' : 'F'
                      const detected = typeof val === 'string' ? val.toUpperCase().trim() : ''
                      
                      // 🆕 VALIDACIÓN: Solo V o F son válidas
                      if (detected !== 'V' && detected !== 'F') {
                        console.warn(`[OMR] ⚠️ ${studentName} P${qNum}: respuesta inválida "${detected}" (esperaba V o F)`)
                        continue
                      }
                      
                      if (detected === correct) {
                        studentCorrect++
                        studentPts += questionPoints
                        console.log(`[OMR] ✅ ${studentName} P${qNum}: ${detected} = correcta (+${questionPoints.toFixed(2)} pts)`)
                      } else {
                        console.log(`[OMR] ❌ ${studentName} P${qNum}: ${detected} != ${correct} (incorrecta, 0 pts)`)
                      }
                    } else if (effectiveType === 'mc') {
                      const correct = String.fromCharCode(65 + q.correctIndex)
                      const detected = typeof val === 'string' ? val.toUpperCase().trim() : ''
                      
                      if (detected === correct) {
                        studentCorrect++
                        studentPts += questionPoints
                        console.log(`[OMR] ✅ ${studentName} P${qNum}: ${detected} = correcta (+${questionPoints.toFixed(2)} pts)`)
                      } else {
                        console.log(`[OMR] ❌ ${studentName} P${qNum}: ${detected} != ${correct} (incorrecta, 0 pts)`)
                      }
                    } else if (effectiveType === 'ms') {
                      const correctLabels = q.options.map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '').filter(Boolean)
                      const detectedLabels = (val || '').split(',').map((l: string) => l.trim().toUpperCase()).filter(Boolean)
                      if (correctLabels.length === detectedLabels.length && correctLabels.every((l: string) => detectedLabels.includes(l))) {
                        studentCorrect++
                        studentPts += questionPoints
                        console.log(`[OMR] ✅ ${studentName} P${qNum}: correcta (+${questionPoints.toFixed(2)} pts)`)
                      } else {
                        console.log(`[OMR] ❌ ${studentName} P${qNum}: incorrecta (0 pts)`)
                      }
                    } else if (effectiveType === 'des') {
                      // Preguntas de desarrollo: verificar si hay respuesta escrita
                      const detectedText = typeof val === 'string' ? val.trim() : ''
                      console.log(`[OMR] 📋 ${studentName} P${qNum} (des): detectedText.length=${detectedText.length}, questionPoints=${questionPoints}`)
                      if (detectedText && detectedText.length > 5) {
                        // Si hay texto significativo, contar como respondida
                        // La evaluación real debería ser manual o con IA más avanzada
                        // Por ahora, asignamos puntos completos por responder (el profesor puede ajustar)
                        studentCorrect++
                        studentPts += questionPoints
                        console.log(`[OMR] 📝 ${studentName} P${qNum}: respuesta de desarrollo detectada (+${questionPoints.toFixed(2)} pts preliminares)`)
                        console.log(`[OMR]    Texto: "${detectedText.substring(0, 100)}..."`)
                      } else {
                        console.log(`[OMR] ⬜ ${studentName} P${qNum}: sin respuesta de desarrollo (texto muy corto: "${detectedText}")`)
                      }
                    }
                  }
                }
              }
            }
            
            // Redondear puntos finales del estudiante
            studentPts = Math.round(studentPts)
            console.log(`[OMR] 🎯 ${studentName}: ${studentCorrect}/${questionsFoundInOCR} correctas = ${studentPts} pts`)
            
          } catch (aiErr) {
            console.warn(`[OMR] ⚠️ Error en IA para ${studentName}, usando fallback:`, aiErr)
            // Fallback al método tradicional con texto
            const combinedText = studentPages.map(p => p.text).join('\n\n--- Página siguiente ---\n\n')
            const graded = autoGrade(combinedText, test?.questions || [])
            studentCorrect = graded.correct
            hasRealAnswers = graded.evidence > 0
            // Calcular puntos en fallback usando puntos por tipo
            let fallbackPoints = 0
            for (let i = 0; i < studentCorrect && i < (test?.questions?.length || 0); i++) {
              const q = (test?.questions || [])[i] as any
              if (q) {
                fallbackPoints += q.type === 'tf' ? pointsPerType.tf
                  : q.type === 'mc' ? pointsPerType.mc
                  : q.type === 'ms' ? pointsPerType.ms
                  : pointsPerType.des
              }
            }
            studentPts = Math.round(fallbackPoints)
          }
          
          // Calcular porcentaje basado en preguntas encontradas en OCR (no en el total de la prueba)
          const questionsToCount = questionsFoundInOCR > 0 ? questionsFoundInOCR : qTot
          const studentPct = questionsToCount > 0 ? Math.round((studentCorrect / questionsToCount) * 100) : 0
          
          console.log(`[OCR] ${hasRealAnswers ? '✅' : '⚠️'} ${studentName}: ${studentCorrect}/${questionsFoundInOCR} correctas = ${studentPct}% (${studentPts} pts)`)
          
          // 📝 GUARDAR COMO PRELIMINAR (no guardar aún en localStorage ni enviar notificaciones)
          preliminaryResults.push({
            studentName: studentName || '',
            studentId: studentInfo?.id || studentInfo?.username || null,
            studentInfo,
            score: studentCorrect,
            pct: studentPct,
            pts: studentPts,
            saved: false,
            hasAnswers: hasRealAnswers,
            detectedAnswers: detectedAnswersList,
            questionsInOCR: questionsFoundInOCR
          })
          
          processedCount++
          // 🆕 Actualizar progreso OCR
          setOcrProgress({ current: processedCount, total: numStudents })
        }
        
        // Guardar resultados preliminares en el estado
        setPreliminaryGrades(preliminaryResults)
        
        // 🆕 Limpiar progreso OCR
        setOcrProgress(null)
        
        // Mostrar resumen general (NO mostrar nombre de estudiante individual)
        if (processedCount > 0) {
          const resumenTexto = preliminaryResults.map(r => `• ${r.studentName}: ${r.hasAnswers ? `${r.pts} pts (${r.pct}%)` : '❌ Sin respuestas detectadas'}`).join('\n')
          setStudentName('') // No mostrar nombre individual
          setScore(null)
          setBreakdown(null)
          setOcr({ text: `📋 PDF de Curso procesado: ${processedCount} estudiantes detectados.\n\n${resumenTexto}\n\n⚠️ Calificaciones PRELIMINARES. Presiona "Guardar Calificaciones" para confirmar y enviar notificaciones.` })
          setVerification({ sameDocument: true, coverage: 0.8, studentFound: true, studentId: null, hasAnswers: true })
          setEditScore(null)
        } else {
          setError('No se pudieron procesar estudiantes del PDF. Verifica que el PDF contenga las pruebas respondidas.')
        }
        
        return
        }
      }
      
      // ========== MODO NORMAL: Un solo estudiante ==========
      let text = ""
      if (file.type === "application/pdf") {
        text = await extractTextFromPDF(file)
      } else {
        const { data } = await Tesseract.recognize(file, "spa+eng", {
          tessedit_char_whitelist: undefined,
        } as any)
        text = data?.text || ""
      }
      let guessedName = guessStudentName(text, students)
      // Validar que el nombre detectado parezca un nombre real; si no, aplicar fallbacks
      if (!isLikelyPersonName(guessedName)) {
        const fromFile = file?.name ? guessStudentNameFromFilename(file.name) : ''
        if (isLikelyPersonName(fromFile)) {
          guessedName = fromFile
        } else {
          // Mejor candidato desde la lista de estudiantes
          try {
            if (Array.isArray(students) && students.length > 0) {
              let best: { name: string, s: number } | null = null
              for (const s of students) {
                const nm = String(s.displayName || s.username || '').trim()
                if (!nm) continue
                const sc = similarityByTokens(nm, text)
                if (!best || sc > best.s) best = { name: nm, s: sc }
              }
              if (best && best.s >= 0.35) guessedName = best.name
            }
          } catch {}
        }
      }
      // Fallback: extraer nombre desde el nombre del archivo cuando OCR no ayuda
      if (!guessedName && file?.name) {
        guessedName = guessStudentNameFromFilename(file.name)
      }
      console.log(`[OCR Debug] Texto extraído (primeras 500 chars):`, text.slice(0, 500))
      console.log(`[OCR Debug] Nombre detectado:`, guessedName || 'NO DETECTADO', ' | desde archivo:', file?.name)
      setStudentName(guessedName)
      setOcr({ text })
      // 1) Verificar si corresponde a la misma prueba
      let sameDoc = verifySameDocument(text, test?.questions || [])
      // Fallback: si OCR es demasiado corto o es mensaje genérico, intentar por nombre de archivo
      const textIsFallback = !text || /\[pdf detectado\]/i.test(text) || normalize(text).length < 20
      if (!sameDoc.isMatch && textIsFallback && file?.name) {
        try {
          const fname = normalize(file.name)
          const titleTok = normalize(test?.title || '')
          const topicTok = normalize(test?.topic || '')
          const subjectTok = normalize(test?.subjectName || '')
          const likelyMatch = [titleTok, topicTok, subjectTok].filter(Boolean).some(tok => tok && fname.includes(tok))
          if (likelyMatch) {
            sameDoc = { isMatch: true, coverage: 0.25 }
          }
        } catch {}
      }
      // 2) Verificar si el estudiante existe en la sección del test
      const studentInfo = findStudentInSection(guessedName, test?.courseId, test?.sectionId)
  // 3) Calificar siempre (se mostrará como vista previa si no pasa la verificación)
  const graded = autoGrade(text, test?.questions || [])
  let computed: number | null = graded.correct
  setBreakdown(graded.breakdown)
      
      // 🆕 Verificar si realmente hay evidencia de respuestas marcadas
      const hasRealAnswers = graded.evidence > 0
      setVerification({ sameDocument: sameDoc.isMatch, coverage: sameDoc.coverage, studentFound: !!studentInfo, studentId: studentInfo?.id || null, hasAnswers: hasRealAnswers })
      
      // Nota: detectamos si el documento parece una CLAVE, pero no forzamos 100%.
      // Esto evita falsos positivos cuando el archivo contiene la palabra "CLAVE" en el encabezado.
      // Si quieres calificar claves al 100% manualmente, podemos añadir un toggle en UI.
      const isClaveDoc = (file?.name && /\bclave\b/i.test(file.name)) || /\bclave\b/i.test(text)
      if (isClaveDoc) {
        console.info('[OCR] Documento parece CLAVE; no se forzará 100%, se usa autoGrade.')
      }
  setScore(computed)
      // Inicializar edición en PUNTOS (no en respuestas), para permitir hasta totalPoints
      try {
  const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0
        const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot
        const pts = qTot > 0 ? Math.round((Math.max(0, Math.min(computed, qTot)) / qTot) * totalPts) : 0
        setEditScore(pts)
      } catch {
        setEditScore(computed)
      }
      // 3.1) Asignar nota automáticamente si hay estudiante identificado y nota
      if (sameDoc.isMatch && studentInfo && typeof computed === 'number') {
        try {
          // Guardar SIEMPRE en porcentaje (0-100), no en número de respuestas correctas
          const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0
          const pct = qTot > 0 ? Math.round((Math.max(0, Math.min(computed, qTot)) / qTot) * 100) : 0
          upsertTestGrade({
            testId: test?.id || '',
            studentId: String(studentInfo.id || studentInfo.username || ''),
            studentName: studentInfo.displayName || studentInfo.username || guessedName || '',
            score: pct,
            courseId: test?.courseId || null,
            sectionId: test?.sectionId || null,
            subjectId: test?.subjectId || null,
            title: test?.title || '',
            skipEmail: true, // ⚠️ Evitar duplicación - el email se envía en saveAllPreliminaryGrades
          })
        } catch (e) {
          console.warn('[TestReview] No se pudo persistir la nota:', e)
        }
      }
      // 4) Guardar en historial
      persistReview({
        testId: test?.id || '',
        uploadedAt: Date.now(),
        studentName: guessedName || '',
        studentId: studentInfo?.id || null,
        courseId: test?.courseId || null,
        sectionId: test?.sectionId || null,
        subjectId: test?.subjectId || null,
        subjectName: test?.subjectName || null,
        topic: test?.topic || '',
        score: typeof computed === 'number' ? computed : null,
  totalQuestions: Array.isArray(test?.questions) ? test?.questions.length : null,
  totalPoints: typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : (Array.isArray(test?.questions) ? test?.questions.length : null),
  rawPoints: (() => { try { const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0; const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot; return qTot > 0 && typeof computed === 'number' ? Math.round((Math.max(0, Math.min(computed, qTot)) / qTot) * totalPts) : null } catch { return null } })(),
        sameDocument: sameDoc.isMatch,
        coverage: sameDoc.coverage,
        studentFound: !!studentInfo,
      })
      
      // 🤖 NUEVO: Analizar con IA de Gemini VISION (usa imagen, más preciso que texto OCR)
      await analyzeWithAIVision(file, guessedName, studentInfo)
      
    } catch (e: any) {
      console.error(e)
      setError(e?.message || "Error al procesar OCR")
    } finally {
      setProcessing(false)
    }
  }, [file, ensureWorker, test?.questions, students])

  // 🔍 ANÁLISIS COMPLETO: Ejecuta OCR + Gemini Vision internamente
  const runFullAnalysis = useCallback(async () => {
    if (!file) return
    
    setProcessing(true)
    setAnalyzingWithAI(true)
    setError('')
    setOcr(null)
    setScore(null)
    setAnalysisProgress({ step: 'Preparando documento...', percent: 5 })
    setBreakdown({ tf: { correct: 0, total: 0 }, mc: { correct: 0, total: 0 }, ms: { correct: 0, total: 0 }, des: { correct: 0, total: 0 } })
    
    try {
      console.log('[Full Analysis] 🔍 Iniciando análisis completo (OCR + Gemini Vision)...')
      console.log('[Full Analysis] 📄 Archivo:', file.name, file.type, (file.size/1024).toFixed(1), 'KB')
      
      // ============================================
      // PASO 1: OCR con Tesseract (extrae texto)
      // ============================================
      let ocrText = ''
      let guessedName = ''
      
      try {
        console.log('[Full Analysis] 📝 PASO 1: Ejecutando OCR con Tesseract...')
        const worker = await ensureWorker()
        
        if (file.type === 'application/pdf') {
          const pages = await renderPdfToImages(file)
          for (const page of pages) {
            const { data } = await worker.recognize(page.dataUrl)
            ocrText += data.text + '\n'
          }
        } else {
          const { data } = await worker.recognize(file)
          ocrText = data.text
        }
        
        setOcr({ text: ocrText })
        console.log('[Full Analysis] ✅ OCR completado:', ocrText.substring(0, 200) + '...')
        
        // Intentar detectar nombre del estudiante del texto OCR
        const namePatterns = [
          /(?:nombre|estudiante|alumno)[:\s]*([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+)/i,
          /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/m
        ]
        for (const pattern of namePatterns) {
          const match = ocrText.match(pattern)
          if (match && match[1]) {
            guessedName = match[1].trim()
            setStudentName(guessedName)
            break
          }
        }
      } catch (ocrError) {
        console.warn('[Full Analysis] ⚠️ OCR falló, continuando con Gemini Vision:', ocrError)
      }
      
      // ============================================
      // PASO 2: Analizar PAUTA si existe (obtener respuestas correctas)
      // ============================================
      let keyAnswerByQuestion = new Map<number, string | null>()
      
      if (keyFile) {
        console.log('[Full Analysis] 📋 PASO 2: Analizando PAUTA para obtener respuestas correctas...')
        setAnalysisProgress({ step: 'Analizando pauta...', percent: 40 })
        
        try {
          const keyImages = await renderPdfToImages(keyFile)
          console.log(`[Full Analysis] 📄 Pauta tiene ${keyImages.length} páginas`)
          
          for (let k = 0; k < keyImages.length; k++) {
            const keyPage = keyImages[k]
            const base64Data = keyPage.dataUrl.split(',')[1]
            
            const keyResp = await fetch('/api/analyze-ocr', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                imageBase64: base64Data,
                questions: test?.questions || [],
                pageNumber: k + 1,
                isPauta: true // Indicar que es pauta
              })
            })
            
            const keyData = await keyResp.json()
            console.log(`[Full Analysis] 📋 Pauta página ${k + 1}:`, JSON.stringify(keyData, null, 2).substring(0, 500))
            
            if (keyData?.success && keyData?.analysis?.answers) {
              for (const a of keyData.analysis.answers) {
                const qn = Number(a?.q ?? a?.questionNum)
                if (!Number.isFinite(qn) || qn <= 0) continue
                const val = a?.val ?? a?.detected
                if (val !== null && val !== undefined && String(val).length > 0) {
                  if (!keyAnswerByQuestion.has(qn)) {
                    keyAnswerByQuestion.set(qn, String(val).trim())
                    console.log(`[Full Analysis] ✅ Pauta P${qn}: respuesta correcta = "${val}"`)
                  }
                }
              }
            }
          }
          
          console.log(`[Full Analysis] 📊 Pauta analizada: ${keyAnswerByQuestion.size} respuestas correctas detectadas`)
          for (const [qn, val] of keyAnswerByQuestion.entries()) {
            console.log(`  P${qn}: "${val}"`)
          }
          // 🆕 Guardar en estado para que los badges usen estas respuestas
          setPautaAnswers(new Map(keyAnswerByQuestion))
        } catch (keyErr) {
          console.warn('[Full Analysis] ⚠️ Error analizando pauta:', keyErr)
        }
      } else {
        console.log('[Full Analysis] ℹ️ Sin pauta - usando respuestas del test')
        setPautaAnswers(new Map()) // Limpiar pauta anterior
      }
      
      // ============================================
      // PASO 3: Gemini Vision (analiza TODAS las páginas de estudiantes)
      // ============================================
      console.log('[Full Analysis] 🤖 PASO 3: Analizando pruebas de estudiantes con Gemini Vision...')
      
      let allPages: Array<{ pageNum: number; dataUrl: string }> = []
      
      if (file.type === 'application/pdf') {
        allPages = await renderPdfToImages(file)
        console.log(`[Full Analysis] 📄 PDF tiene ${allPages.length} páginas`)
      } else {
        // Es una imagen única
        const arrayBuffer = await file.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )
        allPages = [{ pageNum: 1, dataUrl: `data:image/jpeg;base64,${base64}` }]
      }
      
      if (allPages.length === 0) {
        setError('No se pudo procesar el archivo')
        setAnalysisProgress(null)
        return
      }
      
      // Procesar CADA página como un estudiante diferente
      const allResults: Array<{
        pageNum: number
        studentName: string
        answers: any[]
        aiCorrect: number
        hasAnswers: boolean
      }> = []
      
      for (let i = 0; i < allPages.length; i++) {
        const page = allPages[i]
        const progressPercent = 60 + Math.round((i / allPages.length) * 30)
        setAnalysisProgress({ step: `Analizando página ${i + 1}/${allPages.length}...`, percent: progressPercent })
        
        console.log(`[Full Analysis] 📃 Procesando página ${i + 1}/${allPages.length}...`)
        
        const base64Data = page.dataUrl.split(',')[1]
        
        try {
          const response = await fetch('/api/analyze-ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageBase64: base64Data,
              questions: test?.questions || [],
              pageNumber: i + 1
            })
          })
          
          const data = await response.json()
          console.log(`[Full Analysis] 📊 Página ${i + 1} respuesta:`, JSON.stringify(data, null, 2))
          
          if (data.success && data.analysis) {
            const analysis = data.analysis
            const answers = analysis.answers || []
            const questions = test?.questions || []
            
            console.log(`[Full Analysis] 📝 Página ${i + 1}: ${answers.length} respuestas detectadas, ${questions.length} preguntas en prueba`)
            console.log(`[Full Analysis] 📋 Respuestas raw:`, answers)
            
            // Calcular correctas para esta página
            let aiCorrect = 0
            let hasRealAnswers = false
            
            for (const answer of answers) {
              const qNum = answer.q || answer.questionNum
              const qIndex = qNum - 1
              const q = questions[qIndex] as any
              
              const detected = answer.val !== undefined ? answer.val : answer.detected
              const type = answer.type || q?.type
              
              console.log(`[Full Analysis] P${qNum}: val="${answer.val}", detected="${detected}", type="${type}", q exists: ${!!q}`)
              
              if (detected !== null && detected !== undefined && String(detected).length > 0) {
                hasRealAnswers = true
                
                if (!q) {
                  console.log(`[Full Analysis] ⚠️ Pregunta ${qNum} no existe en el test`)
                  continue
                }
                
                // 🆕 PRIMERO: Usar respuesta de la PAUTA si existe
                if (keyAnswerByQuestion.size > 0 && keyAnswerByQuestion.has(qNum)) {
                  const pautaAnswer = keyAnswerByQuestion.get(qNum)
                  const studentAnswer = String(detected).toUpperCase().trim()
                  const correctAnswer = String(pautaAnswer || '').toUpperCase().trim()
                  
                  // Para selección múltiple, ordenar las opciones antes de comparar
                  let isCorrect = false
                  if (type === 'ms') {
                    const studentLabels = studentAnswer.split(',').map(l => l.trim()).filter(Boolean).sort().join(',')
                    const correctLabels = correctAnswer.split(',').map(l => l.trim()).filter(Boolean).sort().join(',')
                    isCorrect = studentLabels === correctLabels
                  } else {
                    isCorrect = studentAnswer === correctAnswer
                  }
                  
                  console.log(`[Full Analysis] 🎯 P${qNum} PAUTA: estudiante="${studentAnswer}" vs pauta="${correctAnswer}" → ${isCorrect ? '✅ CORRECTA' : '❌ INCORRECTA'}`)
                  
                  if (isCorrect) {
                    aiCorrect++
                  }
                  continue // Ya procesamos con pauta, no usar lógica del test
                }
                
                // FALLBACK: Sin pauta, usar respuestas del test
                if (type === 'tf') {
                  const correctAnswer = q.answer ? 'V' : 'F'
                  const detectedUpper = String(detected).toUpperCase().trim()
                  const isCorrect = detectedUpper === correctAnswer || (detectedUpper === 'VERDADERO' && correctAnswer === 'V') || (detectedUpper === 'FALSO' && correctAnswer === 'F')
                  console.log(`[Full Analysis] 🔍 P${qNum} TF (test): q.answer=${q.answer} (${typeof q.answer}) → correctAnswer="${correctAnswer}", detected="${detectedUpper}", isCorrect=${isCorrect}`)
                  if (isCorrect) {
                    aiCorrect++
                  }
                } else if (type === 'mc') {
                  const correctLetter = String.fromCharCode(65 + (q.correctIndex || 0))
                  const detectedUpper = String(detected).toUpperCase().trim()
                  const isCorrect = detectedUpper === correctLetter
                  console.log(`[Full Analysis] 🔍 P${qNum} MC (test): q.correctIndex=${q.correctIndex} → correctLetter="${correctLetter}", detected="${detectedUpper}", isCorrect=${isCorrect}`)
                  if (isCorrect) {
                    aiCorrect++
                  }
                } else if (type === 'ms') {
                  const correctLabels = (q.options || [])
                    .map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '')
                    .filter(Boolean).sort().join(',')
                  const detectedLabels = String(detected).split(',')
                    .map((l: string) => l.trim().toUpperCase()).filter(Boolean).sort().join(',')
                  const isCorrect = correctLabels === detectedLabels
                  console.log(`[Full Analysis] 🔍 P${qNum} MS (test): correctLabels="${correctLabels}", detectedLabels="${detectedLabels}", isCorrect=${isCorrect}`)
                  if (isCorrect) {
                    aiCorrect++
                  }
                } else if (type === 'des') {
                  if (String(detected || '').trim().length > 5) {
                    aiCorrect++
                  }
                }
              }
            }
            
            // Obtener nombre del estudiante
            let studentName = analysis.studentName || ''
            if (!studentName || studentName.length < 3 || studentName.toLowerCase().includes('estudiante') || studentName.toLowerCase().includes('nombre')) {
              studentName = `Estudiante Página ${i + 1}`
            }
            
            console.log(`[Full Analysis] 📌 Agregando resultado: ${studentName}, correctas=${aiCorrect}, hasAnswers=${hasRealAnswers}, answers=`, answers.length)
            
            allResults.push({
              pageNum: i + 1,
              studentName,
              answers,
              aiCorrect,
              hasAnswers: hasRealAnswers
            })
            
            console.log(`[Full Analysis] ✅ Página ${i + 1}: ${studentName} - ${aiCorrect}/${questions.length} correctas, hasAnswers=${hasRealAnswers}`)
          } else {
            console.log(`[Full Analysis] ⚠️ Página ${i + 1}: No se obtuvo análisis válido`, data)
          }
        } catch (pageError) {
          console.error(`[Full Analysis] ❌ Error en página ${i + 1}:`, pageError)
        }
      }
      
      console.log(`[Full Analysis] 📊 Resultados totales: ${allResults.length}`, allResults)
      
      // Agregar TODOS los resultados a preliminares
      if (allResults.length > 0) {
        setAnalysisProgress({ step: '¡Análisis completado!', percent: 100 })
        
        const questions = test?.questions || []
        const qTot = questions.length
        const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
        
        // 🔧 FIX: Consolidar FUSIONANDO respuestas de todas las páginas del mismo estudiante
        // Antes solo tomaba la página con más correctas, perdiendo respuestas de otras páginas
        const consolidatedByStudent = new Map<string, typeof allResults[0]>()
        
        for (const result of allResults) {
          // Normalizar nombre para comparación
          const normalizedName = result.studentName.toLowerCase().trim()
          
          const existing = consolidatedByStudent.get(normalizedName)
          if (!existing) {
            // Primera vez que vemos este estudiante
            consolidatedByStudent.set(normalizedName, { ...result })
            console.log(`[Full Analysis] 📌 Nuevo estudiante: ${result.studentName}`)
          } else {
            // 🆕 FUSIONAR respuestas: combinar answers de todas las páginas
            console.log(`[Full Analysis] 🔄 Fusionando respuestas de ${result.studentName} (página adicional)`)
            
            // Crear un mapa de respuestas por número de pregunta
            const mergedAnswers = new Map<number, any>()
            
            // Primero agregar las respuestas existentes
            for (const ans of existing.answers || []) {
              const qNum = ans.q || ans.questionNum
              if (qNum && (ans.val !== null && ans.val !== undefined && String(ans.val).trim() !== '' && String(ans.val) !== 'null')) {
                mergedAnswers.set(qNum, ans)
              }
            }
            
            // Luego agregar/sobreescribir con las nuevas respuestas que tengan valor
            for (const ans of result.answers || []) {
              const qNum = ans.q || ans.questionNum
              const hasValue = ans.val !== null && ans.val !== undefined && String(ans.val).trim() !== '' && String(ans.val) !== 'null'
              if (qNum && hasValue) {
                // Solo agregar si no existe o si la nueva tiene más contenido
                const existingAns = mergedAnswers.get(qNum)
                if (!existingAns || String(ans.val).length > String(existingAns.val || '').length) {
                  mergedAnswers.set(qNum, ans)
                  console.log(`[Full Analysis]   → P${qNum} actualizada: "${String(ans.val).substring(0, 50)}..."`)
                }
              }
            }
            
            // Reconstruir el array de answers fusionado
            const fusedAnswers = Array.from(mergedAnswers.values()).sort((a, b) => (a.q || a.questionNum) - (b.q || b.questionNum))
            
            // Recontar correctas basado en las respuestas fusionadas
            let fusedCorrect = 0
            for (const ans of fusedAnswers) {
              const qNum = ans.q || ans.questionNum
              const qDef = questions[qNum - 1] as any
              const detected = ans.val
              
              if (!detected || !qDef) continue
              
              if (qDef.type === 'tf') {
                const correct = qDef.answer ? 'V' : 'F'
                if (String(detected).toUpperCase() === correct) fusedCorrect++
              } else if (qDef.type === 'mc') {
                const correct = String.fromCharCode(65 + (qDef.correctIndex || 0))
                if (String(detected).toUpperCase() === correct) fusedCorrect++
              } else if (qDef.type === 'ms') {
                const correctLabels = (qDef.options || []).map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '').filter(Boolean)
                const detectedLabels = String(detected).split(',').map((l: string) => l.trim().toUpperCase()).filter(Boolean)
                if (correctLabels.length === detectedLabels.length && correctLabels.every((l: string) => detectedLabels.includes(l))) fusedCorrect++
              } else if (qDef.type === 'des') {
                // Desarrollo: si hay texto significativo, contar como respondida
                if (String(detected).trim().length > 5) fusedCorrect++
              }
            }
            
            // Actualizar el resultado consolidado
            existing.answers = fusedAnswers
            existing.aiCorrect = fusedCorrect
            existing.hasAnswers = fusedAnswers.length > 0
            
            console.log(`[Full Analysis] 📊 ${result.studentName} fusionado: ${fusedCorrect} correctas, ${fusedAnswers.length} respuestas`)
          }
        }
        
        const consolidatedResults = Array.from(consolidatedByStudent.values())
        console.log(`[Full Analysis] 📊 Consolidado: ${consolidatedResults.length} estudiantes únicos de ${allResults.length} páginas`)
        
        // Actualizar el primer estudiante detectado con respuestas en la UI
        const bestResult = consolidatedResults.find(r => r.hasAnswers) || consolidatedResults[0]
        if (bestResult) {
          setStudentName(bestResult.studentName)
          setScore(bestResult.aiCorrect)
        }
        
        // Agregar todos a preliminares
        setPreliminaryGrades(prev => {
          const newGrades = [...prev]
          
          for (const result of consolidatedResults) {
            // Solo agregar si tiene respuestas detectadas
            if (!result.hasAnswers) {
              console.log(`[Full Analysis] ⏭️ Saltando ${result.studentName} - sin respuestas`)
              continue
            }
            
            // Buscar estudiante en la lista por nombre
            const existingStudent = students.find(s => 
              s.name.toLowerCase().includes(result.studentName.toLowerCase()) ||
              result.studentName.toLowerCase().includes(s.name.toLowerCase())
            )
            
            const pts = qTot > 0 ? Math.round((result.aiCorrect / qTot) * totalPts) : 0
            
            // Verificar si ya existe en los preliminares
            const existingIdx = newGrades.findIndex(p => 
              p.studentId === existingStudent?.id || 
              p.studentName.toLowerCase() === result.studentName.toLowerCase()
            )
            
            // 🔧 FIX: Incluir TODAS las respuestas, no solo las que tienen val
            // Esto asegura que las preguntas de desarrollo también aparezcan
            const detectedAnswers = result.answers
              .filter((a: any) => {
                const val = a.val ?? a.detected
                return val !== null && val !== undefined && String(val).trim() !== '' && String(val) !== 'null'
              })
              .map((a: any) => ({ 
                questionNum: a.q || a.questionNum, 
                detected: a.val ?? a.detected 
              }))
            
            console.log(`[Full Analysis] ✅ Agregando ${result.studentName}: ${result.aiCorrect}/${qTot} = ${pts} pts, respuestas:`, detectedAnswers)
            
            if (existingIdx >= 0) {
              // Actualizar solo si el nuevo tiene más respuestas
              if (result.aiCorrect >= (newGrades[existingIdx].score || 0)) {
                newGrades[existingIdx] = {
                  ...newGrades[existingIdx],
                  score: result.aiCorrect,
                  pct: qTot > 0 ? Math.round((result.aiCorrect / qTot) * 100) : 0,
                  pts,
                  hasAnswers: result.hasAnswers,
                  detectedAnswers,
                }
              }
            } else {
              newGrades.push({
                studentId: existingStudent?.id || null,
                studentName: result.studentName,
                studentInfo: existingStudent || null,
                score: result.aiCorrect,
                pct: qTot > 0 ? Math.round((result.aiCorrect / qTot) * 100) : 0,
                pts,
                saved: false,
                hasAnswers: result.hasAnswers,
                detectedAnswers,
                questionsInOCR: qTot
              })
            }
          }
          
          return newGrades
        })
        
        console.log(`[Full Analysis] 🎯 Total: ${consolidatedResults.length} estudiantes procesados`)
        setTimeout(() => setAnalysisProgress(null), 2000)
      } else {
        console.log('[Full Analysis] ⚠️ No se detectaron respuestas en ninguna página')
        setAnalysisProgress(null)
        setError('No se detectaron respuestas. Verifique que el archivo sea legible.')
      }
    } catch (err: any) {
      console.error('[Full Analysis] ❌ Error:', err)
      setAnalysisProgress(null)
      setError(err?.message || 'Error al analizar el documento')
    } finally {
      setProcessing(false)
      setAnalyzingWithAI(false)
    }
  }, [file, test?.questions, students, ensureWorker, renderPdfToImages])

  // 🚀 ESTRATEGIA 2: Ejecutar SOLO Gemini Vision (sin OCR)
  const runGeminiVision = useCallback(async () => {
    if (!file) return
    
    setProcessing(true)
    setAnalyzingWithAI(true)
    setError('')
    setOcr(null)
    setScore(null)
    setBreakdown({ tf: { correct: 0, total: 0 }, mc: { correct: 0, total: 0 }, ms: { correct: 0, total: 0 }, des: { correct: 0, total: 0 } })
    
    try {
      console.log('[Gemini Vision] 🚀 Iniciando análisis directo con Gemini Vision...')
      console.log('[Gemini Vision] 📄 Archivo:', file.name, file.type, (file.size/1024).toFixed(1), 'KB')
      
      // Preparar imagen base64
      let base64Data: string = ''
      
      if (file.type === 'application/pdf') {
        console.log('[Gemini Vision] 📄 Renderizando PDF a imagen...')
        const pages = await renderPdfToImages(file)
        if (pages.length > 0) {
          base64Data = pages[0].dataUrl.split(',')[1]
          console.log(`[Gemini Vision] ✅ PDF renderizado (${pages.length} páginas)`)
        }
      } else {
        const arrayBuffer = await file.arrayBuffer()
        base64Data = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )
        console.log('[Gemini Vision] ✅ Imagen cargada directamente')
      }
      
      if (!base64Data) {
        setError('No se pudo procesar el archivo')
        return
      }
      
      console.log('[Gemini Vision] 📡 Enviando a API /api/analyze-ocr...')
      
      const response = await fetch('/api/analyze-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64Data,
          questions: test?.questions || [],
          pageNumber: 1
        })
      })
      
      const data = await response.json()
      console.log('[Gemini Vision] 📊 Respuesta:', JSON.stringify(data, null, 2))
      
      if (data.success && data.analysis) {
        const analysis = data.analysis
        setAiAnalysis(analysis)
        
        // Detectar nombre del estudiante
        if (analysis.studentName) {
          setStudentName(analysis.studentName)
        }
        
        // Procesar respuestas
        const answers = analysis.answers || []
        const questions = test?.questions || []
        
        if (answers.length > 0) {
          let aiCorrect = 0
          const bd = { tf: { correct: 0, total: 0 }, mc: { correct: 0, total: 0 }, ms: { correct: 0, total: 0 }, des: { correct: 0, total: 0 } }
          let hasRealAnswers = false
          
          console.log('[Gemini Vision] 📝 Procesando', answers.length, 'respuestas detectadas...')
          
          for (const answer of answers) {
            const qNum = answer.q || answer.questionNum
            const qIndex = qNum - 1
            const q = questions[qIndex] as any
            if (!q) continue
            
            const detected = answer.val || answer.detected
            const type = answer.type || q.type
            
            console.log(`[Gemini Vision] P${qNum}: tipo=${type}, detectado="${detected}", evidencia="${answer.evidence}"`)
            
            if (detected !== null && detected !== undefined) {
              hasRealAnswers = true
              
              if (type === 'tf') {
                bd.tf.total++
                const correctAnswer = q.answer ? 'V' : 'F'
                const detectedUpper = String(detected).toUpperCase().trim()
                if (detectedUpper === correctAnswer || (detectedUpper === 'VERDADERO' && correctAnswer === 'V') || (detectedUpper === 'FALSO' && correctAnswer === 'F')) {
                  aiCorrect++
                  bd.tf.correct++
                  console.log(`[Gemini Vision] ✅ TF #${qNum} CORRECTA`)
                }
              } else if (type === 'mc') {
                bd.mc.total++
                const correctLetter = String.fromCharCode(65 + (q.correctIndex || 0))
                const detectedUpper = String(detected).toUpperCase().trim()
                if (detectedUpper === correctLetter) {
                  aiCorrect++
                  bd.mc.correct++
                  console.log(`[Gemini Vision] ✅ MC #${qNum} CORRECTA`)
                }
              } else if (type === 'ms') {
                bd.ms.total++
                const correctLabels = (q.options || [])
                  .map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '')
                  .filter(Boolean).sort().join(',')
                const detectedLabels = String(detected).split(',')
                  .map((l: string) => l.trim().toUpperCase()).filter(Boolean).sort().join(',')
                if (correctLabels === detectedLabels) {
                  aiCorrect++
                  bd.ms.correct++
                  console.log(`[Gemini Vision] ✅ MS #${qNum} CORRECTA`)
                }
              } else if (type === 'des') {
                bd.des.total++
                if (String(detected || '').trim().length > 5) {
                  aiCorrect++
                  bd.des.correct++
                }
              }
            } else {
              if (type === 'tf') bd.tf.total++
              else if (type === 'mc') bd.mc.total++
              else if (type === 'ms') bd.ms.total++
              else if (type === 'des') bd.des.total++
            }
          }
          
          console.log(`[Gemini Vision] 🎯 Resultado: ${aiCorrect}/${questions.length} correctas`)
          
          setVerification(v => ({ ...v, hasAnswers: hasRealAnswers }))
          setScore(aiCorrect)
          setBreakdown(bd)
          
          // Calcular puntos
          const qTot = questions.length
          const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
          const pts = qTot > 0 ? Math.round((aiCorrect / qTot) * totalPts) : 0
          setEditScore(pts)
          
          // Agregar a preliminares
          const existingStudent = students.find(s => 
            s.name.toLowerCase().includes((analysis.studentName || '').toLowerCase()) ||
            (analysis.studentName || '').toLowerCase().includes(s.name.toLowerCase())
          )
          
          setPreliminaryGrades(prev => {
            const existing = prev.find(p => p.studentId === existingStudent?.id)
            if (existing) {
              return prev.map(p => p.studentId === existingStudent?.id ? { 
                ...p, 
                score: aiCorrect, 
                pct: qTot > 0 ? Math.round((aiCorrect / qTot) * 100) : 0,
                pts: pts,
                hasAnswers: hasRealAnswers,
                detectedAnswers: answers.map((a: any) => ({ questionNum: a.q, detected: a.val }))
              } : p)
            }
            return [...prev, {
              studentId: existingStudent?.id || null,
              studentName: analysis.studentName || 'Estudiante detectado',
              studentInfo: existingStudent || null,
              score: aiCorrect,
              pct: qTot > 0 ? Math.round((aiCorrect / qTot) * 100) : 0,
              pts: pts,
              saved: false,
              hasAnswers: hasRealAnswers,
              detectedAnswers: answers.map((a: any) => ({ questionNum: a.q, detected: a.val })),
              questionsInOCR: qTot
            }]
          })
        } else {
          console.log('[Gemini Vision] ⚠️ No se detectaron respuestas')
          setError('Gemini no detectó respuestas en el documento. Intenta con OCR tradicional.')
        }
      } else {
        console.error('[Gemini Vision] ❌ Error:', data.error)
        setError(data.error || 'Error al analizar con Gemini Vision')
      }
    } catch (err: any) {
      console.error('[Gemini Vision] ❌ Error:', err)
      setError(err?.message || 'Error al analizar con Gemini Vision')
    } finally {
      setProcessing(false)
      setAnalyzingWithAI(false)
    }
  }, [file, test?.questions, students, renderPdfToImages])

  // 🤖 Función auxiliar para analizar con Gemini VISION (usada por runOCR)
  const analyzeWithAIVision = useCallback(async (imageFile: File, detectedName: string, studentInfo: any) => {
    if (!imageFile) return
    
    setAnalyzingWithAI(true)
    try {
      console.log('[AI Vision] 🖼️ Preparando imagen para Gemini Vision...')
      
      let base64Data: string = ''
      
      // Si es PDF, renderizar a imagen
      if (imageFile.type === 'application/pdf') {
        const pages = await renderPdfToImages(imageFile)
        if (pages.length > 0) {
          // Usar la primera página (o combinar múltiples páginas si es necesario)
          base64Data = pages[0].dataUrl.split(',')[1]
          console.log(`[AI Vision] 📄 PDF renderizado a imagen (${pages.length} páginas)`)
        }
      } else {
        // Es una imagen directa
        const arrayBuffer = await imageFile.arrayBuffer()
        base64Data = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )
        console.log('[AI Vision] 🖼️ Imagen cargada directamente')
      }
      
      if (!base64Data) {
        console.warn('[AI Vision] ⚠️ No se pudo obtener imagen base64')
        return
      }
      
      console.log('[AI Vision] 🚀 Enviando imagen a Gemini Vision API...')
      
      const response = await fetch('/api/analyze-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64Data,
          questions: test?.questions || [],
          pageNumber: 1
        })
      })
      
      const data = await response.json()
      console.log('[AI Vision] 📊 Respuesta completa:', JSON.stringify(data, null, 2))
      
      if (data.success && data.analysis) {
        const analysis = data.analysis
        setAiAnalysis(analysis)
        
        // Actualizar nombre del estudiante si se detectó
        if (analysis.studentName && !detectedName) {
          setStudentName(analysis.studentName)
        }
        
        // Procesar respuestas detectadas por la IA
        const answers = analysis.answers || []
        const questions = test?.questions || []
        
        if (answers.length > 0) {
          let aiCorrect = 0
          const bd = { tf: { correct: 0, total: 0 }, mc: { correct: 0, total: 0 }, ms: { correct: 0, total: 0 }, des: { correct: 0, total: 0 } }
          let hasRealAnswers = false
          
          console.log('[AI Vision] 📝 Procesando respuestas detectadas...')
          
          for (const answer of answers) {
            const qNum = answer.q || answer.questionNum
            const qIndex = qNum - 1
            const q = questions[qIndex] as any
            if (!q) continue
            
            const detected = answer.val || answer.detected
            const type = answer.type || q.type
            
            console.log(`[AI Vision] P${qNum}: tipo=${type}, detectado="${detected}", evidencia="${answer.evidence}"`)
            
            // Verificar si hay respuesta (no null)
            if (detected !== null && detected !== undefined) {
              hasRealAnswers = true
              
              if (type === 'tf') {
                bd.tf.total++
                const correctAnswer = q.answer ? 'V' : 'F'
                const detectedUpper = String(detected).toUpperCase().trim()
                
                console.log(`[AI Vision] TF #${qNum}: correcta="${correctAnswer}", detectada="${detectedUpper}"`)
                
                if (detectedUpper === correctAnswer || detectedUpper === 'VERDADERO' && correctAnswer === 'V' || detectedUpper === 'FALSO' && correctAnswer === 'F') {
                  aiCorrect++
                  bd.tf.correct++
                  console.log(`[AI Vision] ✅ Pregunta ${qNum} CORRECTA`)
                } else {
                  console.log(`[AI Vision] ❌ Pregunta ${qNum} incorrecta`)
                }
              } else if (type === 'mc') {
                bd.mc.total++
                const correctLetter = String.fromCharCode(65 + (q.correctIndex || 0))
                const detectedUpper = String(detected).toUpperCase().trim()
                
                if (detectedUpper === correctLetter) {
                  aiCorrect++
                  bd.mc.correct++
                  console.log(`[AI Vision] ✅ MC #${qNum} CORRECTA (${detectedUpper})`)
                } else {
                  console.log(`[AI Vision] ❌ MC #${qNum} incorrecta (esperaba ${correctLetter}, detectó ${detectedUpper})`)
                }
              } else if (type === 'ms') {
                bd.ms.total++
                // Para selección múltiple, verificar todas las opciones
                const correctLabels = (q.options || [])
                  .map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '')
                  .filter(Boolean)
                  .sort()
                  .join(',')
                const detectedLabels = String(detected)
                  .split(',')
                  .map((l: string) => l.trim().toUpperCase())
                  .filter(Boolean)
                  .sort()
                  .join(',')
                
                if (correctLabels === detectedLabels) {
                  aiCorrect++
                  bd.ms.correct++
                  console.log(`[AI Vision] ✅ MS #${qNum} CORRECTA (${detectedLabels})`)
                } else {
                  console.log(`[AI Vision] ❌ MS #${qNum} incorrecta (esperaba ${correctLabels}, detectó ${detectedLabels})`)
                }
              } else if (type === 'des') {
                bd.des.total++
                const detectedText = String(detected || '').trim()
                if (detectedText.length > 5) {
                  // Si hay respuesta escrita, contar como respondida
                  aiCorrect++
                  bd.des.correct++
                  console.log(`[AI Vision] 📝 DES #${qNum}: respuesta detectada`)
                }
              }
            } else {
              // Pregunta sin respuesta
              if (type === 'tf') bd.tf.total++
              else if (type === 'mc') bd.mc.total++
              else if (type === 'ms') bd.ms.total++
              else if (type === 'des') bd.des.total++
            }
          }
          
          // Actualizar estado con resultados de IA
          console.log(`[AI Vision] 🎯 Total correctas: ${aiCorrect}/${questions.length}`)
          
          setVerification(v => ({ ...v, hasAnswers: hasRealAnswers }))
          
          if (hasRealAnswers) {
            setScore(aiCorrect)
            setBreakdown(bd)
            
            // Calcular puntos
            const qTot = questions.length
            const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
            const pts = qTot > 0 ? Math.round((aiCorrect / qTot) * totalPts) : 0
            setEditScore(pts)
            
            console.log(`[AI Vision] ✅ Score actualizado: ${aiCorrect} correctas = ${pts} pts`)
          }
        } else {
          console.log('[AI Vision] ⚠️ No se detectaron respuestas en la imagen')
        }
      } else {
        console.warn('[AI Vision] ⚠️ Respuesta de IA sin éxito:', data.error || 'desconocido')
      }
    } catch (err) {
      console.warn('[AI Vision] ❌ Error:', err)
    } finally {
      setAnalyzingWithAI(false)
    }
  }, [test?.questions, students, renderPdfToImages])

  // 🤖 LEGACY: Función para analizar OCR con texto (fallback)
  const analyzeWithAI = useCallback(async (ocrText: string, detectedName: string, studentInfo: any) => {
    if (!ocrText || ocrText.length < 50) return
    
    setAnalyzingWithAI(true)
    try {
      console.log('[AI Analysis] Enviando texto OCR a Gemini:', ocrText.substring(0, 500))
      
      const response = await fetch('/api/analyze-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ocrText,
          questions: test?.questions || [],
          studentName: detectedName,
          expectedStudents: students
        })
      })
      
      const data = await response.json()
      console.log('[AI Analysis] Respuesta completa:', data)
      
      if (data.success && data.analysis) {
        const analysis = data.analysis
        setAiAnalysis(analysis)
        
        // 🆕 Verificar si el estudiante realmente respondió
        const hasAnswers = analysis.hasAnswers !== false
        setVerification(v => ({ ...v, hasAnswers }))
        
        // Si la IA detectó un nombre diferente, actualizarlo
        if (analysis.studentDetected && !detectedName) {
          setStudentName(analysis.studentDetected)
        }
        
        // 🆕 USAR RESPUESTAS DE IA COMO PRINCIPAL si tiene confianza >= 50%
        // Esto es más confiable que el procesamiento manual de OCR para V/F
        if (analysis.answers && Array.isArray(analysis.answers) && analysis.confidence >= 50) {
          const questions = test?.questions || []
          let aiCorrect = 0
          const bd = { tf: { correct: 0, total: 0 }, mc: { correct: 0, total: 0 }, ms: { correct: 0, total: 0 }, des: { correct: 0, total: 0 } }
          
          console.log('[AI Analysis] Procesando respuestas de IA...')
          
          for (let i = 0; i < questions.length; i++) {
            const q = questions[i] as any
            const aiAnswer = analysis.answers.find((a: any) => a.questionNum === i + 1)
            
            console.log(`[AI Analysis] Pregunta ${i + 1}: tipo=${q.type}, IA detectó="${aiAnswer?.detected}"`)
            
            if (q.type === 'tf') {
              bd.tf.total++
              const correct = q.answer ? 'V' : 'F'
              const detected = aiAnswer?.detected?.toUpperCase()
              
              console.log(`[AI Analysis] TF #${i + 1}: correcta="${correct}", detectada="${detected}"`)
              
              // Solo sumar si es correcta - NO restar si es incorrecta
              if (detected === correct) {
                aiCorrect++
                bd.tf.correct++
                console.log(`[AI Analysis] ✅ Pregunta ${i + 1} CORRECTA`)
              } else if (detected && detected !== correct) {
                console.log(`[AI Analysis] ❌ Pregunta ${i + 1} incorrecta (no resta)`)
              } else {
                console.log(`[AI Analysis] ⚠️ Pregunta ${i + 1} sin respuesta detectada`)
              }
            } else if (q.type === 'mc') {
              bd.mc.total++
              const correct = String.fromCharCode(65 + q.correctIndex)
              if (aiAnswer?.detected?.toUpperCase() === correct) {
                aiCorrect++
                bd.mc.correct++
              }
            } else if (q.type === 'ms') {
              bd.ms.total++
              // Para selección múltiple, verificar todas las opciones
              const correctLabels = q.options.map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '').filter(Boolean)
              const detectedLabels = (aiAnswer?.detected || '').split(',').map((l: string) => l.trim().toUpperCase()).filter(Boolean)
              if (correctLabels.length === detectedLabels.length && correctLabels.every((l: string) => detectedLabels.includes(l))) {
                aiCorrect++
                bd.ms.correct++
              }
            } else if (q.type === 'des') {
              bd.des.total++
              // Para desarrollo: verificar si hay texto significativo
              const detectedText = (aiAnswer?.detected || '').trim()
              if (detectedText && detectedText.length > 5) {
                // Si hay respuesta escrita, contar como respondida/correcta preliminarmente
                aiCorrect++
                bd.des.correct++
                console.log(`[AI Analysis] 📝 Pregunta ${i + 1} DESARROLLO: respuesta detectada`)
                console.log(`[AI Analysis]    Texto: "${detectedText.substring(0, 80)}..."`)
              } else {
                console.log(`[AI Analysis] ⬜ Pregunta ${i + 1} DESARROLLO: sin respuesta`)
              }
            }
          }
          
          // 🆕 SIEMPRE actualizar con respuestas de IA si detectó respuestas
          // La IA es más confiable que Tesseract para detectar marcas V/F
          console.log(`[AI Analysis] Total correctas: ${aiCorrect}/${questions.length}, Confianza: ${analysis.confidence}%`)
          
          if (hasAnswers) {
            setScore(aiCorrect)
            setBreakdown(bd)
            const qTot = questions.length
            const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
            const pts = qTot > 0 ? Math.round((aiCorrect / qTot) * totalPts) : 0
            setEditScore(pts)
            console.log(`[AI Analysis] ✅ Score actualizado: ${aiCorrect} correctas = ${pts} pts`)
          }
        }
        
        console.log('[AI Analysis] Resultado:', analysis)
      }
    } catch (err) {
      console.warn('[AI Analysis] Error:', err)
    } finally {
      setAnalyzingWithAI(false)
    }
  }, [test?.questions, students])

  // 💾 NUEVO: Guardar todas las calificaciones preliminares y enviar notificaciones
  const saveAllPreliminaryGrades = useCallback(async () => {
    if (preliminaryGrades.length === 0) return
    
    setSavingGrades(true)
    try {
      const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0
      const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot
      const reviewKey = getReviewKey(test?.id || '')
      let reviewList: ReviewRecord[] = []
      try { reviewList = JSON.parse(localStorage.getItem(reviewKey) || '[]') } catch {}
      
      const baseTimestamp = Date.now()
      let savedCount = 0
      let totalEmailsSent = 0
      
      for (let i = 0; i < preliminaryGrades.length; i++) {
        const grade = preliminaryGrades[i]
        if (grade.saved) continue // Ya guardada
        
        const { studentName, studentId, studentInfo, score, pct, pts, hasAnswers } = grade
        
        // 🆕 Si no tiene respuestas detectadas, saltar (para evitar emails duplicados)
        if (!hasAnswers) {
          console.log(`[SaveGrades] ⏩ Saltando ${studentName}: sin respuestas detectadas`)
          continue
        }
        
        console.log(`[SaveGrades] 📝 Procesando ${studentName}...`, {
          hasStudentInfo: !!studentInfo,
          studentId,
          hasAnswers
        })
        
        // 🆕 Obtener ID efectivo ANTES de guardar (buscando por nombre si es necesario)
        let effectiveStudentId = studentId || studentInfo?.id || studentInfo?.username
        
        if (!effectiveStudentId && studentName) {
          try {
            const savedYear = Number(localStorage.getItem('admin-selected-year') || '')
            const currentYear = Number.isFinite(savedYear) && savedYear > 0 ? savedYear : new Date().getFullYear()
            const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]')
            
            const normalizedSearchName = studentName.toLowerCase().trim()
              .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            
            const foundStudent = studentsForYear.find((s: any) => {
              const displayName = (s.displayName || s.name || s.username || '').toLowerCase().trim()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              return displayName === normalizedSearchName || 
                     displayName.includes(normalizedSearchName) ||
                     normalizedSearchName.includes(displayName)
            })
            
            if (foundStudent) {
              effectiveStudentId = foundStudent.id || foundStudent.username
              console.log(`[SaveGrades] ✅ Estudiante encontrado por nombre en búsqueda inicial: ${foundStudent.displayName || foundStudent.username} (ID: ${effectiveStudentId})`)
            }
          } catch (err) {
            console.error('[SaveGrades] ❌ Error buscando estudiante en búsqueda inicial:', err)
          }
        }
        
        // 1) Guardar calificación en localStorage (TestGrades)
        // ⚠️ skipEmail=true porque el email se envía más abajo en esta misma función
        if (effectiveStudentId) {
          try {
            upsertTestGrade({
              testId: test?.id || '',
              studentId: String(effectiveStudentId),
              studentName: studentInfo?.displayName || studentInfo?.username || studentName || '',
              score: pct,
              courseId: test?.courseId || null,
              sectionId: test?.sectionId || null,
              subjectId: test?.subjectId || null,
              title: test?.title || '',
              skipEmail: true, // ⚠️ Evitar duplicación de email
            })
          } catch (e) {
            console.warn(`[SaveGrades] No se pudo guardar nota de ${studentName}:`, e)
          }
        }
        
        // 2) Guardar en historial
        const newRecord: ReviewRecord = {
          testId: test?.id || '',
          uploadedAt: baseTimestamp + (i * 1000),
          studentName: studentName || '',
          studentId: effectiveStudentId || null,
          courseId: test?.courseId || null,
          sectionId: test?.sectionId || null,
          subjectId: test?.subjectId || null,
          subjectName: test?.subjectName || null,
          topic: test?.topic || '',
          score: score,
          totalQuestions: qTot,
          totalPoints: totalPts,
          rawPoints: pts,
          rawPercent: pct,
          sameDocument: true,
          coverage: 0.8,
          studentFound: !!effectiveStudentId,
        }
        
        const normName = normalize(studentName)
        const idx = reviewList.findIndex(r => 
          (r.studentId && effectiveStudentId && r.studentId === effectiveStudentId) || 
          normalize(r.studentName || '') === normName
        )
        if (idx >= 0) {
          reviewList[idx] = newRecord
        } else {
          reviewList.unshift(newRecord)
        }
        
        // 3) Enviar notificación por email al estudiante y apoderado
        // Ya tenemos effectiveStudentId calculado arriba
        
        if (effectiveStudentId) {
          try {
            // Obtener información del estudiante y apoderados con sus emails
            const savedYear = Number(localStorage.getItem('admin-selected-year') || '')
            const currentYear = Number.isFinite(savedYear) && savedYear > 0 ? savedYear : new Date().getFullYear()
            
            let courseDisplayName = ''
            let studentEmail = ''
            const guardiansToNotify: Array<{ id: string; email: string; name: string }> = []
            
            console.log(`[SaveGrades] 🔍 Procesando notificaciones para: ${studentName} (ID: ${effectiveStudentId})`)
            
            try {
              const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]')
              console.log(`[SaveGrades] 📚 Total estudiantes en año ${currentYear}:`, studentsForYear.length)
              
              // Buscar por ID primero
              let studentData = studentsForYear.find((s: any) => 
                String(s.id) === String(effectiveStudentId) || 
                String(s.username) === String(effectiveStudentId)
              )
              
              // Si no se encuentra por ID, buscar por nombre normalizado
              if (!studentData && studentName) {
                const normalizedSearchName = studentName.toLowerCase().trim()
                  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                studentData = studentsForYear.find((s: any) => {
                  const displayName = (s.displayName || s.name || s.username || '').toLowerCase().trim()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                  return displayName === normalizedSearchName || 
                         displayName.includes(normalizedSearchName) ||
                         normalizedSearchName.includes(displayName)
                })
                if (studentData) {
                  console.log(`[SaveGrades] ✅ Estudiante encontrado por nombre en notificaciones: ${studentData.displayName || studentData.username}`)
                }
              }
              
              if (studentData) {
                console.log(`[SaveGrades] ✅ Datos del estudiante encontrados para ${studentName}:`, {
                  id: studentData.id,
                  username: studentData.username,
                  email: studentData.email,
                  displayName: studentData.displayName
                })
                
                courseDisplayName = `${studentData.course || ''} ${studentData.section || ''}`.trim()
                studentEmail = studentData.email || ''
                
                if (!studentEmail) {
                  console.warn(`[SaveGrades] ⚠️ Estudiante ${studentName} NO tiene email registrado`)
                } else {
                  console.log(`[SaveGrades] 📧 Email del estudiante: ${studentEmail}`)
                }
                
                // Buscar apoderados de este estudiante
                const guardians = JSON.parse(localStorage.getItem(`smart-student-guardians-${currentYear}`) || '[]')
                console.log(`[SaveGrades] 👨‍👩‍👧 Total apoderados en sistema:`, guardians.length)
                
                const studentGuardians = guardians.filter((g: any) => 
                  g.studentIds?.includes(effectiveStudentId) || 
                  g.studentIds?.includes(studentData.id) ||
                  g.studentIds?.includes(studentData.username) ||
                  g.students?.some((s: any) => 
                    String(s.id || s) === String(effectiveStudentId) ||
                    String(s.id || s) === String(studentData.id) ||
                    String(s.id || s) === String(studentData.username)
                  )
                )
                
                console.log(`[SaveGrades] 👨‍👩‍👧 Apoderados encontrados para ${studentName}:`, studentGuardians.length)
                
                studentGuardians.forEach((g: any) => {
                  if (g.email && g.id) {
                    guardiansToNotify.push({
                      id: g.id,
                      email: g.email,
                      name: g.displayName || g.name || g.username || 'Apoderado'
                    })
                    console.log(`[SaveGrades] 📧 Apoderado: ${g.displayName || g.username} (${g.email})`)
                  } else {
                    console.warn(`[SaveGrades] ⚠️ Apoderado sin email:`, g.displayName || g.username)
                  }
                })
              } else {
                console.warn(`[SaveGrades] ❌ No se encontró estudiante con ID: ${effectiveStudentId} o nombre: ${studentName}`)
              }
            } catch (err) {
              console.error('[SaveGrades] ❌ Error buscando datos del estudiante:', err)
            }
            
            if (!courseDisplayName) {
              try {
                const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]')
                const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]')
                const sec = sections.find((s: any) => String(s.id) === String(test?.sectionId))
                const course = courses.find((c: any) => String(c.id) === String(sec?.courseId))
                courseDisplayName = `${course?.name || ''} ${sec?.name || ''}`.trim()
              } catch {}
            }
            
            // Mensaje motivacional
            let motivationalMsg = ''
            if (pct >= 90) motivationalMsg = '🌟 ¡Excelente trabajo! Sigue así.'
            else if (pct >= 70) motivationalMsg = '👍 ¡Buen trabajo! Vas por buen camino.'
            else if (pct >= 50) motivationalMsg = '💪 ¡Sigue esforzándote! Puedes mejorar.'
            else motivationalMsg = '📚 No te desanimes, con práctica mejorarás.'
            
            const emailContent = {
              title: `📊 Nueva calificación: ${test?.title || 'Prueba'}`,
              content: `${studentName} obtuvo ${pts} pts (${pct}%) en la prueba "${test?.title || 'Prueba'}" de ${courseDisplayName}. ${motivationalMsg}`,
              courseName: courseDisplayName,
              taskTitle: test?.title || 'Prueba',
              grade: pct,
              feedback: `Puntaje: ${pts}/${totalPts} pts (${pct}%)`,
            }
            
            // Enviar email directamente al estudiante
            if (studentEmail) {
              try {
                await fetch('/api/notifications/send-email', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: 'notificaciones@smartstudent.cl',
                    to: studentEmail,
                    toName: studentName || 'Estudiante',
                    subject: `📊 Nueva calificación: ${test?.title || 'Prueba'}`,
                    type: 'grade_published',
                    title: emailContent.title,
                    content: emailContent.content,
                    metadata: {
                      courseName: emailContent.courseName,
                      taskTitle: emailContent.taskTitle,
                      grade: emailContent.grade,
                      feedback: emailContent.feedback
                    }
                  })
                })
                console.log(`[SaveGrades] ✅ Email enviado a estudiante: ${studentEmail}`)
              } catch (emailErr) {
                console.warn(`[SaveGrades] Error enviando email a estudiante:`, emailErr)
              }
            }
            
            // Enviar email a cada apoderado
            for (const guardian of guardiansToNotify) {
              try {
                await fetch('/api/notifications/send-email', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: 'notificaciones@smartstudent.cl',
                    to: guardian.email,
                    toName: guardian.name,
                    subject: `📊 Nueva calificación de ${studentName}: ${test?.title || 'Prueba'}`,
                    type: 'grade_published',
                    title: emailContent.title,
                    content: emailContent.content,
                    metadata: {
                      courseName: emailContent.courseName,
                      taskTitle: emailContent.taskTitle,
                      grade: emailContent.grade,
                      feedback: emailContent.feedback
                    }
                  })
                })
                console.log(`[SaveGrades] ✅ Email enviado a apoderado: ${guardian.email}`)
              } catch (emailErr) {
                console.warn(`[SaveGrades] Error enviando email a apoderado:`, emailErr)
              }
            }
            
            const totalEmails = (studentEmail ? 1 : 0) + guardiansToNotify.length
            totalEmailsSent += totalEmails
            if (totalEmails > 0) {
              console.log(`[SaveGrades] ✅ Total de ${totalEmails} email(s) enviado(s) para ${studentName}`)
            } else {
              console.warn(`[SaveGrades] ⚠️ No se encontraron emails para ${studentName}`)
            }
            
          } catch (notifErr) {
            console.warn(`[SaveGrades] Error con notificaciones de ${studentName}:`, notifErr)
          }
        } else {
          console.warn(`[SaveGrades] ⚠️ No se pudo enviar email para ${studentName}: sin ID de estudiante`)
        }
        
        savedCount++
      }
      
      // Guardar historial actualizado
      try {
        localStorage.setItem(reviewKey, JSON.stringify(reviewList))
        window.dispatchEvent(new StorageEvent('storage', { key: reviewKey, newValue: JSON.stringify(reviewList) }))
      } catch {}
      setHistory(reviewList)
      
      // Marcar todas como guardadas
      setPreliminaryGrades(prev => prev.map(g => ({ ...g, saved: true })))
      
      // Mostrar mensaje de éxito
      const emailsMsg = totalEmailsSent > 0 
        ? `\n📧 ${totalEmailsSent} notificaciones por email enviadas.` 
        : '\n⚠️ No se enviaron emails (verifique que los estudiantes tengan email registrado).'
      
      setOcr({ text: `✅ ${savedCount} calificaciones guardadas exitosamente.${emailsMsg}` })
      setStatusModal({ 
        type: 'success', 
        message: `✅ ${savedCount} calificaciones guardadas.${emailsMsg}` 
      })
      
    } catch (err: any) {
      console.error('[SaveGrades] Error:', err)
      setError(err?.message || 'Error al guardar calificaciones')
    } finally {
      setSavingGrades(false)
    }
  }, [preliminaryGrades, test, students])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
  }

  const handleKeyFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setKeyFile(f)
  }

  // ====== Exportación / Importación Excel ======
  const exportExcelTemplate = useCallback(async () => {
    try {
      if (!test) return
      const XLSX = await import('xlsx')
      const qTot = test.questions?.length || 0
      const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
      // Construir filas base desde estudiantes de la sección (si existen) o del historial
      let baseStudents: Array<{ id?: string; name: string }> = []
      if (students.length > 0) {
        baseStudents = students.map(s => ({ id: String(s.id || s.username || ''), name: s.displayName || s.username || '' }))
      } else if (history.length > 0) {
        const seen = new Set<string>()
        for (const h of history) {
          const nm = h.studentName || ''
            if (!nm) continue
          if (!seen.has(nm)) { seen.add(nm); baseStudents.push({ id: h.studentId || undefined, name: nm }) }
        }
      }
      if (baseStudents.length === 0) baseStudents.push({ id: '', name: '' })
      const rows = baseStudents.map(s => ({
        ID: s.id || '',
        Estudiante: s.name,
        Puntos: '',
        Porcentaje: '',
      }))
      // Creamos primeramente AOA con 3 líneas info luego encabezado real
      const info = [
        [`Plantilla de notas para: ${test.title}`],
        [`Total Preguntas: ${qTot}  Total Puntos: ${totalPts}`],
        [`Rellena 'Puntos' o 'Porcentaje' (0-100). Deja vacío para omitir.`],
        ['ID','Estudiante','Puntos','Porcentaje']
      ]
      const ws = XLSX.utils.aoa_to_sheet(info)
      XLSX.utils.sheet_add_json(ws, rows, { origin: 'A5', skipHeader: true })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Notas')
      const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const safeTitle = (test.title || 'notas').replace(/[^a-zA-Z0-9-_]+/g, '_')
      a.download = `plantilla_notas_${safeTitle}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.warn('[Excel] Export error', e)
    }
  }, [test, students, history])

  const handleExcelUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !test) return
    setImporting(true)
    setImportStatus(null)
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheetName = wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      // Leemos como matriz para detectar encabezado (puede estar en fila 4 si se usó plantilla)
      const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' }) as any[]
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('Hoja vacía')
      // Buscar fila de header que contenga Estudiante y (ID o Puntos)
      let headerIndex = rows.findIndex(r => Array.isArray(r) && r.some(c => /estudiante/i.test(String(c))) && r.some(c => /^id$/i.test(String(c)) || /puntos/i.test(String(c))))
      if (headerIndex === -1) headerIndex = 0
      const headerRow = rows[headerIndex].map((c: any) => String(c).trim())
      const dataRows = rows.slice(headerIndex + 1)
      const json = dataRows.map(r => {
        const obj: any = {}
        for (let i=0;i<headerRow.length;i++) {
          const key = headerRow[i] || `col${i}`
          obj[key] = r[i]
        }
        return obj
      })
      const qTot = test.questions?.length || 0
      const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
      const nowBase = Date.now()
      let updates = 0
  // Cargar historial existente una sola vez para actualizar en memoria
  const reviewKey = getReviewKey(test.id)
  let reviewList: ReviewRecord[] = []
  try { reviewList = JSON.parse(localStorage.getItem(reviewKey) || '[]') } catch {}
  let updated = 0
  let created = 0
  for (let i=0;i<json.length;i++) {
        const row = json[i]
        const rawName = String(row['Estudiante'] || row['estudiante'] || '').trim()
        const rawId = String(row['ID'] || row['id'] || '').trim()
        if (!rawName && !rawId) continue
        const puntosStr = String(row['Puntos'] || row['puntos'] || '').replace(/,/g,'.').trim()
        const porcStr = String(row['Porcentaje'] || row['porcentaje'] || '').replace(/,/g,'.').replace(/%/,'').trim()
        let puntos: number | null = null
        if (puntosStr && !isNaN(Number(puntosStr))) puntos = Number(puntosStr)
        let porcentaje: number | null = null
        if (porcStr && !isNaN(Number(porcStr))) porcentaje = Number(porcStr)
        if (puntos == null && porcentaje == null) continue
        // Calcular porcentaje DIRECTAMENTE sin pasar por "correct answers" para evitar error de redondeo
        // Por ejemplo: 80 puntos de 100 = 80% exacto, no 81% por doble redondeo
        let pct = 0
        if (puntos != null && totalPts > 0) {
          // Calcular porcentaje directamente desde los puntos
          const clampedPts = Math.max(0, Math.min(puntos, totalPts))
          pct = Math.round((clampedPts / totalPts) * 100)
        } else if (porcentaje != null) {
          // Usar el porcentaje directamente si se proporcionó
          pct = Math.round(Math.max(0, Math.min(porcentaje, 100)))
        }
        // Calcular correct answers solo para el historial visual (no afecta el score guardado)
        let correct = qTot > 0 ? Math.round((pct / 100) * qTot) : 0
        // Mapear a studentId real si existe
        let studentObj: any = null
        if (students.length) {
          studentObj = students.find(s => String(s.id) === rawId || String(s.username) === rawId) || students.find(s => (s.displayName || '').toLowerCase() === rawName.toLowerCase())
        }
        const studentId = studentObj ? String(studentObj.id || studentObj.username) : (rawId || rawName)
        const studentName = studentObj ? (studentObj.displayName || studentObj.username) : rawName || rawId
        if (!studentId || !studentName) continue
        // pct ya fue calculado directamente arriba
        upsertTestGrade({
          testId: test.id,
          studentId,
          studentName,
          score: pct,
          courseId: test.courseId || null,
          sectionId: test.sectionId || null,
          subjectId: test.subjectId || null,
          title: test.title || '',
          skipEmail: true, // ⚠️ Carga masiva manual - no enviar emails automáticamente
        })
        // Historial: si ya existe registro para el estudiante, sobrescribir último; si no, crear nuevo.
        const normName = normalize(studentName)
        let idx = reviewList.findIndex(r => (r.studentId && r.studentId === studentId) || normalize(r.studentName) === normName)
        const newRecord: ReviewRecord = {
          testId: test.id,
          uploadedAt: nowBase + i, // nuevo timestamp asegura orden cronológico
          studentName,
          studentId,
          courseId: test.courseId || null,
          sectionId: test.sectionId || null,
          subjectId: test.subjectId || null,
          subjectName: test.subjectName || null,
          topic: test.topic || '',
          score: correct,
          totalQuestions: qTot,
          totalPoints: totalPts,
          // Si se ingresó 'Puntos', guardamos puntos exactos; si se ingresó 'Porcentaje', no forzamos rawPoints
          rawPoints: puntos != null ? Math.max(0, Math.min(puntos, totalPts)) : null,
          rawPercent: porcentaje != null ? Math.max(0, Math.min(porcentaje, 100)) : null,
          sameDocument: false,
          coverage: 0,
          studentFound: true,
        }
        if (idx >= 0) {
          reviewList[idx] = newRecord
          updated++
        } else {
          reviewList.unshift(newRecord)
          created++
        }
        updates++
      }
      if (updates > 0) {
        try {
          localStorage.setItem(reviewKey, JSON.stringify(reviewList))
          window.dispatchEvent(new StorageEvent('storage', { key: reviewKey, newValue: JSON.stringify(reviewList) }))
        } catch {}
        setHistory(reviewList)
        const msg = `Importación exitosa: ${updates} (nuevos: ${created}, actualizados: ${updated})`
        setImportStatus({ type: 'success', message: msg })
        setStatusModal({ type: 'success', message: msg })
      } else {
        const msg = 'No se procesaron filas con datos válidos.'
        setImportStatus({ type: 'info', message: msg })
        setStatusModal({ type: 'info', message: msg })
      }
    } catch (err) {
      console.warn('[Excel] Import error', err)
      const msg = (err as any)?.message || 'Error al importar archivo'
      setImportStatus({ type: 'error', message: msg })
      setStatusModal({ type: 'error', message: msg })
    } finally {
      setImporting(false)
      if (e.target) e.target.value = '' // reset input
    }
  }, [test, students, history])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
  {/* Ampliamos el ancho del modal y eliminamos límites pequeños para evitar cortes visuales */}
  <DialogContent className="max-w-none w-[min(98vw,1280px)] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{translate('testsReviewTitlePrefix')} {test?.title || translate('testsPageTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* Fila superior: selector de archivo + ejecutar OCR (izquierda) y acciones Excel (derecha) */}
          <div className="flex items-center gap-3">
            <input
              id="review-file-input"
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFile}
              className="hidden"
              aria-label={translate('testsReviewSelectFileAria')}
            />
            <label
              htmlFor="review-file-input"
              className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium bg-fuchsia-600 text-white hover:bg-fuchsia-700 cursor-pointer"
            >
              {translate('testsReviewSelectFile')}
            </label>
            <span className="text-sm text-muted-foreground truncate">
              {file?.name || translate('testsReviewNoFile')}
            </span>

            {/* 🆕 Selector opcional de pauta/revisada (para corregir contra la pauta real del PDF) */}
            <input
              id="review-key-file-input"
              type="file"
              accept="application/pdf,image/*"
              onChange={handleKeyFile}
              className="hidden"
              ref={keyUploadInputRef}
              aria-label="Seleccionar pauta (opcional)"
            />
            <label
              htmlFor="review-key-file-input"
              className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium bg-transparent text-fuchsia-300 hover:text-fuchsia-200 hover:border-fuchsia-300 cursor-pointer"
              title="Seleccionar pauta / versión revisada (opcional)"
            >
              Pauta
            </label>
            {keyFile?.name && (
              <span className="text-xs text-muted-foreground truncate max-w-[220px]" title={keyFile.name}>
                {keyFile.name}
              </span>
            )}

            {/* Ejecutar Análisis Completo (OCR + Gemini Vision) */}
            <Button 
              onClick={runFullAnalysis} 
              disabled={!file || processing || analyzingWithAI}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
              title="Análisis completo: OCR + Gemini Vision para máxima precisión"
            >
              {processing || analyzingWithAI ? '🔄 Analizando...' : '🔍 Analizar Prueba'}
            </Button>
            
            {/* 🆕 Indicador de progreso de validación */}
            {analysisProgress && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-blue-100 to-purple-100 dark:from-blue-900/50 dark:to-purple-900/50 rounded-full">
                <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
                    style={{ width: `${analysisProgress.percent}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-purple-700 dark:text-purple-300 whitespace-nowrap">
                  {analysisProgress.step} {analysisProgress.percent}%
                </span>
              </div>
            )}
            
            {/* Acciones Excel alineadas a la derecha */}
            <div className="ml-auto flex gap-2 items-center">
              <Button
                type="button"
                variant="outline"
                className="h-9 w-9 p-0 border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-100 hover:text-fuchsia-900 hover:border-fuchsia-400"
                title="Descargar plantilla Excel"
                onClick={exportExcelTemplate}
                disabled={!test}
              >
                <Download className="h-4 w-4" />
              </Button>
              <input ref={uploadInputRef} type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} className="hidden" />
              <Button
                type="button"
                variant="outline"
                className="h-9 w-9 p-0 border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-100 hover:text-fuchsia-900 hover:border-fuchsia-400"
                title="Importar notas desde Excel"
                disabled={!test || importing}
                onClick={() => uploadInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}
          {ocr && (
            <div className="border rounded-md p-3 space-y-2">
              <div className="text-sm">
                {/* 🔧 FIX: Siempre mostrar Curso cuando hay un test seleccionado */}
                <span className="font-medium">Curso:</span> {(() => {
                  // Obtener nombre del curso/sección
                  try {
                    const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]')
                    const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]')
                    const sec = sections.find((s: any) => String(s.id) === String(test?.sectionId))
                    const course = courses.find((c: any) => String(c.id) === String(sec?.courseId || test?.courseId))
                    const courseName = `${course?.name || ''} ${sec?.name || ''}`.trim()
                    return courseName || test?.courseName || 'No especificado'
                  } catch {
                    return test?.courseName || 'No especificado'
                  }
                })()}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 ${verification.sameDocument ? 'text-green-600' : 'text-amber-600'}`}>
                  {verification.sameDocument ? '✅' : '⚠️'} 
                  {verification.sameDocument ? translate('testsReviewDocMatches') : translate('testsReviewDocNotMatch')}
                </span>
                {verification.coverage > 0 && (
                  <span className="text-muted-foreground">
                    ({Math.round(verification.coverage * 100)}% {translate('testsReviewCoverage')})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 ${verification.studentFound ? 'text-green-600' : 'text-amber-600'}`}>
                  {verification.studentFound ? '✅' : '⚠️'}
                  {verification.studentFound ? translate('testsReviewStudentInSection') : translate('testsReviewStudentNotInSection')}
                </span>
              </div>
              {/* 🆕 Indicador de si el estudiante respondió */}
              {verification.hasAnswers === false && (
                <div className="flex items-center gap-2 text-xs bg-red-50 dark:bg-red-900/30 p-2 rounded border border-red-200 dark:border-red-800">
                  <span className="text-red-600 dark:text-red-400">
                    ❌ No se detectaron respuestas marcadas - El estudiante parece no haber respondido esta prueba
                  </span>
                </div>
              )}
              {/* 🆕 Resultado del análisis con IA */}
              {aiAnalysis && (
                <div className="text-xs bg-fuchsia-50 dark:bg-fuchsia-900/30 p-2 rounded border border-fuchsia-200 dark:border-fuchsia-800">
                  <div className="font-medium text-fuchsia-700 dark:text-fuchsia-300 mb-1">🤖 Análisis IA (Gemini):</div>
                  <div className="flex flex-wrap gap-2">
                    <span>Confianza: <strong>{aiAnalysis.confidence || 0}%</strong></span>
                    {aiAnalysis.hasAnswers === false && (
                      <span className="text-red-600">⚠️ Sin respuestas detectadas</span>
                    )}
                    {aiAnalysis.studentDetected && (
                      <span>Estudiante detectado: <strong>{aiAnalysis.studentDetected}</strong></span>
                    )}
                  </div>
                  {aiAnalysis.observations && (
                    <div className="mt-1 text-muted-foreground italic">{aiAnalysis.observations}</div>
                  )}
                  {/* 🆕 Detalle de respuestas detectadas - Soporta V/F, MC y MS */}
                  {aiAnalysis.answers && Array.isArray(aiAnalysis.answers) && aiAnalysis.answers.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-fuchsia-200 dark:border-fuchsia-700">
                      <div className="font-medium mb-1">Respuestas detectadas por IA:</div>
                      <div className="flex flex-wrap gap-1">
                        {aiAnalysis.answers.map((ans: any, idx: number) => {
                          const q = test?.questions?.[idx] as any
                          let correct = '?'
                          let isCorrect = false
                          
                          if (q?.type === 'tf') {
                            correct = q.answer ? 'V' : 'F'
                            isCorrect = ans.detected?.toUpperCase() === correct
                          } else if (q?.type === 'mc') {
                            correct = String.fromCharCode(65 + (q.correctIndex || 0))
                            isCorrect = ans.detected?.toUpperCase() === correct
                          } else if (q?.type === 'ms') {
                            const correctLabels = (q.options || [])
                              .map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '')
                              .filter(Boolean)
                              .sort()
                              .join(',')
                            const detectedLabels = (ans.detected || '')
                              .split(',')
                              .map((l: string) => l.trim().toUpperCase())
                              .filter(Boolean)
                              .sort()
                              .join(',')
                            correct = correctLabels
                            isCorrect = correctLabels === detectedLabels
                          } else if (q?.type === 'des') {
                            // 🆕 Preguntas de desarrollo: si hay texto significativo, es correcta
                            const hasText = ans.detected && ans.detected.length > 5
                            correct = 'Respuesta escrita'
                            isCorrect = hasText
                          }
                          
                          return (
                            <span
                              key={idx}
                              className={`px-1.5 py-0.5 rounded text-xs ${
                                !ans.detected ? 'bg-gray-200 text-gray-600' :
                                isCorrect ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'
                              }`}
                              title={`P${ans.questionNum} (${q?.type || '?'}): Detectada=${ans.detected || 'ninguna'}, Correcta=${correct}`}
                            >
                              #{ans.questionNum}: {ans.detected || '-'} {!ans.detected ? '❓' : isCorrect ? '✅' : '❌'}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <details className="text-xs text-muted-foreground">
                <summary>{translate('testsReviewOcrText')}</summary>
                <pre className="whitespace-pre-wrap">{ocr.text}</pre>
              </details>
            </div>
          )}

          {/* 📋 CALIFICACIONES PRELIMINARES DEL PDF DE CURSO */}
          {preliminaryGrades.length > 0 && (
            <div className="border-2 border-amber-400 rounded-md p-3 space-y-3 bg-amber-50 dark:bg-amber-950/30">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  📋 Calificaciones Preliminares ({preliminaryGrades.filter(g => g.hasAnswers !== false).length} estudiantes)
                </div>
                <Button 
                  onClick={saveAllPreliminaryGrades} 
                  disabled={savingGrades || preliminaryGrades.every(g => g.saved) || preliminaryGrades.filter(g => g.hasAnswers !== false).length === 0}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  {savingGrades ? '⏳ Guardando...' : '💾 Guardar Calificaciones y Notificar'}
                </Button>
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300">
                ⚠️ Estas calificaciones aún NO están guardadas. Revisa y presiona "Guardar" para confirmar y enviar notificaciones a estudiantes y apoderados.
              </div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1 pr-2" style={{ width: '20%' }}>Estudiante</th>
                    <th className="text-center py-1 px-2" style={{ width: '10%' }}>Correctas</th>
                    <th className="text-center py-1 px-2" style={{ width: '10%' }}>Respondidas</th>
                    <th className="text-center py-1 px-2" style={{ width: '10%' }}>Puntos</th>
                    <th className="text-center py-1 px-2" style={{ width: '8%' }}>%</th>
                    <th className="text-left py-1 px-2" style={{ width: '27%' }}>Respuestas Detectadas</th>
                    <th className="text-center py-1" style={{ width: '15%' }}>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {preliminaryGrades.map((g, idx) => {
                    const questionsInOCR = g.questionsInOCR || 0
                    const hasAnswers = g.hasAnswers !== false
                    // 🆕 Calcular cuántas respondió (no vacías)
                    const answeredCount = g.detectedAnswers?.filter(a => a.detected !== null && a.detected !== undefined).length || 0
                    return (
                    <tr key={idx} className={`border-t ${!hasAnswers ? 'opacity-60 bg-gray-100 dark:bg-gray-800/50' : ''}`}>
                      <td className="py-1 pr-2">
                        <span className={g.studentInfo ? 'text-green-700' : 'text-amber-600'}>
                          {g.studentInfo ? '✅' : '⚠️'} {g.studentName || 'Sin nombre'}
                        </span>
                        {!hasAnswers && <span className="ml-2 text-red-500 text-xs">(Sin respuestas)</span>}
                      </td>
                      <td className="py-1 px-2 text-center">
                        <span className="font-mono text-green-700 dark:text-green-400" title="Respuestas correctas / Total de preguntas">
                          {hasAnswers ? `${g.score}/${questionsInOCR}` : '-'}
                        </span>
                      </td>
                      {/* 🆕 Nueva columna: Respondidas */}
                      <td className="py-1 px-2 text-center">
                        <span className="font-mono text-blue-700 dark:text-blue-400" title="Preguntas respondidas / Total de preguntas">
                          {hasAnswers ? `${answeredCount}/${questionsInOCR}` : '-'}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-center">
                        <Input
                          type="number"
                          className="h-6 w-16 text-xs text-center mx-auto"
                          value={hasAnswers ? g.pts : 0}
                          onChange={(e) => {
                            const newPts = Math.max(0, Math.min(Number(e.target.value) || 0, 
                              typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : (test?.questions?.length || 100)
                            ))
                            const qTot = test?.questions?.length || 1
                            const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTot
                            const newPct = totalPts > 0 ? Math.round((newPts / totalPts) * 100) : 0
                            const newScore = qTot > 0 ? Math.round((newPts / totalPts) * qTot) : 0
                            setPreliminaryGrades(prev => prev.map((p, i) => 
                              i === idx ? { ...p, pts: newPts, pct: newPct, score: newScore, hasAnswers: newPts > 0 || p.hasAnswers } : p
                            ))
                          }}
                          min={0}
                          disabled={g.saved}
                        />
                      </td>
                      <td className="py-1 px-2 text-center">
                        {hasAnswers ? (
                          <span className={`px-2 py-0.5 rounded ${g.pct >= 60 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            {g.pct}%
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      {/* 🆕 Columna de respuestas detectadas - Muestra TODAS las preguntas */}
                      <td className="py-1 px-2 text-left">
                        {(() => {
                          const questions = test?.questions || []
                          const detectedMap = new Map<number, string | null>()
                          
                          // Crear mapa de respuestas detectadas
                          if (g.detectedAnswers) {
                            for (const ans of g.detectedAnswers) {
                              detectedMap.set(ans.questionNum, ans.detected)
                            }
                          }
                          
                          return (
                            <div className="flex flex-wrap gap-0.5">
                              {questions.map((q: any, qIdx: number) => {
                                const qNum = qIdx + 1
                                const detected = detectedMap.get(qNum)
                                const isEmpty = detected === null || detected === undefined || detected === ''
                                
                                // Determinar respuesta correcta según tipo de pregunta
                                let correctAnswer = '?'
                                let isCorrect = false
                                
                                // 🆕 PRIMERO: Usar respuestas de la PAUTA si existen
                                if (pautaAnswers.size > 0 && pautaAnswers.has(qNum)) {
                                  const pautaAnswer = pautaAnswers.get(qNum)
                                  correctAnswer = String(pautaAnswer || '').toUpperCase()
                                  const studentAnswer = String(detected || '').toUpperCase().trim()
                                  
                                  // Para selección múltiple, ordenar antes de comparar
                                  if (q?.type === 'ms') {
                                    const studentLabels = studentAnswer.split(',').map(l => l.trim()).filter(Boolean).sort().join(',')
                                    const correctLabels = correctAnswer.split(',').map(l => l.trim()).filter(Boolean).sort().join(',')
                                    isCorrect = !isEmpty && studentLabels === correctLabels
                                  } else if (q?.type === 'des') {
                                    // Desarrollo: si hay respuesta significativa, es correcta
                                    isCorrect = !isEmpty && (detected?.length || 0) > 5
                                  } else {
                                    isCorrect = !isEmpty && studentAnswer === correctAnswer
                                  }
                                  
                                  if (qNum === 1) {
                                    console.log(`[UI-BADGE] 🎯 P1 PAUTA: detected="${studentAnswer}" vs pauta="${correctAnswer}" → isCorrect=${isCorrect}`)
                                  }
                                } else {
                                  // FALLBACK: Sin pauta, usar respuestas del test
                                  if (q?.type === 'tf') {
                                    correctAnswer = q.answer ? 'V' : 'F'
                                    isCorrect = !isEmpty && detected?.toUpperCase() === correctAnswer
                                  } else if (q?.type === 'mc') {
                                    correctAnswer = String.fromCharCode(65 + (q.correctIndex || 0))
                                    isCorrect = !isEmpty && detected?.toUpperCase() === correctAnswer
                                  } else if (q?.type === 'ms') {
                                    const correctLabels = (q.options || [])
                                      .map((o: any, j: number) => o.correct ? String.fromCharCode(65 + j) : '')
                                      .filter(Boolean).sort().join(',')
                                    const detectedLabels = (detected || '')
                                      .split(',').map((l: string) => l.trim().toUpperCase())
                                      .filter(Boolean).sort().join(',')
                                    correctAnswer = correctLabels
                                    isCorrect = !isEmpty && correctLabels === detectedLabels
                                  } else if (q?.type === 'des') {
                                    correctAnswer = 'Respuesta escrita'
                                    isCorrect = !isEmpty && (detected?.length || 0) > 5
                                  }
                                }
                                
                                return (
                                  <span
                                    key={qIdx}
                                    className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                                      isEmpty 
                                        ? 'bg-gray-300 text-gray-600 dark:bg-gray-600 dark:text-gray-300' 
                                        : isCorrect 
                                          ? 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200' 
                                          : 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200'
                                    }`}
                                    title={`P${qNum} (${q?.type || '?'}): ${isEmpty ? 'Sin respuesta' : detected} ${isEmpty ? '' : isCorrect ? '✅ Correcto' : `❌ Esperado: ${correctAnswer}`}`}
                                  >
                                    {qNum}:{isEmpty ? '-' : (q?.type === 'des' ? '✍️' : detected)}
                                  </span>
                                )
                              })}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="py-1 text-center">
                        {g.saved ? (
                          <span className="text-green-600">✅ Guardado</span>
                        ) : !hasAnswers ? (
                          <span className="text-red-500">❌ Pendiente</span>
                        ) : (
                          <span className="text-amber-600">⏳ Pendiente</span>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Historial de revisión */}
          <div className="border rounded-md p-3 space-y-2">
            <div className="text-sm font-medium">{translate('testsReviewHistoryTitle') || 'Historial de revisión'}</div>
            {(history.length === 0 && (!test?.sectionId || students.length === 0)) ? (
              <div className="text-xs text-muted-foreground">{translate('testsReviewHistoryEmpty') || 'Sin registros'}</div>
            ) : (
              <div className="overflow-x-hidden">
                {/* Tabla de ancho fijo con columnas iguales */}
                <table className="w-full text-xs table-fixed">
                  <colgroup>
                    {/* Estudiante */}
                    <col style={{ width: '11%' }} />
                    {/* Curso/Sección */}
                    <col style={{ width: '12%' }} />
                    {/* Asignatura */}
                    <col style={{ width: '16%' }} />
                    {/* Tema */}
                    <col style={{ width: '24%' }} />
                    {/* Fecha */}
                    <col style={{ width: '15%' }} />
                    {/* Ptos */}
                    <col style={{ width: '6%' }} />
                    {/* Nota */}
                    <col style={{ width: '6%' }} />
                    {/* Acciones */}
                    <col style={{ width: '10%' }} />
                  </colgroup>
          <thead className="text-muted-foreground">
                    <tr>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">{translate('testsReviewHistoryColStudent')}</th>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">{translate('testsReviewHistoryColCourseSection')}</th>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">{translate('testsReviewHistoryColSubject')}</th>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">{translate('testsReviewHistoryColTopic')}</th>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">{translate('testsReviewHistoryColUploadedAt')}</th>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">Ptos</th>
            <th className="text-left py-1 pr-2 truncate whitespace-nowrap">Nota</th>
            <th className="text-center py-1 pl-2 pr-2 truncate whitespace-nowrap">Acc.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {test?.sectionId && students.length > 0 ? (
                      // Mostrar una fila por estudiante de la sección, usando su última revisión si existe
                      students.map((s) => {
                        const latest = getLatestReviewForStudent(history, s)
      const courseLabel = resolveCourseSectionLabel(latest?.courseId ?? (test?.courseId || null), latest?.sectionId ?? (test?.sectionId || null))
                        const subjectLabel = resolveSubjectName(latest?.subjectId ?? (test?.subjectId || null), latest?.subjectName ?? (test?.subjectName || null))
                        const topic = (latest?.topic || test?.topic || '-')
                        return (
                          <tr key={String(s.id)} className="border-t">
                            <td className="py-1 pr-2 truncate">{s.displayName || s.username || '-'}</td>
                            <td className="py-1 pr-2 truncate">{courseLabel}</td>
                            <td className="py-1 pr-2 truncate">{subjectLabel}</td>
                            <td className="py-1 pr-2 truncate">{topic}</td>
                            <td className="py-1 pr-2 truncate">{latest ? formatDateTime(latest.uploadedAt) : '-'}</td>
                            <td className="py-1 pr-2 truncate whitespace-nowrap">
                              {(() => {
        if (!latest) return '-'
        // Preferir puntos crudos exactos si existen
        if (typeof latest.rawPoints === 'number') return `${latest.rawPoints} pts`
        if (typeof latest.score !== 'number') return '-'
        const qTot = typeof latest.totalQuestions === 'number' ? latest.totalQuestions : (test?.questions?.length || 0)
        const tPts = (latest?.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
        // Si hay porcentaje crudo importado, úsalo para derivar puntos
        if (typeof latest.rawPercent === 'number') {
          const pct = Math.max(0, Math.min(latest.rawPercent, 100)) / 100
          const pts = Math.round(pct * (tPts || qTot))
          return `${pts} pts`
        }
        const pct = qTot > 0 ? Math.min(latest.score, qTot) / qTot : 0
        const pts = Math.round(pct * (tPts || qTot))
        return `${pts} pts`
                              })()}
                            </td>
                            <td className="py-1 pr-2 truncate whitespace-nowrap">
                              {(() => {
                                if (!latest) return '-'
                                const qTot = typeof latest.totalQuestions === 'number' ? latest.totalQuestions : (test?.questions?.length || 0)
                                const tPts = (latest?.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                // Preferir porcentaje crudo importado si existe
                                if (typeof latest.rawPercent === 'number') return `${Math.round(Math.max(0, Math.min(latest.rawPercent, 100)))}%`
                                // Si hay puntos crudos, calcular porcentaje desde ellos
                                if (typeof latest.rawPoints === 'number' && tPts > 0) {
                                  const pct = Math.round((latest.rawPoints / tPts) * 100)
                                  return `${Math.max(0, Math.min(pct, 100))}%`
                                }
                                if (typeof latest.score !== 'number') return '-'
                                if (qTot <= 0) return '-'
                                const pct = Math.round((Math.min(latest.score, qTot) / qTot) * 100)
                                return `${pct}%`
                              })()}
                            </td>
                            <td className="py-1 pl-2 pr-2 text-center">
                              {latest ? (
                                editHistTs === latest.uploadedAt ? (
                                  <div className="inline-flex items-center gap-2">
                                    <Input
                                      type="number"
                                      className="h-7 w-16"
                                      value={typeof editHistScore === 'number' ? editHistScore : ''}
                                      min={0}
                                      max={(() => { const qTot = latest?.totalQuestions ?? (test?.questions?.length ?? 0); const tPts = (latest?.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number; return tPts })()}
                                      onChange={(e) => {
                                        const v = e.target.value
                                        if (v === '') return setEditHistScore(null)
                                        const num = Number(v)
                                        if (Number.isNaN(num)) return
                                        const qTot = latest?.totalQuestions ?? (test?.questions?.length ?? 0)
                                        const tPts = (latest?.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                        const clamped = Math.max(0, Math.min(num, tPts))
                                        setEditHistScore(clamped)
                                      }}
                                    />
                                    <Button size="icon" className="h-7 w-7 shrink-0 p-0 leading-none" onClick={() => {
                                      if (!test?.id || typeof editHistScore !== 'number') return
                                      // Convertir puntos a respuestas correctas
                                      const qTot = latest?.totalQuestions ?? (test?.questions?.length ?? 0)
                                      const tPts = (latest?.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                      const clampedPts = Math.max(0, Math.min(editHistScore, tPts))
                                      const newCorrect = qTot > 0 ? Math.round((clampedPts / tPts) * qTot) : 0
                                      // Actualizamos score y luego en memoria añadimos rawPoints editados
                                      updateReviewByUploadedAt(test.id, latest.uploadedAt, newCorrect, qTot)
                                      const key = getReviewKey(test.id)
                                      const raw = localStorage.getItem(key)
                                      if (raw) {
                                        try {
                                          const arr: ReviewRecord[] = JSON.parse(raw)
                                          const i = arr.findIndex(r => r.uploadedAt === latest.uploadedAt)
                                          if (i >= 0) { arr[i] = { ...arr[i], rawPoints: clampedPts } }
                                          localStorage.setItem(key, JSON.stringify(arr))
                                          setHistory(arr)
                                        } catch { setHistory(JSON.parse(raw)) }
                                      }
                                      setEditHistTs(null); setEditHistScore(null)
                                    }} aria-label="Guardar cambios">
                                      💾
                                    </Button>
                                  </div>
                                ) : (
                                  <Button size="icon" className="h-7 w-7 shrink-0 p-0 leading-none" variant="ghost" onClick={() => {
                                    // Inicializar edición en PUNTOS a partir de respuestas correctas
                                    const qTot = latest?.totalQuestions ?? (test?.questions?.length ?? 0)
                                    const tPts = (latest?.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                    const pts = qTot > 0 ? Math.round((Math.max(0, Math.min(latest?.score ?? 0, qTot)) / qTot) * tPts) : 0
                                        const initialPts = typeof latest?.rawPoints === 'number' ? latest.rawPoints : pts
                                    setEditHistTs(latest.uploadedAt);
                                        setEditHistScore(initialPts)
                                  }} aria-label="Editar">
                                    ✎
                                  </Button>
                                )
                              ) : null}
                            </td>
                          </tr>
                        )
                      })
                    ) : (
            history.map((h, idx) => (
                        <tr key={`${h.uploadedAt}-${idx}`} className="border-t">
              <td className="py-1 pr-2 truncate">{h.studentName}</td>
              <td className="py-1 pr-2 truncate">{resolveCourseSectionLabel(h.courseId, h.sectionId)}</td>
              <td className="py-1 pr-2 truncate">{resolveSubjectName(h.subjectId, h.subjectName)}</td>
              <td className="py-1 pr-2 truncate">{h.topic || '-'}</td>
              <td className="py-1 pr-2 truncate">{formatDateTime(h.uploadedAt)}</td>
                            <td className="py-1 pr-2 truncate whitespace-nowrap">
                {(() => {
                  if (typeof h.score !== 'number') return '-'
                  const qTot = typeof h.totalQuestions === 'number' ? h.totalQuestions : (test?.questions?.length || 0)
                  const tPts = (h.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                  if (typeof h.rawPoints === 'number') {
                    return `${h.rawPoints} pts`
                  }
                  const pct = qTot > 0 ? Math.min(h.score, qTot) / qTot : 0
                  const pts = Math.round(pct * (tPts || qTot))
                  return `${pts} pts`
                })()}
              </td>
                            <td className="py-1 pr-2 truncate whitespace-nowrap">
                {(() => {
                  if (typeof h.score !== 'number') return '-'
                  const qTot = typeof h.totalQuestions === 'number' ? h.totalQuestions : (test?.questions?.length || 0)
                  if (qTot <= 0) return '-'
                  const pct = Math.round((Math.min(h.score, qTot) / qTot) * 100)
                  return `${pct}%`
                })()}
              </td>
                          <td className="py-1 pl-2 pr-2 text-center">
                            {editHistTs === h.uploadedAt ? (
                              <div className="inline-flex items-center gap-2">
                                <Input
                                  type="number"
                                  className="h-7 w-16"
                                  value={typeof editHistScore === 'number' ? editHistScore : ''}
                                  min={0}
                                  max={(() => { const qTot = h.totalQuestions ?? (test?.questions?.length ?? 0); const tPts = (h.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number; return tPts })()}
                                  onChange={(e) => {
                                    const v = e.target.value
                                    if (v === '') return setEditHistScore(null)
                                    const num = Number(v)
                                    if (Number.isNaN(num)) return
                                    const qTot = h.totalQuestions ?? (test?.questions?.length ?? 0)
                                    const tPts = (h.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                    const clamped = Math.max(0, Math.min(num, tPts))
                                    setEditHistScore(clamped)
                                  }}
                                />
                                <Button size="icon" className="h-7 w-7 shrink-0 p-0 leading-none" onClick={() => {
                                  if (!test?.id || typeof editHistScore !== 'number') return
                                  const qTot = h.totalQuestions ?? (test?.questions?.length ?? 0)
                                  const tPts = (h.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                  const clampedPts = Math.max(0, Math.min(editHistScore, tPts))
                                  const newCorrect = qTot > 0 ? Math.round((clampedPts / tPts) * qTot) : 0
                                  updateReviewByUploadedAt(test.id, h.uploadedAt, newCorrect, qTot)
                                  const key = getReviewKey(test.id)
                                  const raw = localStorage.getItem(key)
                                  if (raw) {
                                    try {
                                      const arr: ReviewRecord[] = JSON.parse(raw)
                                      const i = arr.findIndex(r => r.uploadedAt === h.uploadedAt)
                                      if (i >= 0) { arr[i] = { ...arr[i], rawPoints: clampedPts } }
                                      localStorage.setItem(key, JSON.stringify(arr))
                                      setHistory(arr)
                                    } catch { setHistory(JSON.parse(raw)) }
                                  }
                                  setEditHistTs(null); setEditHistScore(null)
                                }} aria-label="Guardar cambios">
                                  💾
                                </Button>
                              </div>
                            ) : (
                              <Button size="icon" className="h-7 w-7 shrink-0 p-0 leading-none" variant="ghost" onClick={() => {
                                const qTot = h.totalQuestions ?? (test?.questions?.length ?? 0)
                                const tPts = (h.totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                                const pts = qTot > 0 ? Math.round((Math.max(0, Math.min(h?.score ?? 0, qTot)) / qTot) * tPts) : 0
                                const initialPts = typeof h.rawPoints === 'number' ? h.rawPoints : pts
                                setEditHistTs(h.uploadedAt);
                                setEditHistScore(initialPts)
                              }} aria-label="Editar">
                                ✎
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        {/* Ventana emergente de estado de importación */}
        {statusModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
            <div className={`rounded-md shadow-lg p-4 max-w-sm w-[90%] bg-white border ${statusModal.type === 'success' ? 'border-green-300' : statusModal.type === 'error' ? 'border-red-300' : 'border-amber-300'}`}>
              <div className={`text-sm ${statusModal.type === 'success' ? 'text-green-700' : statusModal.type === 'error' ? 'text-red-700' : 'text-amber-700'}`}>
                {statusModal.message}
              </div>
              <div className="mt-3 text-right">
                <Button size="sm" onClick={() => setStatusModal(null)}>Cerrar</Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function isLikelyPersonName(name?: string): boolean {
  if (!name) return false
  const s = name.trim()
  if (!s) return false
  if (s.length < 3 || s.length > 50) return false
  // Evitar frases con comas, signos o números
  if (/[\d,;:¡!¿?]/.test(s)) return false
  // Evitar palabras comunes de enunciados
  const bad = /(sistema|respiratorio|verdadero|falso|pregunta|puntos|pts|opcion|opciones|seleccione|funcion|principal|durante|inhalacion|inhalación|clave|asignatura|curso|seccion|sección)/i
  if (bad.test(s)) return false
  // Debe ser 1-4 tokens alfabéticos
  const tokens = s.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > 4) return false
  if (!tokens.every(t => /^[A-Za-zÁÉÍÓÚÑáéíóúñ']{2,}$/.test(t))) return false
  // Ratio de letras alto
  const letters = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ']/g, '').length
  if (letters / s.length < 0.7) return false
  return true
}

function guessStudentName(text: string, knownStudents?: any[]): string {
  // Heurísticas mejoradas para formatos comunes en evaluaciones chilenas/latinoamericanas
  const cleaned = text.replace(/[_•◯●○◉◌]+/g, ' ').replace(/\s+/g, ' ')
  
  // 1) Patrones de etiquetas más amplio (incluyendo casos específicos como "NOMBRE DEL ESTUDIANTE:")
  const labelPatterns = [
    /(nombre\s+(?:del\s+|y\s+apellido\s+del\s+)?estudiante|alumno|estudiante|nombre\s+completo)\s*[:\-]?\s*([^\n]+)/i,
    /(nombre|apellido|estudiante)\s*[:\-]\s*([^\n]+)/i,
    /(datos\s+del\s+estudiante|identificación)\s*[:\-]?\s*([^\n]+)/i,
    /(nombre\s+del\s+estudiante)\s*[:\-]?\s*([^\n\r]+)/i,
    /(estudiante)\s*[:\-]?\s*([^\n\r]+)/i
  ]
  
  for (const pattern of labelPatterns) {
    const match = cleaned.match(pattern)
    if (match?.[2]) {
      const candidate = match[2]
        .replace(/[_–—-]{2,}/g, ' ') // líneas de guiones
        .replace(/\.{3,}/g, ' ') // puntos suspensivos
        .replace(/\s+/g, ' ')
        .trim()
      
      // Filtrar texto que no parece nombre
      if (candidate && !/^[\d\s\-_\.]+$/.test(candidate) && candidate.length > 2) {
        const tokens = candidate.split(/\s+/).filter(token => 
          token.length > 1 && 
          !/^[\d\-_\.]+$/.test(token) &&
          !/^(rut|run|curso|sección|fecha|página|hoja)$/i.test(token)
        )
        if (tokens.length >= 2) return tokens.slice(0, 3).join(' ')
        if (tokens.length === 1 && tokens[0].length > 2) return tokens[0]
      }
    }
  }
  
  // 2) Buscar específicamente después de etiquetas en líneas separadas
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const currentLine = lines[i]
    
    // Detectar líneas con etiquetas de nombre
    if (/(?:nombre|estudiante|alumno|datos)(?:\s+(?:del\s+)?(?:estudiante|alumno))?/i.test(currentLine)) {
      // Buscar en las próximas 5 líneas
      for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
        const nextLine = lines[j]
        const candidate = nextLine
          .replace(/[_–—-]{2,}/g, ' ')
          .replace(/\.{3,}/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        
        // Validar que parece un nombre
        if (candidate && 
            candidate.length > 2 && 
            candidate.length < 50 &&
            !/^[\d\s\-_\.]+$/.test(candidate) &&
            !/(?:rut|run|curso|sección|fecha|página|hoja|asignatura|ciencias|sistema|respiratorio|clave)/i.test(candidate)) {
          const tokens = candidate.split(/\s+/).filter(token => 
            token.length > 1 && 
            !/^[\d\-_\.]+$/.test(token) &&
            !/^(el|la|los|las|de|del|y|o|en|con|por|para)$/i.test(token)
          )
    const candidateName = tokens.slice(0, 3).join(' ')
    if (isLikelyPersonName(candidateName)) return candidateName
        }
      }
    }
  }
  
  // 3) Buscar nombres standalone en las primeras líneas (casos como "Sofia" solo)
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i].trim()
    
    // Permitir nombres simples de 3+ caracteres que no sean palabras comunes
  if (isLikelyPersonName(line)) {
      
      // Verificar que no es parte de un título o encabezado
      const prevLine = i > 0 ? lines[i - 1] : ''
      const nextLine = i < lines.length - 1 ? lines[i + 1] : ''
      
      if (!(/(?:sistema|respiratorio|clave|ciencias|asignatura|curso)/i.test(prevLine) ||
            /(?:sistema|respiratorio|clave|ciencias|asignatura|curso)/i.test(nextLine))) {
        return line
      }
    }
  }
  
  // 4) Buscar patrones tipo "Apellido, Nombre"
  const commaPattern = /([A-ZÁÉÍÓÚÑ][a-záéíóúñ']+)\s*,\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ']+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ']*)?)/
  const commaMatch = text.match(commaPattern)
  if (commaMatch) {
  const cand = `${commaMatch[2]} ${commaMatch[1]}`.trim()
  if (isLikelyPersonName(cand)) return cand
  }
  
  // 5) Última búsqueda: nombres en contexto específico de pruebas
  for (const line of lines.slice(0, 15)) {
    // Buscar líneas que contengan solo un nombre después de información del curso
    if (isLikelyPersonName(line.trim())) {
      return line.trim()
    }
  }
  
  // 6) Intento con lista de estudiantes de la sección: escoger el que mejor calce en el OCR
  try {
    if (Array.isArray(knownStudents) && knownStudents.length > 0) {
      const normText = normalize(text)
      let best: { name: string, score: number } | null = null
      for (const s of knownStudents) {
        const name = String(s.displayName || s.username || '').trim()
        if (!name) continue
        const nName = normalize(name)
        // Presencia directa del nombre completo
        let score = 0
        if (nName && normText.includes(nName)) score = 1
        else score = similarityByTokens(nName, normText)
        if (!best || score > best.score) best = { name, score }
      }
      if (best && best.score >= 0.4) return best.name
    }
  } catch {}

  return ''
}

type AutoGradeResult = {
  correct: number
  breakdown: {
    tf: { correct: number; total: number }
    mc: { correct: number; total: number }
    ms: { correct: number; total: number }
    des: { correct: number; total: number }
  }
  evidence: number
  // Detalles por pregunta para debug
  details?: Array<{
    questionNum: number
    type: string
    detected: string | null
    correct: string
    isCorrect: boolean
  }>
}

function autoGrade(text: string, questions: AnyQuestion[]): AutoGradeResult {
  if (!questions?.length) {
    return {
      correct: 0,
      evidence: 0,
      breakdown: { tf: { correct: 0, total: 0 }, mc: { correct: 0, total: 0 }, ms: { correct: 0, total: 0 }, des: { correct: 0, total: 0 } }
    }
  }
  
  // Normalizar texto para buscar marcas y opciones
  const raw = text
  const norm = normalize(text)
  const lines = raw.split(/\n+/)
  
  // 🔍 DETECCIÓN ESTRICTA DE MARCAS
  // Solo detectar marcas MUY CLARAS para evitar falsos positivos
  // El problema anterior: patrones muy permisivos detectaban caracteres normales como marcas
  
  // 📌 FUNCIÓN MEJORADA: Detectar qué alternativa tiene marca en una línea
  // Balance: Detectar marcas reales sin causar falsos positivos
  const detectMarkedOption = (line: string): string | null => {
    if (!line) return null
    const upper = line.toUpperCase()
    
    // MARCAS que OCR puede detectar para opciones múltiples
    // Incluye variantes de ticks, X, círculos
    const VALID_MARKS = 'X✓✔●◉☑☒✗✘O0/\\\\|V*·•-'
    
    // 1. Buscar paréntesis con marca: A (X), A (✓), A (/)
    for (const mark of VALID_MARKS) {
      const escapedMark = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      
      // Letra seguida de paréntesis con marca: A (X)
      const regex = new RegExp(`([A-D])\\s*\\(\\s*${escapedMark}\\s*\\)`, 'i')
      const match = upper.match(regex)
      if (match) return match[1]
      
      // Paréntesis con marca seguido de letra: (X) A
      const regex2 = new RegExp(`\\(\\s*${escapedMark}\\s*\\)\\s*([A-D])`, 'i')
      const match2 = upper.match(regex2)
      if (match2) return match2[1]
    }
    
    // 2. Buscar paréntesis con contenido no vacío cerca de letra: A ( algo )
    const letterWithContent = upper.match(/([A-D])\s*\(\s*([^\s\)]+)\s*\)/)
    if (letterWithContent) return letterWithContent[1]
    
    const contentBeforeLetter = upper.match(/\(\s*([^\s\)]+)\s*\)\s*([A-D])/)
    if (contentBeforeLetter) return contentBeforeLetter[2]
    
    // 3. Buscar corchetes con marca: A [X], [X] A
    const bracketWithContent = upper.match(/([A-D])\s*\[\s*([^\s\]]+)\s*\]/)
    if (bracketWithContent) return bracketWithContent[1]
    
    const contentBracketBeforeLetter = upper.match(/\[\s*([^\s\]]+)\s*\]\s*([A-D])/)
    if (contentBracketBeforeLetter) return contentBracketBeforeLetter[2]
    
    return null
  }
  
  // 📌 FUNCIÓN: Detectar V o F marcado en una línea
  // Detecta marcas: 1) dentro del paréntesis V(X), 2) sobre/junto a la letra VX
  const detectMarkedTF = (line: string): 'V' | 'F' | null => {
    if (!line) return null
    const lineUpper = line.toUpperCase()
    
    // Solo procesar líneas que tengan V o F
    if (!lineUpper.includes('V') && !lineUpper.includes('F')) return null
    
    // === CASO 1: Marca DENTRO del paréntesis ===
    // Patrones muy flexibles para V(...) y F(...) con cualquier contenido
    // Captura: V(X), V (X), V( X ), V (  X  ), etc.
    const vContentMatch = lineUpper.match(/V\s*\(\s*([^\)]*)\s*\)/)
    const fContentMatch = lineUpper.match(/F\s*\(\s*([^\)]*)\s*\)/)
    
    const vContent = vContentMatch ? vContentMatch[1].trim() : ''
    const fContent = fContentMatch ? fContentMatch[1].trim() : ''
    
    // V tiene contenido no vacío, F está vacío o no existe
    if (vContent.length > 0 && fContent.length === 0) {
      console.log(`[detectMarkedTF] Detectado V con contenido: "${vContent}"`)
      return 'V'
    }
    // F tiene contenido no vacío, V está vacío o no existe
    if (fContent.length > 0 && vContent.length === 0) {
      console.log(`[detectMarkedTF] Detectado F con contenido: "${fContent}"`)
      return 'F'
    }
    
    // Ambos tienen contenido - determinar cuál tiene marca real
    if (vContent.length > 0 && fContent.length > 0) {
      // Caracteres que son marcas válidas
      const isMarkV = /^[X✓✔●◉☑☒✗✘O0\/\\|VY\-\*\(\)]+$/i.test(vContent)
      const isMarkF = /^[X✓✔●◉☑☒✗✘O0\/\\|VY\-\*\(\)]+$/i.test(fContent)
      if (isMarkV && !isMarkF) return 'V'
      if (isMarkF && !isMarkV) return 'F'
    }
    
    // === CASO 2: Marca directamente sobre V o F (sin paréntesis) ===
    const markChars = '[X✓✔●◉☑☒✗✘O0\\/\\\\|\\-\\*xXoO]'
    const vWithMark = new RegExp(`V\\s*${markChars}|${markChars}\\s*V(?![AE])`, 'i').test(lineUpper)
    const fWithMark = new RegExp(`F\\s*${markChars}|${markChars}\\s*F(?![AUI])`, 'i').test(lineUpper)
    
    if (vWithMark && !fWithMark) return 'V'
    if (fWithMark && !vWithMark) return 'F'
    
    return null
  }
  
  // 📌 NUEVO: Extraer TODAS las respuestas V/F del documento completo
  // Busca TODOS los patrones V(...) y F(...) y los empareja secuencialmente
  const extractAllTFResponses = (text: string): Array<'V' | 'F' | null> => {
    const responses: Array<'V' | 'F' | null> = []
    const upper = text.toUpperCase()
    
    // ESTRATEGIA PRINCIPAL: Buscar todos los V(...) y F(...) y emparejarlos
    // Es más robusta que buscar pares en la misma línea
    
    // Buscar todas las ocurrencias de V(...) y F(...)
    const vMatches: Array<{index: number, content: string}> = []
    const fMatches: Array<{index: number, content: string}> = []
    
    const vPattern = /V\s*\(\s*([^\)]*)\s*\)/gi
    const fPattern = /F\s*\(\s*([^\)]*)\s*\)/gi
    
    let vMatch
    while ((vMatch = vPattern.exec(upper)) !== null) {
      vMatches.push({ index: vMatch.index, content: vMatch[1].trim() })
    }
    
    let fMatch
    while ((fMatch = fPattern.exec(upper)) !== null) {
      fMatches.push({ index: fMatch.index, content: fMatch[1].trim() })
    }
    
    console.log('[extractAllTFResponses] V matches:', vMatches.length, vMatches.map(m => `"${m.content}"`))
    console.log('[extractAllTFResponses] F matches:', fMatches.length, fMatches.map(m => `"${m.content}"`))
    
    // Emparejar V y F por proximidad (V siempre viene antes de F en cada pregunta)
    let fIdx = 0
    
    for (const v of vMatches) {
      // Buscar el F más cercano después de este V
      while (fIdx < fMatches.length && fMatches[fIdx].index < v.index) {
        fIdx++
      }
      if (fIdx < fMatches.length) {
        const f = fMatches[fIdx]
        const vContent = v.content
        const fContent = f.content
        
        const vHasMark = vContent.length > 0
        const fHasMark = fContent.length > 0
        
        console.log(`[extractAllTFResponses] Par: V("${vContent}") F("${fContent}")`)
        
        if (vHasMark && !fHasMark) {
          responses.push('V')
        } else if (fHasMark && !vHasMark) {
          responses.push('F')
        } else if (!vHasMark && !fHasMark) {
          responses.push(null) // Sin respuesta
        } else {
          // Ambos tienen contenido - ver cuál es marca real
          const isMarkV = /^[X✓✔●◉☑☒✗✘O0\/\\|VY\-\*]+$/i.test(vContent)
          const isMarkF = /^[X✓✔●◉☑☒✗✘O0\/\\|VY\-\*]+$/i.test(fContent)
          
          if (isMarkV && !isMarkF) responses.push('V')
          else if (isMarkF && !isMarkV) responses.push('F')
          else responses.push(null)
        }
        
        fIdx++ // Avanzar al siguiente F
      }
    }
    
    // Estrategia 2: Si no hay pares detectados, procesar línea por línea
    if (responses.length === 0) {
      const textLines = text.split(/\n+/)
      for (const line of textLines) {
        const result = detectMarkedTF(line)
        if (result !== null) {
          responses.push(result)
        }
      }
    }
    
    console.log('[extractAllTFResponses] Total respuestas extraídas:', responses)
    return responses
  }
  
  // 📌 BUSCAR PREGUNTAS POR NÚMERO
  // Crear un mapa de líneas que contienen números de pregunta
  const questionLineMap = new Map<number, string[]>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Buscar números de pregunta: "1.", "1)", "1-", "Pregunta 1", etc.
    const numMatch = line.match(/^\s*(\d{1,2})\s*[\.\)\-:\s]/)
    if (numMatch) {
      const qNum = parseInt(numMatch[1], 10)
      if (qNum > 0 && qNum <= questions.length) {
        // Capturar esta línea y las siguientes 5 como contexto de la pregunta
        const context = lines.slice(i, Math.min(i + 6, lines.length))
        questionLineMap.set(qNum, context)
      }
    }
  }
  
  const optionLabel = (idx: number) => String.fromCharCode(65 + idx) // A, B, C, D...

  let correct = 0
  let evidence = 0 // cuenta líneas/marcas que respaldan detecciones
  const details: Array<{
    questionNum: number
    type: string
    detected: string | null
    correct: string
    isCorrect: boolean
  }> = []
  const bd = {
    tf: { correct: 0, total: 0 },
    mc: { correct: 0, total: 0 },
    ms: { correct: 0, total: 0 },
    des: { correct: 0, total: 0 },
  }
  
  // 🆕 PRE-EXTRAER todas las respuestas V/F del documento completo
  // Esto funciona como respaldo cuando la búsqueda por contexto falla
  const allTFResponses = extractAllTFResponses(raw)
  let tfQuestionIndex = 0 // Índice para mapear respuestas extraídas a preguntas TF
  
  console.log('[AutoGrade] Respuestas V/F extraídas del documento:', allTFResponses)
  
  // Procesar preguntas una por una
  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]
    const qNum = qIdx + 1 // Número de pregunta (1-indexed)
    
    // Obtener las líneas relevantes para esta pregunta
    const questionContext = questionLineMap.get(qNum) || []
    const contextText = questionContext.join('\n')
    
    if ((q as any).type === 'tf') {
      bd.tf.total++
      const tf = q as QuestionTF
      const correctAnswer = tf.answer ? 'V' : 'F'
      
      // 🔍 NUEVO: Buscar en el contexto de la pregunta específica primero
      let detected: 'V' | 'F' | null = null
      
      // 1) Buscar en el contexto específico de la pregunta
      for (const line of questionContext) {
        detected = detectMarkedTF(line)
        if (detected) {
          evidence++
          break
        }
      }
      
      // 2) Si no se encontró, buscar en todas las líneas que mencionan el número de pregunta
      if (!detected) {
        for (const line of lines) {
          // Verificar si la línea contiene el número de pregunta
          const numPattern = new RegExp(`^\\s*${qNum}\\s*[\\.\\)\\-:\\s]`, 'i')
          if (numPattern.test(line)) {
            detected = detectMarkedTF(line)
            if (detected) {
              evidence++
              break
            }
            // También buscar en las siguientes líneas
            const lineIdx = lines.indexOf(line)
            for (let j = lineIdx; j < Math.min(lineIdx + 4, lines.length); j++) {
              detected = detectMarkedTF(lines[j])
              if (detected) {
                evidence++
                break
              }
            }
            if (detected) break
          }
        }
      }
      
      // 3) RESPALDO: Usar las respuestas pre-extraídas del documento completo
      if (!detected && tfQuestionIndex < allTFResponses.length) {
        detected = allTFResponses[tfQuestionIndex]
        if (detected) {
          evidence++
          console.log(`[TF #${qNum}] Usando respuesta pre-extraída: ${detected}`)
        }
      }
      tfQuestionIndex++ // Avanzar al siguiente índice TF
      
      const isCorrectAnswer = detected === correctAnswer
      details.push({ questionNum: qNum, type: 'tf', detected, correct: correctAnswer, isCorrect: isCorrectAnswer })
      
      console.log(`[TF #${qNum}] Correcta=${correctAnswer}, Detectada=${detected}, ✓=${isCorrectAnswer}`)
      
      if (isCorrectAnswer) {
        correct++
        bd.tf.correct++
      }
      continue
    }
    
    if ((q as any).type === 'mc') {
      bd.mc.total++
      const mc = q as QuestionMC
      const correctIdx = mc.correctIndex
      const correctLabel = optionLabel(correctIdx)
      
      let detected: string | null = null
      
      // 1) Buscar en el contexto específico de la pregunta
      for (const line of questionContext) {
        detected = detectMarkedOption(line)
        if (detected) {
          evidence++
          break
        }
      }
      
      // 2) Si no se encontró, buscar por número de pregunta
      if (!detected) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const numPattern = new RegExp(`^\\s*${qNum}\\s*[\\.\\)\\-:\\s]`, 'i')
          if (numPattern.test(line)) {
            // Buscar la opción marcada en las siguientes líneas
            for (let j = i; j < Math.min(i + 8, lines.length); j++) {
              detected = detectMarkedOption(lines[j])
              if (detected) {
                evidence++
                break
              }
            }
            if (detected) break
          }
        }
      }
      
      // ❌ ELIMINADO: Fallback que buscaba en TODAS las líneas (causaba falsos positivos)
      // Si no encontramos marca clara en el contexto de la pregunta, NO asumir respuesta
      
      const isCorrectAnswer = detected?.toUpperCase() === correctLabel
      details.push({ questionNum: qNum, type: 'mc', detected, correct: correctLabel, isCorrect: isCorrectAnswer })
      
      console.log(`[MC #${qNum}] Correcta=${correctLabel}, Detectada=${detected}, ✓=${isCorrectAnswer}`)
      
      if (isCorrectAnswer) {
        correct++
        bd.mc.correct++
      }
      continue
    }
    
    if ((q as any).type === 'ms') {
      bd.ms.total++
      const ms = q as QuestionMS
      const correctOptions = ms.options.filter(o => o.correct)
      const correctLabels = ms.options.map((o, i) => o.correct ? optionLabel(i) : null).filter(Boolean)
      let correctSelections = 0
      let incorrectSelections = 0
      const detectedOptions: string[] = []
      
      // Verificar cada opción buscando marcas
      for (let i = 0; i < ms.options.length; i++) {
        const option = ms.options[i]
        const label = optionLabel(i)
        let isSelected = false
        
        // Buscar en el contexto de la pregunta
        for (const line of questionContext) {
          const detected = detectMarkedOption(line)
          if (detected?.toUpperCase() === label) {
            isSelected = true
            break
          }
        }
        
        // Buscar en todas las líneas si no se encontró
        if (!isSelected) {
          for (const line of lines) {
            const detected = detectMarkedOption(line)
            if (detected?.toUpperCase() === label) {
              isSelected = true
              break
            }
          }
        }
        
        if (isSelected) {
          detectedOptions.push(label)
          if (option.correct) {
            correctSelections++
          } else {
            incorrectSelections++
          }
        }
      }
      
      // Otorgar punto solo si todas las correctas están seleccionadas y ninguna incorrecta
      const isCorrectAnswer = correctSelections === correctOptions.length && incorrectSelections === 0 && correctOptions.length > 0
      details.push({ questionNum: qNum, type: 'ms', detected: detectedOptions.join(',') || null, correct: correctLabels.join(','), isCorrect: isCorrectAnswer })
      
      if (isCorrectAnswer) {
        correct++
        bd.ms.correct++
        evidence++
      }
      continue
    }
    
    // Para preguntas de desarrollo, no auto-calificar (requiere revisión manual)
    if ((q as any).type === 'des') {
      bd.des.total++
      details.push({ questionNum: qNum, type: 'des', detected: null, correct: 'manual', isCorrect: false })
      // Las preguntas de desarrollo se califican manualmente
      continue
    }
  }
  
  // Log de detalles de calificación
  console.log('[AutoGrade] Detalles:', details.map(d => `#${d.questionNum}(${d.type}): ${d.detected || '?'} vs ${d.correct} = ${d.isCorrect ? '✓' : '✗'}`).join(', '))
  
  // Total auto-calificables
  const autoTotal = bd.tf.total + bd.mc.total + bd.ms.total
  // Si detectamos 100% pero la evidencia es muy baja, suavizar
  let adjustedCorrect = correct
  if (autoTotal > 0 && correct === autoTotal && evidence < Math.max(2, Math.ceil(autoTotal * 0.2))) {
    // Solo ajustar si realmente no hay evidencia clara
    adjustedCorrect = Math.max(0, autoTotal - 1)
  }
  
  return { correct: adjustedCorrect, breakdown: bd, evidence, details }
}

// ===== Utilidades nuevas =====

type ReviewRecord = {
  testId: string
  uploadedAt: number
  studentName: string
  studentId: string | null
  courseId: string | null
  sectionId: string | null
  subjectId: string | null
  subjectName: string | null
  topic: string
  score: number | null
  totalQuestions: number | null
  totalPoints?: number | null
  // Puntos originales exactos (sin reconversión ni redondeo adicional) ingresados manualmente o importados
  rawPoints?: number | null
  // Porcentaje original (0-100) importado desde Excel (si se usó la columna Porcentaje)
  rawPercent?: number | null
  sameDocument: boolean
  coverage: number
  studentFound: boolean
}

function getReviewKey(testId: string) {
  return `smart-student-test-reviews_${testId}`
}

function persistReview(r: ReviewRecord) {
  try {
    const key = getReviewKey(r.testId)
    const prev: ReviewRecord[] = JSON.parse(localStorage.getItem(key) || '[]')
    const next = [r, ...prev].slice(0, 200)
    localStorage.setItem(key, JSON.stringify(next))
    // Intentar notificar si hay listeners
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(next) }))
  } catch (e) {
    console.warn('[TestReview] No se pudo guardar historial:', e)
  }
}

function updateReviewByUploadedAt(testId: string, uploadedAt: number, newScore: number, totalQuestions: number | null) {
  try {
    const key = getReviewKey(testId)
    const list: ReviewRecord[] = JSON.parse(localStorage.getItem(key) || '[]')
    const idx = list.findIndex(r => r.uploadedAt === uploadedAt)
    if (idx >= 0) {
  // Mantener rawPoints si ya existía; no podemos reconstruir puntos exactos sin el valor editado, así que aceptaremos que se actualizará aparte si corresponde.
  list[idx] = { ...list[idx], score: newScore, totalQuestions }
      localStorage.setItem(key, JSON.stringify(list))
      try { window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(list) })) } catch {}
      return true
    }
    return false
  } catch {
    return false
  }
}

function updateLatestReviewScore(params: { testId: string, studentId: string, studentName: string, newScore: number, totalQuestions: number | null }) {
  try {
    const key = getReviewKey(params.testId)
    const list: ReviewRecord[] = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(list) || list.length === 0) return
    // Buscar el último registro del estudiante por nombre o id
    let idx = list.findIndex(r => (r.studentId && String(r.studentId) === String(params.studentId)))
    if (idx < 0) {
      const target = normalize(params.studentName)
      idx = list.findIndex(r => normalize(r.studentName) === target)
    }
    if (idx >= 0) {
  list[idx] = { ...list[idx], score: params.newScore, totalQuestions: params.totalQuestions }
      localStorage.setItem(key, JSON.stringify(list))
      try { window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(list) })) } catch {}
    }
  } catch (e) {
    console.warn('[TestReview] No se pudo actualizar la nota en historial:', e)
  }
}

function normalize(s: string) {
  try {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return s || ''
  }
}

// ===== Persistencia de notas por prueba/estudiante =====

type TestGrade = {
  id: string // compuesto testId-studentId
  testId: string
  studentId: string
  studentName: string
  score: number
  courseId: string | null
  sectionId: string | null
  subjectId: string | null
  title?: string
  gradedAt: number
}

function upsertTestGrade(input: { testId: string; studentId: string; studentName: string; score: number; courseId: string | null; sectionId: string | null; subjectId: string | null; title?: string; skipEmail?: boolean }) {
  try {
    const { LocalStorageManager } = require('@/lib/education-utils');
    const saved = Number(localStorage.getItem('admin-selected-year') || '');
    const year = Number.isFinite(saved) && saved > 0 ? saved : new Date().getFullYear();
    const key = LocalStorageManager.keyForTestGrades(year);
    const id = `${input.testId}-${input.studentId}`;
    const list: TestGrade[] = Array.isArray(LocalStorageManager.getTestGradesForYear(year)) ? LocalStorageManager.getTestGradesForYear(year) : [];
    const idx = list.findIndex(g => g.id === id);
    const rec: TestGrade = {
      id,
      testId: input.testId,
      studentId: input.studentId,
      studentName: input.studentName,
      score: Math.max(0, Math.min(100, Math.round(input.score))),
      courseId: input.courseId,
      sectionId: input.sectionId,
      subjectId: input.subjectId,
      title: input.title,
      gradedAt: Date.now(),
    };
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    // Prefer session to save quota during heavy imports from OCR
    LocalStorageManager.setTestGradesForYear(year, list, { preferSession: true });
    try { window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(list) })) } catch {}
    
    // 📧 Enviar email al estudiante y apoderado cuando se califica una prueba
    // ⚠️ skipEmail=true cuando el email ya se envía desde otra función (ej: saveAllPreliminaryGrades)
    if (input.skipEmail) {
      console.log(`📧 [PRUEBA CALIFICADA] Email omitido (skipEmail=true) para ${input.studentName}`);
      return;
    }
    
    try {
      const recipientIds: string[] = [input.studentId];
      
      // Buscar apoderados del estudiante
      // Método 1: smart-student-guardians-{year}
      const guardiansForYear = JSON.parse(localStorage.getItem(`smart-student-guardians-${year}`) || '[]');
      let guardianIds: string[] = [];
      
      if (guardiansForYear.length > 0) {
        guardianIds = guardiansForYear
          .filter((g: any) => g.studentIds?.includes(input.studentId))
          .map((g: any) => g.id);
        console.log(`📧 [PRUEBA CALIFICADA] Apoderados por guardians-year: ${guardianIds.length}`);
      }
      
      // Método 2: smart-student-users (fallback)
      if (guardianIds.length === 0) {
        const storedUsers = localStorage.getItem('smart-student-users');
        if (storedUsers) {
          const allUsers = JSON.parse(storedUsers);
          guardianIds = allUsers
            .filter((u: any) => 
              u.role === 'guardian' && 
              (u.assignedStudents?.includes(input.studentId) ||
               u.studentIds?.includes(input.studentId) ||
               u.children?.includes(input.studentId))
            )
            .map((u: any) => u.id);
          console.log(`📧 [PRUEBA CALIFICADA] Apoderados por users: ${guardianIds.length}`);
        }
      }
      
      recipientIds.push(...guardianIds);
      
      console.log(`📧 [PRUEBA CALIFICADA] Enviando email a ${recipientIds.length} destinatario(s) (1 estudiante + ${guardianIds.length} apoderados)`);
      
      // Obtener nombre legible del curso en lugar del ID
      const courseDisplayName = resolveCourseSectionLabel(input.courseId, input.sectionId);
      
      sendEmailOnNotification(
        'grade_published',
        recipientIds,
        {
          title: `Tu prueba "${input.title || 'Prueba'}" ha sido calificada`,
          content: `Tu prueba ha sido revisada y calificada con un puntaje de ${rec.score}%.`,
          taskTitle: input.title || 'Prueba',
          senderName: 'Profesor',
          courseName: courseDisplayName || input.courseId || '',
          grade: rec.score,
          feedback: `Puntaje: ${rec.score}%`
        }
      ).then(() => {
        console.log(`📧 [PRUEBA CALIFICADA] Email enviado exitosamente`);
      }).catch((emailError) => {
        console.warn('⚠️ [PRUEBA CALIFICADA] Error enviando email:', emailError);
      });
    } catch (emailError) {
      console.warn('⚠️ [PRUEBA CALIFICADA] Error en envío de email:', emailError);
    }
  } catch (e) {
    console.warn('[TestReview] upsertTestGrade error:', e);
  }
}

// ===== Heurística: extraer nombre desde nombre de archivo =====
function guessStudentNameFromFilename(filename: string): string {
  try {
    // Remover extensión
    const base = filename.replace(/\.[a-zA-Z0-9]+$/, '')
    // Separar por delimitadores comunes
    const parts = base.split(/[\s_.\-()]+/).filter(Boolean)
    // Ignorar palabras comunes del contexto escolar
    const ignore = new Set(['sistema','respiratorio','clave','ciencias','naturales','basico','básico','asignatura','tema','curso','seccion','sección','guia','prueba','test','evaluacion','evaluación','nombre','estudiante'])
    // Buscar tokens que parecen nombres propios (capitalizados y alfabéticos)
    const candidates = parts.filter(p => /^[A-Za-zÁÉÍÓÚÑáéíóúñ]+$/.test(p) && p.length >= 3 && !ignore.has(p.toLowerCase()))
    if (candidates.length === 0) return ''
    // Unir hasta 2-3 tokens si existen
    const pick = candidates.slice(-2).join(' ')
    // Capitalizar correctamente
    return pick.replace(/\b([a-záéíóúñ])/g, (m) => m.toUpperCase())
  } catch {
    return ''
  }
}

function verifySameDocument(ocrText: string, questions: AnyQuestion[]) {
  if (!questions?.length) return { isMatch: false, coverage: 0 }
  
  const text = normalize(ocrText)
  let matched = 0
  let checked = 0
  
  for (const q of questions) {
    let stem = ''
    let options: string[] = []
    
    if ((q as any).type === 'tf' || (q as any).type === 'mc' || (q as any).type === 'ms') {
      stem = normalize((q as any).text || '')
      if ((q as any).type === 'mc') {
        options = ((q as any).options || []).map((opt: string) => normalize(opt))
      }
      if ((q as any).type === 'ms') {
        options = (((q as any).options || []) as Array<{text: string}>).map(opt => normalize(opt.text || ''))
      }
    } else if ((q as any).type === 'des') {
      stem = normalize((q as any).prompt || '')
    }
    
    if (!stem || stem.length < 8) continue // ignorar stems muy cortos
    checked++
    
    // Estrategias múltiples para matching más robusto
    let foundMatch = false
    
    // 1) Match exacto de fragmento inicial (más largo para mayor precisión)
    const fragment = stem.slice(0, Math.min(60, stem.length))
    if (text.includes(fragment)) {
      foundMatch = true
    }
    
    // 2) Match por fragmentos más cortos si el fragmento largo no funciona
    if (!foundMatch && stem.length > 20) {
      const shortFragment = stem.slice(0, 20)
      if (text.includes(shortFragment)) {
        foundMatch = true
      }
    }
    
    // 3) Match por palabras clave significativas (tolerante a errores OCR)
    if (!foundMatch) {
      const keywords = stem.split(/\s+/)
        .filter(word => word.length > 4) // palabras significativas
        .filter(word => !['sobre', 'para', 'desde', 'hasta', 'como', 'entre', 'durante', 'mediante', 'según', 'respecto', 'acerca', 'sistema', 'que', 'cual', 'cuando', 'donde'].includes(word))
      
      if (keywords.length > 0) {
        const keywordMatches = keywords.filter(keyword => {
          // Buscar palabra exacta o variaciones OCR comunes
          return text.includes(keyword) || 
                 text.includes(keyword.replace(/o/g, '0')) || // o -> 0
                 text.includes(keyword.replace(/i/g, '1')) || // i -> 1
                 text.includes(keyword.replace(/s/g, '5'))    // s -> 5
        }).length
        const keywordRatio = keywordMatches / keywords.length
        if (keywordRatio >= 0.5) { // 50% de palabras clave encontradas
          foundMatch = true
        }
      }
    }
    
    // 4) Para MC y MS: verificar si las opciones están presentes
    if (!foundMatch && options.length > 0) {
      const optionMatches = options.filter(opt => {
        if (opt.length < 5) return false
        const optFragment = opt.slice(0, Math.min(25, opt.length))
        return text.includes(optFragment) || 
               text.includes(optFragment.replace(/o/g, '0')) ||
               text.includes(optFragment.replace(/i/g, '1'))
      }).length
      
      // Si al menos 50% de las opciones están presentes
      if (optionMatches >= Math.max(1, Math.ceil(options.length * 0.5))) {
        foundMatch = true
      }
    }
    
    // 5) Match fuzzy con tolerancia alta para caracteres similares
    if (!foundMatch) {
      // Crear versión fuzzy reemplazando caracteres comúnmente confundidos por OCR
      const fuzzyStem = stem
        .replace(/[aeiouáéíóú]/g, '.') // vocales con comodín
        .replace(/[0o]/g, '[0o]')      // 0 y o intercambiables
        .replace(/[1li]/g, '[1li]')    // 1, l, i intercambiables
        .replace(/[5s]/g, '[5s]')      // 5 y s intercambiables
        .slice(0, 30) // limitar longitud para evitar regex muy complejos
      
      try {
        const fuzzyRegex = new RegExp(fuzzyStem, 'i')
        if (fuzzyRegex.test(text)) {
          foundMatch = true
        }
      } catch (e) {
        // Si el regex falla, intentar match simple por partes
        const words = stem.split(/\s+/).slice(0, 3) // primeras 3 palabras
        const wordMatches = words.filter(word => 
          word.length > 3 && text.includes(word)
        ).length
        if (wordMatches >= Math.max(1, Math.ceil(words.length * 0.6))) {
          foundMatch = true
        }
      }
    }
    
    // 6) Para preguntas de Verdadero/Falso, buscar patrones específicos
    if (!foundMatch && (q as any).type === 'tf') {
      const tfIndicators = ['verdadero', 'falso', 'v()', 'f()', 'correcto', 'incorrecto']
      if (tfIndicators.some(indicator => text.includes(indicator))) {
        // Si encontramos indicadores de V/F, es muy probable que sea la misma prueba
        foundMatch = true
      }
    }
    
    if (foundMatch) matched++
  }
  
  const coverage = checked > 0 ? matched / checked : 0
  // Umbral aún más flexible: 20% para documentos con mucho ruido OCR
  const isMatch = coverage >= 0.2
  
  console.log(`[Verificación] Preguntas verificadas: ${checked}, Coincidencias: ${matched}, Cobertura: ${Math.round(coverage * 100)}%`)
  
  return { isMatch, coverage }
}

function similarityByTokens(a: string, b: string) {
  const A = new Set(normalize(a).split(/\s+/).filter(Boolean))
  const B = new Set(normalize(b).split(/\s+/).filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  return inter / union
}

function findStudentInSection(guessedName: string, courseId?: string | null, sectionId?: string | null) {
  try {
    if (!sectionId) return null
    const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]') as any[]
    const assignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]') as any[]
    const target = normalize(guessedName)
    const ids = new Set(
      assignments
        .filter(a => String(a.sectionId) === String(sectionId))
        .map(a => String(a.studentId || a.studentUsername))
    )
    const list = users.filter(u => (u.role === 'student' || u.role === 'estudiante') && (ids.has(String(u.id)) || ids.has(String(u.username))))
    // 1) match directo por inclusión
    for (const u of list) {
      const dn = normalize(u.displayName || '')
      const un = normalize(u.username || '')
      if (!target) continue
      if ((dn && (dn.includes(target) || target.includes(dn))) || (un && un === target)) return u
    }
    // 2) fuzzy por tokens si no hubo match directo
    let best: any = null
    let bestScore = 0
    for (const u of list) {
      const dn = normalize(u.displayName || '')
      const s = similarityByTokens(target, dn)
      if (s > bestScore) { bestScore = s; best = u }
    }
    if (best && bestScore >= 0.5) return best
    return null
  } catch {
    return null
  }
}

function resolveCourseSectionLabel(courseId?: string | null, sectionId?: string | null) {
  try {
    const courses = JSON.parse(localStorage.getItem('smart-student-courses') || '[]')
    const sections = JSON.parse(localStorage.getItem('smart-student-sections') || '[]')
    const sec = sections.find((s: any) => String(s.id) === String(sectionId))
    const course = courses.find((c: any) => String(c.id) === String(courseId || sec?.courseId))
    const courseLabel = course?.name ? String(course.name) : ''
    const sectionLabel = sec?.name ? String(sec.name) : ''
    return [courseLabel, sectionLabel].filter(Boolean).join(' ')
  } catch {
    return ''
  }
}

function resolveSubjectName(subjectId?: string | null, subjectName?: string | null) {
  try {
    const subjects = JSON.parse(localStorage.getItem('smart-student-subjects') || '[]')
    const subj = subjects.find((s: any) => String(s.id) === String(subjectId)) || subjects.find((s: any) => String(s.name) === String(subjectId))
    return subj?.name || subjectName || ''
  } catch {
    return subjectName || ''
  }
}

function formatDateTime(ts?: number) {
  try {
    if (!ts) return '-'
    const d = new Date(ts)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
  } catch { return '-' }
}

function getLatestReviewForStudent(history: ReviewRecord[], student: any): ReviewRecord | null {
  try {
    if (!history?.length) return null
    const sid = String(student.id ?? student.username ?? '')
    const dn = normalize(student.displayName || '')
    const un = normalize(student.username || '')

    // 1) Coincidencia por studentId exacto si está disponible en el historial
    const byId = history.filter(h => h.studentId && String(h.studentId) === sid)
    if (byId.length) return byId.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))[0]

    // 2) Fallback: coincidencia por nombre/token
    const matches = history.filter(h => {
      const hs = normalize(h.studentName || '')
      return (dn && (hs.includes(dn) || dn.includes(hs))) || (un && hs === un)
    })
    if (!matches.length) return null
    return matches.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))[0]
  } catch {
    return null
  }
}
