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
  }
}

type OCRResult = {
  text: string
  confidence?: number
}

export default function TestReviewDialog({ open, onOpenChange, test }: Props) {
  const { translate } = useLanguage()
  const [file, setFile] = useState<File | null>(null)
  const [ocr, setOcr] = useState<OCRResult | null>(null)
  const [processing, setProcessing] = useState(false)
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
  const [verification, setVerification] = useState<{ sameDocument: boolean; coverage: number; studentFound: boolean; studentId?: string | null }>({ sameDocument: false, coverage: 0, studentFound: false, studentId: null })
  const [students, setStudents] = useState<any[]>([])
  const [manualAssignId, setManualAssignId] = useState<string>("")
  // Edición directa en historial
  const [editHistTs, setEditHistTs] = useState<number | null>(null)
  const [editHistScore, setEditHistScore] = useState<number | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
  // Modal emergente para mensajes de estado (por requerimiento)
  const [statusModal, setStatusModal] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)

  useEffect(() => {
    if (!open) {
      // reset al cerrar
      setFile(null)
      setOcr(null)
      setProcessing(false)
      setScore(null)
  setEditScore(null)
      setStudentName("")
      setError("")
      setVerification({ sameDocument: false, coverage: 0, studentFound: false, studentId: null })
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

  // Utilidad: obtener estudiantes por sectionId desde assignments
  const getStudentsForSection = useCallback((sectionId: string) => {
    const users = JSON.parse(localStorage.getItem('smart-student-users') || '[]') as any[]
    const assignments = JSON.parse(localStorage.getItem('smart-student-student-assignments') || '[]') as any[]
    const ids = new Set(
      assignments
        .filter(a => String(a.sectionId) === String(sectionId))
        .map(a => String(a.studentId || a.studentUsername))
    )
    const list = users.filter(u => (u.role === 'student' || u.role === 'estudiante') && (ids.has(String(u.id)) || ids.has(String(u.username))))
    list.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')))
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

  const runOCR = useCallback(async () => {
    if (!file) return
    setProcessing(true)
    setError("")
    try {
      const Tesseract = await ensureWorker()
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
      setVerification({ sameDocument: sameDoc.isMatch, coverage: sameDoc.coverage, studentFound: !!studentInfo, studentId: studentInfo?.id || null })
  // 3) Calificar siempre (se mostrará como vista previa si no pasa la verificación)
  const graded = autoGrade(text, test?.questions || [])
  let computed: number | null = graded.correct
  setBreakdown(graded.breakdown)
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
    } catch (e: any) {
      console.error(e)
      setError(e?.message || "Error al procesar OCR")
    } finally {
      setProcessing(false)
    }
  }, [file, ensureWorker, test?.questions, students])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
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
        // Calcular correct answers
        let correct = 0
        if (puntos != null && totalPts > 0 && qTot > 0) {
          const clampedPts = Math.max(0, Math.min(puntos, totalPts))
          correct = Math.round((clampedPts / totalPts) * qTot)
        } else if (porcentaje != null && qTot > 0) {
          const clampedPct = Math.max(0, Math.min(porcentaje, 100))
          correct = Math.round((clampedPct / 100) * qTot)
        }
        // Mapear a studentId real si existe
        let studentObj: any = null
        if (students.length) {
          studentObj = students.find(s => String(s.id) === rawId || String(s.username) === rawId) || students.find(s => (s.displayName || '').toLowerCase() === rawName.toLowerCase())
        }
        const studentId = studentObj ? String(studentObj.id || studentObj.username) : (rawId || rawName)
        const studentName = studentObj ? (studentObj.displayName || studentObj.username) : rawName || rawId
        if (!studentId || !studentName) continue
        // Upsert grade (guardar como porcentaje 0-100)
        const pct = qTot > 0 ? Math.round((Math.max(0, Math.min(correct, qTot)) / qTot) * 100) : 0
        upsertTestGrade({
          testId: test.id,
          studentId,
          studentName,
          score: pct,
          courseId: test.courseId || null,
          sectionId: test.sectionId || null,
          subjectId: test.subjectId || null,
          title: test.title || '',
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
            {/* Ejecutar OCR */}
            <Button onClick={runOCR} disabled={!file || processing}>
              {processing ? translate('testsReviewProcessing') : translate('testsReviewRunOCR')}
            </Button>
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
                <span className="font-medium">{translate('testsReviewStudent')}</span> {studentName || translate('testsReviewNotDetected')}
                {!studentName && (
                  <div className="text-xs text-amber-600 mt-1">
                    💡 Sugerencia: Busque líneas con "Nombre:", "Estudiante:", o nombres en las primeras líneas del texto OCR
                  </div>
                )}
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
              <div className="text-sm flex items-center gap-3 flex-wrap">
                <div>
                  <span className="font-medium">{translate('testsReviewScore')}</span>
                  {(() => {
                    const qTotal = test?.questions?.length || 0
                    const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : qTotal
                    const pct = typeof score === 'number' && qTotal > 0 ? Math.round((score / qTotal) * 100) : null
                    const pts = typeof score === 'number' && qTotal > 0 ? Math.round((score / qTotal) * totalPts) : null
                    const badgeClass = typeof pct === 'number'
                      ? pct >= 60 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      : 'bg-gray-100 text-gray-600'
                    return (
                      <span className={`ml-2 px-2 py-1 rounded text-sm font-medium ${badgeClass}`}>
                        {typeof pts === 'number' ? `${pts} pts${pct !== null ? ` (${pct}%)` : ''}` : 'No calculado'}
                      </span>
                    )
                  })()}
                  {/* Distribución por tipo */}
                  {breakdown && (
                    <span className="ml-3 text-xs text-muted-foreground whitespace-nowrap">
                      TF: {breakdown.tf.correct}/{breakdown.tf.total} · MC: {breakdown.mc.correct}/{breakdown.mc.total} · MS: {breakdown.ms.correct}/{breakdown.ms.total} · DES: {breakdown.des.correct}/{breakdown.des.total}
                    </span>
                  )}
                </div>
                {/* Editor de nota */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">Editar puntaje (pts):</label>
                  <Input
                    type="number"
                    className="h-8 w-24"
          value={typeof editScore === 'number' ? editScore : ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') return setEditScore(null)
                      const num = Number(v)
                      if (!Number.isNaN(num)) {
            const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0
            const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot
            const clamped = Math.max(0, Math.min(num, totalPts))
                        setEditScore(clamped)
                      }
                    }}
                    min={0}
                    max={(() => { const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0; const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot; return totalPts })()}
                  />
                  {/* Guardar cambios cuando ya hay estudiante detectado */}
                  {verification.studentFound && typeof editScore === 'number' && (
                    <Button size="sm" onClick={() => {
                      if (!test?.id || !verification.studentId) return
                      // Convertir puntos a respuestas correctas antes de guardar
                      const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0
                      const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot
                      const clampedPts = Math.max(0, Math.min(editScore, totalPts))
                      const newCorrect = qTot > 0 ? Math.round((clampedPts / totalPts) * qTot) : 0
                      // Guardar en porcentaje (0-100)
                      upsertTestGrade({
                        testId: test.id,
                        studentId: String(verification.studentId),
                        studentName: studentName || '',
                        score: (qTot > 0 ? Math.round((Math.max(0, Math.min(newCorrect, qTot)) / qTot) * 100) : 0),
                        courseId: test.courseId || null,
                        sectionId: test.sectionId || null,
                        subjectId: test.subjectId || null,
                        title: test.title || '',
                      })
                      // Actualizar UI e historial
                      setScore(newCorrect)
                      setEditScore(clampedPts)
                      try {
                        updateLatestReviewScore({
                          testId: test.id,
                          studentId: String(verification.studentId),
                          studentName: studentName || '',
                          newScore: newCorrect,
                          totalQuestions: Array.isArray(test?.questions) ? test.questions.length : null,
                        })
                        // Refrescar historial local inmediatamente
                        const key = getReviewKey(test.id)
                        const raw = localStorage.getItem(key)
                        if (raw) {
                          try {
                            const arr: ReviewRecord[] = JSON.parse(raw)
                            // Buscar último registro del estudiante por id o nombre y guardar rawPoints exactos
                            const normName = normalize(studentName || '')
                            const idx = arr.findIndex(r => (r.studentId && String(r.studentId) === String(verification.studentId)) || normalize(r.studentName) === normName)
                            if (idx >= 0) {
                              const tPts = (arr[idx].totalPoints ?? (test as any)?.totalPoints ?? qTot) as number
                              arr[idx] = { ...arr[idx], rawPoints: clampedPts, totalPoints: tPts }
                              localStorage.setItem(key, JSON.stringify(arr))
                            }
                            setHistory(JSON.parse(localStorage.getItem(key) || '[]'))
                          } catch {
                            setHistory(JSON.parse(raw))
                          }
                        }
                      } catch {}
                    }}>Guardar nota</Button>
                  )}
                </div>
              </div>
              {!verification.studentFound && students.length > 0 && typeof editScore === 'number' && (
                <div className="flex items-center gap-2 pt-2">
                  <div className="text-xs">{translate('testsReviewAssignManual') || 'Asignar manualmente:'}</div>
                  <Select value={manualAssignId} onValueChange={setManualAssignId}>
                    <SelectTrigger className="h-8 w-60">
                      <SelectValue placeholder={translate('testsReviewSelectStudent') || 'Seleccionar estudiante'} />
                    </SelectTrigger>
                    <SelectContent>
                      {students
                        .map(s => ({ s, sim: similarityByTokens(studentName || '', s.displayName || s.username || '') }))
                        .sort((a, b) => b.sim - a.sim)
                        .slice(0, 8)
                        .map(({ s }) => (
                          <SelectItem key={String(s.id || s.username)} value={String(s.id || s.username)}>
                            {s.displayName || s.username}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={!manualAssignId} onClick={() => {
                    const chosen = students.find(s => String(s.id) === manualAssignId || String(s.username) === manualAssignId)
                    if (!chosen || typeof editScore !== 'number' || !test?.id) return
                    // Convertimos puntos a respuestas correctas antes de guardar
                    const qTot = Array.isArray(test?.questions) ? test!.questions.length : 0
                    const totalPts = typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints as number : qTot
                    const clampedPts = Math.max(0, Math.min(editScore, totalPts))
                    const newCorrect = qTot > 0 ? Math.round((clampedPts / totalPts) * qTot) : 0
                    // Guardar en porcentaje (0-100)
                    upsertTestGrade({
                      testId: test.id,
                      studentId: String(chosen.id || chosen.username),
                      studentName: chosen.displayName || chosen.username,
                      score: (qTot > 0 ? Math.round((Math.max(0, Math.min(newCorrect, qTot)) / qTot) * 100) : 0),
                      courseId: test.courseId || null,
                      sectionId: test.sectionId || null,
                      subjectId: test.subjectId || null,
                      title: test.title || '',
                    })
                    setVerification(v => ({ ...v, studentFound: true, studentId: String(chosen.id || chosen.username) }))
                    setStudentName(chosen.displayName || chosen.username)
                    setScore(newCorrect)
                    setEditScore(clampedPts)
                    try {
                      // Si no existe historial previo del estudiante, crear un nuevo registro;
                      // si existe, actualizar su último registro
                      const key = getReviewKey(test.id)
                      const list: ReviewRecord[] = JSON.parse(localStorage.getItem(key) || '[]')
                      const existsForStudent = Array.isArray(list) && list.some(r => {
                        const sidOk = r.studentId && String(r.studentId) === String(chosen.id || chosen.username)
                        const nameOk = normalize(r.studentName || '') === normalize(chosen.displayName || chosen.username || '')
                        return sidOk || nameOk
                      })
                      if (existsForStudent) {
                        updateLatestReviewScore({
                          testId: test.id,
                          studentId: String(chosen.id || chosen.username),
                          studentName: chosen.displayName || chosen.username,
                          newScore: newCorrect,
                          totalQuestions: Array.isArray(test?.questions) ? test.questions.length : null,
                        })
                      } else {
                        persistReview({
                          testId: test.id,
                          uploadedAt: Date.now(),
                          studentName: chosen.displayName || chosen.username,
                          studentId: String(chosen.id || chosen.username),
                          courseId: test.courseId || null,
                          sectionId: test.sectionId || null,
                          subjectId: test.subjectId || null,
                          subjectName: test.subjectName || null,
                          topic: test.topic || '',
                          score: newCorrect,
                          totalQuestions: Array.isArray(test?.questions) ? test.questions.length : null,
                          totalPoints: typeof (test as any)?.totalPoints === 'number' ? (test as any).totalPoints : (Array.isArray(test?.questions) ? test?.questions.length : null),
                          rawPoints: clampedPts,
                          sameDocument: false,
                          coverage: 0,
                          studentFound: true,
                        })
                      }
                      const raw = localStorage.getItem(key)
                      if (raw) setHistory(JSON.parse(raw))
                    } catch {}
                  }}>{translate('save') || 'Guardar'}</Button>
                </div>
              )}
              <details className="text-xs text-muted-foreground">
                <summary>{translate('testsReviewOcrText')}</summary>
                <pre className="whitespace-pre-wrap">{ocr.text}</pre>
              </details>
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
                                // Preferir porcentaje crudo importado si existe
                                if (typeof latest.rawPercent === 'number') return `${Math.round(Math.max(0, Math.min(latest.rawPercent, 100)))}%`
                                if (typeof latest.score !== 'number') return '-'
                                const qTot = typeof latest.totalQuestions === 'number' ? latest.totalQuestions : (test?.questions?.length || 0)
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
  
  // Conjunto de símbolos que suelen representar marcas de selección (incluye cuadrados, rayas y trazos comunes)
  const MARK_CHARS = 'xX✓✔●◉•■□▪▢◻◆▲☑☒✗✘╳'
  // Conjunto extendido para trazos que el estudiante puede dibujar encima (rayas, subrayados, etc.)
  const MARK_SCRIBBLE = MARK_CHARS + '-_/=|~'
  // Patrones mejorados para detectar marcas seleccionadas
  const isSelectedMark = (s: string) => {
    if (!s) return false
    // Escapar símbolos para uso seguro en clases de caracteres
  const escaped = MARK_SCRIBBLE.replace(/[-\\^$.*+?()[\]{}|]/g, '\\$&')
    const charClass = `[${escaped}]`
    const patterns = [
      new RegExp(`\\(\\s*${charClass}\\s*\\)`),  // (x)
      new RegExp(`\\[\\s*${charClass}\\s*\\]`),  // [x]
      new RegExp(`\\{\\s*${charClass}\\s*\\}`),  // {x}
      new RegExp(`\\*\\s*${charClass}\\s*\\*`),  // *x*
      new RegExp(`${charClass}`),                      // símbolo suelto (fallback)
    ]
    const matched = patterns.filter((re) => re.test(s)).length
    return matched > 0 && matched <= 3
  }
  
  const optionLabel = (idx: number) => String.fromCharCode(65 + idx) // A, B, C, D...
  
  // Detector mejorado de letras de opción
  const hasOptionLabel = (line: string, label: string) => {
    if (!line || !label) return false
    const upper = line.toUpperCase()
    const lower = line.toLowerCase()
    const L = label.toUpperCase()
    const l = label.toLowerCase()
    
    // Patrones múltiples para encontrar etiquetas
    const patterns = [
      new RegExp(`\\b${L}\\s*[\\)\\]\\.]`,'g'), // A) A] A.
      new RegExp(`\\(${L}\\)`,'g'),                 // (A)
      new RegExp(`\\[${L}\\]`,'g'),                 // [A]
      new RegExp(`^\\s*${L}\\s*[\\-:]`,'g'),      // A- A:
      new RegExp(`\\b${L}\\b`,'g'),                // A
      // versiones minúsculas
      new RegExp(`\\b${l}\\s*[\\)\\]\\.]`,'g'),
      new RegExp(`\\(${l}\\)`,'g'),
      new RegExp(`\\[${l}\\]`,'g'),
      new RegExp(`^\\s*${l}\\s*[\\-:]`,'g'),
      new RegExp(`\\b${l}\\b`,'g'),
    ]
    return patterns.some(p => p.test(upper) || p.test(lower))
  }
  
  // Función para buscar texto de opción en contexto
  const findOptionInContext = (optionText: string, searchRadius = 3) => {
    const normalizedOption = normalize(optionText)
    if (normalizedOption.length < 5) return false
    
    // Buscar el texto de la opción y verificar marcas cercanas
    for (let i = 0; i < lines.length; i++) {
      const currentLine = normalize(lines[i])
      if (currentLine.includes(normalizedOption.slice(0, Math.min(20, normalizedOption.length)))) {
        // Buscar marcas en líneas cercanas
        for (let j = Math.max(0, i - searchRadius); j <= Math.min(lines.length - 1, i + searchRadius); j++) {
          if (isSelectedMark(lines[j])) {
            return true
          }
        }
      }
    }
    return false
  }

  let correct = 0
  let evidence = 0 // cuenta líneas/marcas que respaldan detecciones
  const bd = {
    tf: { correct: 0, total: 0 },
    mc: { correct: 0, total: 0 },
    ms: { correct: 0, total: 0 },
    des: { correct: 0, total: 0 },
  }
  
  for (const q of questions) {
    if ((q as any).type === 'tf') {
      bd.tf.total++
      const tf = q as QuestionTF
      // Heurística de ventana: buscar V y F con paréntesis marcados en la misma línea o en un bloque pequeño
  const windowSize = 3
      let vSelected = false
      let fSelected = false
  const escaped = MARK_SCRIBBLE.replace(/[-\\^$.*+?()[\]{}|]/g, '\\$&')
  const markClass = `[${escaped}]`
  const vLineRegex = new RegExp(`v(?:erdadero)?\\s*[\\n\\r\\s]*[\\(\\[]\\s*${markClass}?\\s*[\\)\\]]`, 'i')
  const fLineRegex = new RegExp(`f(?:also)?\\s*[\\n\\r\\s]*[\\(\\[]\\s*${markClass}?\\s*[\\)\\]]`, 'i')
  const bothSameLine = new RegExp(`v(?:erdadero)?\\s*[\\(\\[]\\s*(${markClass}?)\\s*[\\)\\]][^\\n\\r]{0,20}f(?:also)?\\s*[\\(\\[]\\s*(${markClass}?)\\s*[\\)\\]]`, 'i')
  const bothSameLineRev = new RegExp(`f(?:also)?\\s*[\\(\\[]\\s*(${markClass}?)\\s*[\\)\\]][^\\n\\r]{0,20}v(?:erdadero)?\\s*[\\(\\[]\\s*(${markClass}?)\\s*[\\)\\]]`, 'i')

      // 1) Intento en la misma línea
      for (const line of lines) {
        const m1 = line.match(bothSameLine)
        if (m1) {
          const vm = m1[1]; const fm = m1[2]
          vSelected = !!vm && new RegExp(markClass).test(vm)
          fSelected = !!fm && new RegExp(markClass).test(fm)
          if (vSelected || fSelected) { evidence++; }
          break
        }
        const m2 = line.match(bothSameLineRev)
        if (m2) {
          const fm = m2[1]; const vm = m2[2]
          vSelected = !!vm && new RegExp(markClass).test(vm)
          fSelected = !!fm && new RegExp(markClass).test(fm)
          if (vSelected || fSelected) { evidence++; }
          break
        }
      }
      // 2) Si no quedó claro, buscar en ventana de líneas consecutivas
      if (!vSelected && !fSelected) {
        for (let i = 0; i < lines.length; i++) {
          const chunk = lines.slice(i, i + windowSize).join(' ')
          if (!chunk) continue
          const hasV = vLineRegex.test(chunk)
          const hasF = fLineRegex.test(chunk)
          if (hasV || hasF) {
            // Determinar cuál está marcado
            const vHasMark = new RegExp(`v(?:erdadero)?\\s*[\\(\\[]\\s*${markClass}\\s*[\\)\\]]`, 'i').test(chunk)
            const fHasMark = new RegExp(`f(?:also)?\\s*[\\(\\[]\\s*${markClass}\\s*[\\)\\]]`, 'i').test(chunk)
            vSelected = vHasMark && !fHasMark
            fSelected = fHasMark && !vHasMark
            if (vSelected || fSelected) { evidence++ }
            break
          }
        }
      }
      // 3) Fallback: patrones simples (menos confiables)
      if (!vSelected && !fSelected) {
  const fallbackMark = `[${MARK_SCRIBBLE.replace(/[-\\^$.*+?()[\]{}|]/g, '\\$&')}]`
        const vFallback = new RegExp(`v\\s*\\(\\s*${fallbackMark}+`, 'i')
        const fFallback = new RegExp(`f\\s*\\(\\s*${fallbackMark}+`, 'i')
        const vWordFallback = new RegExp(`(verdadero)\\s*[\\(\\[]\\s*${fallbackMark}+`, 'i')
        const fWordFallback = new RegExp(`(falso)\\s*[\\(\\[]\\s*${fallbackMark}+`, 'i')
        for (const line of lines) {
          if (vFallback.test(line) || vWordFallback.test(line)) { vSelected = true; evidence++ }
          if (fFallback.test(line) || fWordFallback.test(line)) { fSelected = true; evidence++ }
        }
        // Si ambos quedaron verdaderos por ruido, invalidar
        if (vSelected && fSelected) { vSelected = false; fSelected = false }
      }

      console.log(`[TF Debug] Pregunta: "${tf.text.slice(0, 50)}...", correcta=${tf.answer ? 'V' : 'F'}, V=${vSelected}, F=${fSelected}`)
      if ((tf.answer && vSelected && !fSelected) || (!tf.answer && fSelected && !vSelected)) {
        correct++; bd.tf.correct++; console.log('[TF] ✅')
      } else { console.log('[TF] ❌/ambigua') }
      continue
    }
    
    if ((q as any).type === 'mc') {
      bd.mc.total++
      const mc = q as QuestionMC
      const correctIdx = mc.correctIndex
      const correctText = mc.options[correctIdx]
      const label = optionLabel(correctIdx)
      
      let isCorrect = false
      let debugInfo = {
        foundByLabel: false,
        foundByContext: false,
        foundByText: false
      }
      
      // 1) Buscar por letra con marca en la misma línea, evitando ambigüedad
  const inlineMarkRe = new RegExp(`(${label})[^\n]{0,6}[${MARK_SCRIBBLE.replace(/[-\\^$.*+?()[\]{}|]/g, '\\$&')}]{1,3}`,'i')
      for (const line of lines) {
        if (hasOptionLabel(line, label) && (isSelectedMark(line) || inlineMarkRe.test(line))) {
          // Si la línea también contiene otras etiquetas de opción marcadas, la consideramos ambigua
          const otherLabels = mc.options.map((_, i) => optionLabel(i)).filter(L => L !== label)
          const otherMarked = otherLabels.some(L => hasOptionLabel(line, L) && isSelectedMark(line))
          if (!otherMarked) {
            isCorrect = true
            evidence++
            debugInfo.foundByLabel = true
            break
          }
        }
      }
      
      // 2) Buscar por texto de opción con marca cercana
      if (!isCorrect) {
        isCorrect = findOptionInContext(correctText)
  if (isCorrect) { debugInfo.foundByContext = true; evidence++ }
      }
      
      // 3) Fallback: texto de opción exacto con marca en la misma línea
      if (!isCorrect) {
        const escapedText = correctText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const textPattern = new RegExp(escapedText, 'i')
        for (const line of lines) {
          if (textPattern.test(line) && isSelectedMark(line)) {
            isCorrect = true
            evidence++
            debugInfo.foundByText = true
            break
          }
        }
      }
      
      // Debug logging
      console.log(`[MC Debug] Pregunta: "${mc.text.slice(0, 50)}...", Opción correcta: ${label} - "${correctText}", Encontrada: ${isCorrect}`, debugInfo)
      
      if (isCorrect) {
        correct++
        bd.mc.correct++
        console.log(`[MC] ✅ Respuesta correcta`)
      } else {
        console.log(`[MC] ❌ Respuesta no detectada`)
      }
      continue
    }
    
    if ((q as any).type === 'ms') {
      bd.ms.total++
      const ms = q as QuestionMS
      const correctOptions = ms.options.filter(o => o.correct)
      let correctSelections = 0
      let incorrectSelections = 0
      
      // Verificar cada opción
      for (let i = 0; i < ms.options.length; i++) {
        const option = ms.options[i]
        const label = optionLabel(i)
        let isSelected = false
        
        // Buscar por letra con marca
  const inlineMarkRe = new RegExp(`(${label})[^\n]{0,6}[${MARK_SCRIBBLE.replace(/[-\\^$.*+?()[\]{}|]/g, '\\$&')}]{1,3}`,'i')
        for (const line of lines) {
          if (hasOptionLabel(line, label) && (isSelectedMark(line) || inlineMarkRe.test(line))) {
            isSelected = true
            break
          }
        }
        
        // Buscar por texto con marca cercana
        if (!isSelected) {
          isSelected = findOptionInContext(option.text)
        }
        
        // Contar correctas e incorrectas
        if (isSelected) {
          if (option.correct) {
            correctSelections++
          } else {
            incorrectSelections++
          }
        }
      }
      
  // Otorgar punto solo si todas las correctas están seleccionadas y ninguna incorrecta
      if (correctSelections === correctOptions.length && incorrectSelections === 0 && correctOptions.length > 0) {
        correct++
        bd.ms.correct++
        evidence++
      }
      continue
    }
    
    // Para preguntas de desarrollo, no auto-calificar (requiere revisión manual)
    if ((q as any).type === 'des') {
      bd.des.total++
      // Las preguntas de desarrollo se califican manualmente
      continue
    }
  }
  
  // Total auto-calificables
  const autoTotal = bd.tf.total + bd.mc.total + bd.ms.total
  // Si detectamos 100% pero la evidencia es muy baja, suavizar: devolver como mínimo autoTotal-1 para evitar falsos 100%
  let adjustedCorrect = correct
  if (autoTotal > 0 && correct === autoTotal && evidence < Math.max(3, Math.ceil(autoTotal * 0.25))) {
    adjustedCorrect = Math.max(0, autoTotal - 1)
  }
  return { correct: adjustedCorrect, breakdown: bd, evidence }
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

function upsertTestGrade(input: { testId: string; studentId: string; studentName: string; score: number; courseId: string | null; sectionId: string | null; subjectId: string | null; title?: string }) {
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
    
    // 📧 NUEVO: Enviar email al estudiante y apoderado cuando se califica una prueba
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
