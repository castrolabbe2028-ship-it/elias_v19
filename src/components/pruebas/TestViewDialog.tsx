"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import html2canvas from "html2canvas"
import jsPDF from "jspdf"
import { useLanguage } from "@/contexts/language-context"

type Student = { id: string; name: string; rut?: string; email?: string; sectionId?: string; section?: string }

type Props = {
  open: boolean
  onOpenChange: (v: boolean) => void
  test?: {
    id: string
    title: string
    description?: string
    createdAt?: number
    sectionId?: string
    courseId?: string
    subjectId?: string
  subjectName?: string
    topic?: string
    counts?: { tf: number; mc: number; ms: number; des?: number }
  // Nuevos campos para ponderaciones y puntaje total
  weights?: { tf?: number; mc?: number; ms?: number; des?: number }
  totalPoints?: number
    questions?: AnyQuestion[]
  }
  onReview?: () => void
}

const STUDENTS_KEY = "smart-student-students"
const COURSE_SECTION_KEY = "smart-student-current-course-section"
const SECTIONS_KEY = "smart-student-sections"
const COURSES_KEY = "smart-student-courses"
const SUBJECTS_KEY = "smart-student-subjects"

type QuestionTF = { id: string; type: "tf"; text: string; answer: boolean; explanation?: string }
type QuestionMC = { id: string; type: "mc"; text: string; options: string[]; correctIndex: number }
type QuestionMS = { id: string; type: "ms"; text: string; options: Array<{ text: string; correct: boolean }> }
type QuestionDES = { id: string; type: "des"; prompt: string; sampleAnswer?: string }
type AnyQuestion = QuestionTF | QuestionMC | QuestionMS | QuestionDES

export default function TestViewDialog({ open, onOpenChange, test, onReview }: Props) {
  const { translate } = useLanguage()
  const [students, setStudents] = useState<Student[]>([])
  const [courseSectionName, setCourseSectionName] = useState<string>("")
  const [courseName, setCourseName] = useState<string>("")
  const [subjectName, setSubjectName] = useState<string>("")
  const [sectionId, setSectionId] = useState<string>("")
  const contentRef = useRef<HTMLDivElement>(null)
  
  // Utilidad para formatear puntos de manera concisa
  const fmtPts = (n?: number) => {
    if (n == null || isNaN(n)) return ""
    const r = Math.round((n + Number.EPSILON) * 100) / 100
    if (Math.abs(r - Math.round(r)) < 1e-9) return String(Math.round(r))
    if (Math.abs(r * 10 - Math.round(r * 10)) < 1e-9) return r.toFixed(1)
    return r.toFixed(2)
  }

  // Calcular puntos por pregunta según weights y totalPoints
  const perQuestionPoints = useMemo(() => {
    const counts = test?.counts || { tf: 0, mc: 0, ms: 0, des: 0 }
    const totalQuestions = (counts.tf || 0) + (counts.mc || 0) + (counts.ms || 0) + (counts.des || 0)
    const totalPoints = (typeof test?.totalPoints === 'number' && test?.totalPoints! > 0)
      ? (test!.totalPoints as number)
      : totalQuestions // fallback: 1 punto por pregunta si no se definió

    const activeTypes: Array<keyof typeof counts> = (['tf','mc','ms','des'] as const).filter((t) => (counts as any)[t] > 0) as any
    if (activeTypes.length === 0) return { tf: 0, mc: 0, ms: 0, des: 0 }

    const w = test?.weights || {}
    let sumActive = activeTypes.reduce((acc, t) => acc + (Number((w as any)[t]) || 0), 0)
    // Si no hay pesos válidos, repartir equitativamente
    const normalized: Record<'tf'|'mc'|'ms'|'des', number> = { tf: 0, mc: 0, ms: 0, des: 0 }
    if (!sumActive || sumActive <= 0.0001) {
      const eq = 1 / activeTypes.length
      activeTypes.forEach((t) => { (normalized as any)[t] = eq })
    } else {
      activeTypes.forEach((t) => { (normalized as any)[t] = (Number((w as any)[t]) || 0) / sumActive })
    }

    const keys = ['tf','mc','ms','des'] as const
    const perTypePoints: Record<'tf'|'mc'|'ms'|'des', number> = { tf: 0, mc: 0, ms: 0, des: 0 };
    keys.forEach((t: 'tf'|'mc'|'ms'|'des') => {
      perTypePoints[t] = totalPoints * (normalized as any)[t]
    })

    const result: Record<'tf'|'mc'|'ms'|'des', number> = { tf: 0, mc: 0, ms: 0, des: 0 };
    keys.forEach((t: 'tf'|'mc'|'ms'|'des') => {
      const c = (counts as any)[t] || 0
      result[t] = c > 0 ? perTypePoints[t] / c : 0
    })
    return result
  }, [test?.counts, test?.weights, test?.totalPoints])

  useEffect(() => {
    if (!open) return
    try {
      // Cargar estudiantes desde smart-student-students-{year} que tiene sectionId y RUT
      const savedYear = Number(localStorage.getItem('admin-selected-year') || '')
      const currentYear = Number.isFinite(savedYear) && savedYear > 0 ? savedYear : new Date().getFullYear()
      const studentsForYear = JSON.parse(localStorage.getItem(`smart-student-students-${currentYear}`) || '[]')
      // Fallback a la key antigua
      const rawS = localStorage.getItem(STUDENTS_KEY)
      const legacyList: Student[] = rawS ? JSON.parse(rawS) : []
      // Combinar: preferir studentsForYear que tiene más datos
      const merged: Student[] = studentsForYear.length > 0 ? studentsForYear.map((s: any) => ({
        id: s.id || s.username,
        name: s.displayName || s.name || s.username,
        rut: s.rut || '',
        email: s.email || '',
        sectionId: s.sectionId,
        section: s.section,
      })) : legacyList
      setStudents(merged)
    } catch (e) {
      console.error("[TestViewDialog] Error leyendo estudiantes", e)
    }
    try {
      // Preferir el nombre real de la sección guardada
      const rawSecs = localStorage.getItem(SECTIONS_KEY)
      const secs = rawSecs ? JSON.parse(rawSecs) : []
  const cs = JSON.parse(localStorage.getItem(COURSES_KEY) || "[]")
  const sb = JSON.parse(localStorage.getItem(SUBJECTS_KEY) || "[]")
      if (test?.sectionId) {
        setSectionId(String(test.sectionId))
        const sec = secs.find((s: any) => String(s.id) === String(test.sectionId))
        if (sec) setCourseSectionName(sec.name || "Curso/Sección")
        const course = cs.find((c: any) => String(c.id) === String(sec?.courseId))
        if (course?.name) setCourseName(course.name)
  let subj = sb.find((x: any) => String(x.id) === String(test.subjectId))
  if (!subj) subj = sb.find((x: any) => String(x.name) === String(test.subjectId))
  if (subj?.name) setSubjectName(subj.name)
  else if (test?.subjectName) setSubjectName(test.subjectName)
  else if (test?.subjectId) setSubjectName(String(test.subjectId))
      } else {
        const rawCS = localStorage.getItem(COURSE_SECTION_KEY)
        if (rawCS) {
          const parsed = JSON.parse(rawCS)
          setCourseSectionName(parsed?.name || parsed?.label || "Curso/Sección")
          setSectionId(parsed?.id || parsed?.sectionId || "")
        }
      }
    } catch (e) {
      // ignore
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!sectionId) return students
    // Filtrar estudiantes que pertenezcan a la sección
    return students.filter((s: any) => String(s.sectionId || s.section) === String(sectionId))
  }, [students, sectionId])

  // Fallback local: generar preguntas si no existen para evitar PDF vacío
  const questions: AnyQuestion[] = useMemo(() => {
    console.log('[TestViewDialog] useMemo questions - test?.questions:', test?.questions?.length || 0, 'test?.id:', test?.id)
    
    // Helpers de similitud y normalización
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-záéíóúñü0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim()
    const tokenSet = (s: string) => new Set(normalize(s).split(' ').filter(w => !['el','la','los','las','de','del','y','o','u','en','sobre','según','lo','visto','en','clase','para','por','con','un','una','al','a','que','es','son','se','item','ítem'].includes(w)))
    const isTooSimilar = (a: string, b: string) => {
      const A = tokenSet(a); const B = tokenSet(b)
      if (A.size === 0 || B.size === 0) return false
      let inter = 0
      A.forEach(t => { if (B.has(t)) inter++ })
      const ratio = inter / Math.min(A.size, B.size)
      return ratio >= 0.6
    }

    if (test?.questions && test.questions.length > 0) {
      console.log('[TestViewDialog] Usando preguntas del test:', test.questions.length)
      // Copiar y asegurar que DES no se repitan ni sean semejantes a TF/MC/MS
      const arr: AnyQuestion[] = JSON.parse(JSON.stringify(test.questions))
      const otherStems = arr
        .filter((q: any) => q.type !== 'des')
        .map((q: any) => (q.text || ''))
      const cleanTopic = (test?.topic || 'Tema').trim()
      const pool = [
        `Analiza en profundidad ${cleanTopic}, argumentando con al menos dos evidencias.`,
        `Explica los conceptos centrales de ${cleanTopic} y ejemplifícalos en un caso real.`,
        `Compara ${cleanTopic} con un proceso alternativo e identifica similitudes y diferencias sustantivas.`,
        `Evalúa ventajas y limitaciones de ${cleanTopic} y propone mejoras justificadas.`,
        `Relaciona ${cleanTopic} con situaciones de la vida cotidiana y elabora conclusiones fundamentadas.`,
        `Propón un mapa conceptual de ${cleanTopic} y explica las relaciones entre sus elementos.`,
        `Diseña un experimento simple para observar ${cleanTopic}: hipótesis, materiales, procedimiento y resultados esperados.`,
        `Argumenta la relevancia de ${cleanTopic} para la salud/ambiente/sociedad con ejemplos concretos.`,
        `Resume ${cleanTopic} en no más de cinco frases e incluye una conclusión propia justificada.`,
        `Explica las principales causas y efectos asociados a ${cleanTopic} e ilustra con ejemplos.`,
        `Describe un caso real relacionado con ${cleanTopic} y analiza causas, consecuencias y aprendizajes.`,
        `Formula una pregunta de investigación sobre ${cleanTopic} y plantea una posible respuesta con argumentos.`,
      ]
      const shuffled = [...pool].sort(() => Math.random() - 0.5)
      const variantTags = [
        'incluye un ejemplo local',
        'agrega una fuente de consulta',
        'indica al menos dos evidencias',
        'concluye con una recomendación práctica',
      ]
      let pi = 0, vt = 0
      const used: string[] = []
      const getUniquePrompt = (): string => {
        // intentar desde el pool barajado
        for (let tries = 0; tries < shuffled.length + 8; tries++) {
          const base = shuffled[pi % shuffled.length]; pi++
          const candidate = tries < shuffled.length ? base : `${base} (${variantTags[vt++ % variantTags.length]})`
          const conflict = otherStems.some(s => isTooSimilar(candidate, s)) || used.some(s => isTooSimilar(candidate, s))
          if (!conflict) return candidate
        }
        // fallback final
        return `Análisis crítico de ${cleanTopic} con evidencias y conclusión personal.`
      }

      arr.forEach((q: any) => {
        if (q.type !== 'des') return
        let p = q.prompt || ''
        const isDuplicate = used.includes(p)
        const similarToOther = otherStems.some(s => isTooSimilar(p, s))
        const similarToUsed = used.some(s => isTooSimilar(p, s))
        if (!p || isDuplicate || similarToOther || similarToUsed) {
          p = getUniquePrompt()
          q.prompt = p
        }
        used.push(q.prompt)
      })
      return arr
    }
    
    // Si no hay preguntas del servidor, retornar array vacío
    // Esto asegura que el indicador de carga se muestre mientras se generan las preguntas
    console.log('[TestViewDialog] No hay preguntas del servidor, retornando array vacío')
    return []
  }, [test?.questions, test?.counts, test?.topic])

  const handleExportPDF = async () => {
    try {
      // Verificar que las preguntas estén disponibles antes de generar el PDF
      if (!questions || questions.length === 0) {
        console.warn('[TestViewDialog] No hay preguntas disponibles para generar el PDF')
        alert('Espera un momento mientras se cargan las preguntas...')
        return
      }
      
      // Pequeña pausa para asegurar que el estado esté completamente actualizado
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 15
      const maxWidth = pageWidth - margin * 2
      const lineH = 6
      let y = margin

      // Estética base
      pdf.setTextColor(0)
      pdf.setDrawColor(30)
      pdf.setLineWidth(0.4)

      const ensureSpace = (h: number) => {
        if (y + h > pageHeight - margin) {
          addFooter()
          pdf.addPage()
          y = margin
          drawHeader(true)
        }
      }

      const text = (str: string, opts?: { size?: number; bold?: boolean; add?: number }) => {
        const size = opts?.size ?? 12
        const bold = opts?.bold ?? false
        const add = opts?.add ?? 0
        pdf.setFont('helvetica', bold ? 'bold' : 'normal')
        pdf.setFontSize(size)
        const lines = pdf.splitTextToSize(str, maxWidth)
        ensureSpace(lines.length * lineH + add)
  lines.forEach((l: string) => { pdf.text(l, margin, y); y += lineH })
        y += add
      }

      // Encabezado y pie
      const drawHeader = (compact = false) => {
        pdf.setFont('helvetica', 'bold')
        if (!compact) {
          // Título centrado grande
          pdf.setFontSize(18)
          const title = (test?.title || 'PRUEBA').toUpperCase()
          const tW = pdf.getTextWidth(title)
          pdf.text(title, (pageWidth - tW) / 2, y)
          y += 8
          // Línea decorativa
          pdf.setDrawColor(50)
          pdf.setLineWidth(0.8)
          pdf.line(margin, y, pageWidth - margin, y)
          pdf.setLineWidth(0.4)
          y += 6
          // Datos
          text(`TEMA: ${test?.topic || '-'}`, { bold: true })
          const courseSec = courseName ? `${courseName} ${courseSectionName}` : (courseSectionName || '-')
          text(`CURSO/SECCIÓN: ${courseSec}`, { bold: true })
          text(`ASIGNATURA: ${subjectName || 'Ciencias Naturales'}`, { bold: true })
          // Puntaje total (si no está definido, usamos el número de preguntas)
          const counts = test?.counts || { tf: 0, mc: 0, ms: 0, des: 0 }
          const totalQuestions = (counts.tf || 0) + (counts.mc || 0) + (counts.ms || 0) + (counts.des || 0)
          const totalPoints = (typeof test?.totalPoints === 'number' && (test?.totalPoints as number) > 0) ? (test!.totalPoints as number) : totalQuestions
          text(`PUNTAJE TOTAL: ${totalPoints} pts`, { bold: true })
          y += 2
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12)
          const label = 'NOMBRE DEL ESTUDIANTE:'
          pdf.text(label, margin, y)
          const xLine = margin + pdf.getTextWidth(label) + 2
          pdf.line(xLine, y, pageWidth - margin, y)
          y += 8
          pdf.setDrawColor(30)
          pdf.line(margin, y, pageWidth - margin, y)
          y += 6
        } else {
          // Encabezado compacto para páginas siguientes
          pdf.setFontSize(12)
          const title = (test?.title || 'PRUEBA').toUpperCase()
          pdf.text(title, margin, y)
          const courseSec = courseName ? `${courseName} ${courseSectionName}` : (courseSectionName || '-')
          pdf.setFont('helvetica','normal')
          pdf.text(courseSec, pageWidth - margin - pdf.getTextWidth(courseSec), y)
          y += 4
          pdf.setDrawColor(30)
          pdf.line(margin, y, pageWidth - margin, y)
          y += 4
        }
      }

      const addFooter = () => {
        const page = (pdf as any).internal?.getNumberOfPages?.() || (pdf as any).internal?.pages?.length || 1
        pdf.setFont('helvetica','normal'); pdf.setFontSize(9)
        pdf.text(`Página ${page}`, pageWidth - margin - 20, pageHeight - 6)
      }

      // Pinta el primer encabezado
      drawHeader(false)

      // Usar las preguntas del useMemo (ya procesadas con fallback)
      const questionsToRender = questions
      const letters = ['A','B','C','D','E','F']

      const boxPaddingX = 4
      const boxPaddingY = 4

      const calcTextHeight = (s: string, width: number) => {
        const lines = pdf.splitTextToSize(s, width)
        return lines.length * lineH
      }

      const drawBox = (height: number) => {
        // Caja con bordes redondeados y banda lateral clara
        const x = margin
        const w = pageWidth - margin * 2
        const h = height
        pdf.setDrawColor(60)
        pdf.roundedRect(x, y, w, h, 2, 2)
        // Banda lateral
        pdf.setFillColor(235, 232, 246) // lila muy suave
        pdf.rect(x + 1.5, y + 1.5, 3, h - 3, 'F')
      }

      for (let i = 0; i < questionsToRender.length; i++) {
        const q: any = questionsToRender[i]
        const num = i + 1
        const pts = q.type === 'tf' ? perQuestionPoints.tf
          : q.type === 'mc' ? perQuestionPoints.mc
          : q.type === 'ms' ? perQuestionPoints.ms
          : perQuestionPoints.des
        const ptsLabel = pts ? ` (${fmtPts(pts)} pts)` : ''

        if (q.type === 'tf') {
          const title = `${num}. ${q.text}${ptsLabel}`
          const titleH = calcTextHeight(title, maxWidth - boxPaddingX * 2)
          const totalH = boxPaddingY * 2 + titleH + 10
          ensureSpace(totalH + 2)
          drawBox(totalH)
          // contenido dentro de la caja
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
          const lines = pdf.splitTextToSize(title, maxWidth - boxPaddingX * 2)
          lines.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          pdf.setFont('helvetica','normal')
          pdf.text('V (    )', margin + boxPaddingX + 10, innerY + 2)
          pdf.text('F (    )', margin + boxPaddingX + 40, innerY + 2)
          y += totalH + 4
          continue
        }

        if (q.type === 'mc') {
          const header = `${num}. ${q.text}${ptsLabel}`
          const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
          const optionHeights = q.options.map((opt: string, idx: number) => calcTextHeight(`(${letters[idx] || String(idx+1)}) ${opt}`, maxWidth - boxPaddingX * 2 - 4))
          const optionsH = optionHeights.reduce((a: number, b: number) => a + b + 2, 0)
          const totalH = boxPaddingY * 2 + headerH + 2 + optionsH
          ensureSpace(totalH + 2)
          drawBox(totalH)
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold')
          pdf.setFontSize(12)
          pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          innerY += 1
          pdf.setFont('helvetica','normal')
          q.options.forEach((opt: string, idx: number) => {
            const linesOpt = pdf.splitTextToSize(`(${letters[idx] || String(idx+1)}) ${opt}`, maxWidth - boxPaddingX * 2 - 4)
            linesOpt.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 8, innerY); innerY += lineH })
            innerY += 2
          })
          y += totalH + 4
          continue
        }

        if (q.type === 'ms') {
          const header = `${num}. ${q.text}${ptsLabel}`
          const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
          let optionsH = 0
          const linesPerOpt: Array<string[]> = []
          q.options.forEach((opt: any, idx: number) => {
            const linesOpt = pdf.splitTextToSize(`(${letters[idx] || String(idx+1)}) ${opt.text}`, maxWidth - boxPaddingX * 2 - 12)
            linesPerOpt.push(linesOpt as unknown as string[])
            optionsH += linesOpt.length * lineH + 4
          })
          const totalH = boxPaddingY * 2 + headerH + 2 + optionsH
          ensureSpace(totalH + 2)
          drawBox(totalH)
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
          pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          innerY += 2
          pdf.setFont('helvetica','normal')
          q.options.forEach((_opt: any, idx: number) => {
            // checkbox
            pdf.rect(margin + boxPaddingX + 6, innerY - 3.5, 3.5, 3.5)
            const linesOpt = linesPerOpt[idx]
            linesOpt.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 12, innerY); innerY += lineH })
            innerY += 2
          })
          y += totalH + 4
          continue
        }

        // Desarrollo
  const header = `${num}. ${q.prompt}${ptsLabel}`
        const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
        const linesCount = 7
        const linesArea = linesCount * (lineH + 2) + 2
        const totalH = boxPaddingY * 2 + headerH + 6 + linesArea
        ensureSpace(totalH + 2)
        drawBox(totalH)
        let innerY = y + boxPaddingY + 2
        pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
        pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
        innerY += 4
        // Líneas para desarrollo
        for (let k = 0; k < linesCount; k++) {
          pdf.line(margin + boxPaddingX + 6, innerY, pageWidth - margin - boxPaddingX, innerY)
          innerY += lineH + 2
        }
        y += totalH + 4
      }

      addFooter()
      const filename = `${test?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'prueba'}-${courseSectionName?.replace(/[^a-zA-Z0-9]/g, '_') || 'curso'}.pdf`
      pdf.save(filename)
    } catch (error) {
      console.error('[TestViewDialog] Error al generar PDF:', error)
      alert('Error al generar el PDF. Por favor, inténtelo de nuevo.')
    }
  }

  // Exporta una versión respondida correctamente (clave de respuestas)
  const handleExportPDFAnswered = async () => {
    try {
      // Verificar que las preguntas estén disponibles antes de generar el PDF
      if (!questions || questions.length === 0) {
        console.warn('[TestViewDialog] No hay preguntas disponibles para generar el PDF de clave')
        alert('Espera un momento mientras se cargan las preguntas...')
        return
      }
      
      // Pequeña pausa para asegurar que el estado esté completamente actualizado
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 15
      const maxWidth = pageWidth - margin * 2
      const lineH = 6
      let y = margin

      pdf.setTextColor(0)
      pdf.setDrawColor(30)
      pdf.setLineWidth(0.4)

      const ensureSpace = (h: number) => {
        if (y + h > pageHeight - margin) {
          addFooter()
          pdf.addPage()
          y = margin
          drawHeader(true)
        }
      }

      const text = (str: string, opts?: { size?: number; bold?: boolean; add?: number }) => {
        const size = opts?.size ?? 12
        const bold = opts?.bold ?? false
        const add = opts?.add ?? 0
        pdf.setFont('helvetica', bold ? 'bold' : 'normal')
        pdf.setFontSize(size)
        const lines = pdf.splitTextToSize(str, maxWidth)
        ensureSpace(lines.length * lineH + add)
        lines.forEach((l: string) => { pdf.text(l, margin, y); y += lineH })
        y += add
      }

      const drawHeader = (compact = false) => {
        pdf.setFont('helvetica', 'bold')
        if (!compact) {
          pdf.setFontSize(18)
          const baseTitle = (test?.title || 'PRUEBA').toUpperCase()
          const title = `${baseTitle} — CLAVE` // indicar que es la clave
          const tW = pdf.getTextWidth(title)
          pdf.text(title, (pageWidth - tW) / 2, y)
          y += 8
          pdf.setDrawColor(50)
          pdf.setLineWidth(0.8)
          pdf.line(margin, y, pageWidth - margin, y)
          pdf.setLineWidth(0.4)
          y += 6
          text(`TEMA: ${test?.topic || '-'}`, { bold: true })
          const courseSec = courseName ? `${courseName} ${courseSectionName}` : (courseSectionName || '-')
          text(`CURSO/SECCIÓN: ${courseSec}`, { bold: true })
          text(`ASIGNATURA: ${subjectName || 'Ciencias Naturales'}`, { bold: true })
          y += 2
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12)
          const label = 'NOMBRE DEL ESTUDIANTE:'
          pdf.text(label, margin, y)
          const xLine = margin + pdf.getTextWidth(label) + 2
          pdf.line(xLine, y, pageWidth - margin, y)
          y += 8
          pdf.setDrawColor(30)
          pdf.line(margin, y, pageWidth - margin, y)
          y += 6
        } else {
          pdf.setFontSize(12)
          const title = `${(test?.title || 'PRUEBA').toUpperCase()} — CLAVE`
          pdf.text(title, margin, y)
          const courseSec = courseName ? `${courseName} ${courseSectionName}` : (courseSectionName || '-')
          pdf.setFont('helvetica','normal')
          pdf.text(courseSec, pageWidth - margin - pdf.getTextWidth(courseSec), y)
          y += 4
          pdf.setDrawColor(30)
          pdf.line(margin, y, pageWidth - margin, y)
          y += 4
        }
      }

      const addFooter = () => {
        const page = (pdf as any).internal?.getNumberOfPages?.() || (pdf as any).internal?.pages?.length || 1
        pdf.setFont('helvetica','normal'); pdf.setFontSize(9)
        pdf.text(`Página ${page}`, pageWidth - margin - 20, pageHeight - 6)
      }

      drawHeader(false)

      // Usar las preguntas del useMemo (ya procesadas con fallback)
      const questionsToRender = questions
      const letters = ['A','B','C','D','E','F']
      const boxPaddingX = 4
      const boxPaddingY = 4

      const calcTextHeight = (s: string, width: number) => {
        const lines = pdf.splitTextToSize(s, width)
        return lines.length * lineH
      }
      const drawBox = (height: number) => {
        const x = margin
        const w = pageWidth - margin * 2
        const h = height
        pdf.setDrawColor(60)
        pdf.roundedRect(x, y, w, h, 2, 2)
        pdf.setFillColor(235, 232, 246)
        pdf.rect(x + 1.5, y + 1.5, 3, h - 3, 'F')
      }

      for (let i = 0; i < questionsToRender.length; i++) {
        const q: any = questionsToRender[i]
        const num = i + 1
        const pts = q.type === 'tf' ? perQuestionPoints.tf
          : q.type === 'mc' ? perQuestionPoints.mc
          : q.type === 'ms' ? perQuestionPoints.ms
          : perQuestionPoints.des
        const ptsLabel = pts ? ` (${fmtPts(pts)} pts)` : ''

        if (q.type === 'tf') {
          const title = `${num}. ${q.text}${ptsLabel}`
          const titleH = calcTextHeight(title, maxWidth - boxPaddingX * 2)
          const totalH = boxPaddingY * 2 + titleH + 10
          ensureSpace(totalH + 2)
          drawBox(totalH)
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
          const lines = pdf.splitTextToSize(title, maxWidth - boxPaddingX * 2)
          lines.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          pdf.setFont('helvetica','normal')
          const yMarks = innerY + 2
          const xV = margin + boxPaddingX + 10
          const xF = margin + boxPaddingX + 40
          // Dibujar ambas opciones con espacio
          pdf.text('V (    )', xV, yMarks)
          pdf.text('F (    )', xF, yMarks)
          // Colocar una X coloreada dentro del paréntesis correcto
          const xOffsetTrue = pdf.getTextWidth('V ( ')
          const xOffsetFalse = pdf.getTextWidth('F ( ')
          pdf.setTextColor(33, 150, 243)
          pdf.setFont('helvetica','bold')
          if (q.answer === true) {
            pdf.text('X', xV + xOffsetTrue, yMarks)
          } else {
            pdf.text('X', xF + xOffsetFalse, yMarks)
          }
          pdf.setTextColor(0)
          pdf.setFont('helvetica','normal')
          y += totalH + 4
          continue
        }

        if (q.type === 'mc') {
          const header = `${num}. ${q.text}${ptsLabel}`
          const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
          const optionHeights = q.options.map((opt: string, idx: number) => calcTextHeight(`(${letters[idx] || String(idx+1)}) ${opt}`, maxWidth - boxPaddingX * 2 - 4))
          const optionsH = optionHeights.reduce((a: number, b: number) => a + b + 2, 0)
          const totalH = boxPaddingY * 2 + headerH + 2 + optionsH
          ensureSpace(totalH + 2)
          drawBox(totalH)
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold')
          pdf.setFontSize(12)
          pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          innerY += 1
          pdf.setFont('helvetica','normal')
          q.options.forEach((opt: string, idx: number) => {
            const isCorrect = Number(q.correctIndex) === Number(idx)
            const label = (letters[idx] || String(idx+1))
            const lineText = `(${label}) ${opt}`
            const linesOpt = pdf.splitTextToSize(lineText, maxWidth - boxPaddingX * 2 - 4)
            const baseX = margin + boxPaddingX + 8
            // línea base del primer renglón antes de escribirlo
            const firstLineBaseline = innerY
            // pintar texto
            linesOpt.forEach((l: string) => { pdf.text(l, baseX, innerY); innerY += lineH })
            // punto verde sobre la letra correcta
            if (isCorrect) {
              const xCenter = baseX + pdf.getTextWidth('(') + pdf.getTextWidth(label) / 2
              const yCenter = firstLineBaseline - 1.8
              pdf.setFillColor(76, 175, 80)
              pdf.circle(xCenter, yCenter, 1.6, 'F')
            }
            innerY += 2
          })
          y += totalH + 4
          continue
        }

        if (q.type === 'ms') {
          const header = `${num}. ${q.text}${ptsLabel}`
          const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
          let optionsH = 0
          const linesPerOpt: Array<string[]> = []
          q.options.forEach((opt: any, idx: number) => {
            const linesOpt = pdf.splitTextToSize(`(${letters[idx] || String(idx+1)}) ${opt.text}`, maxWidth - boxPaddingX * 2 - 12)
            linesPerOpt.push(linesOpt as unknown as string[])
            optionsH += linesOpt.length * lineH + 4
          })
          const totalH = boxPaddingY * 2 + headerH + 2 + optionsH
          ensureSpace(totalH + 2)
          drawBox(totalH)
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
          pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          innerY += 2
          pdf.setFont('helvetica','normal')
          q.options.forEach((opt: any, idx: number) => {
            // checkbox
            const leftX = margin + boxPaddingX + 6
            const size = 3.5
            pdf.rect(leftX, innerY - 3.5, size, size)
            // marcar si es correcta
            if (opt.correct) {
              pdf.setFillColor(25, 118, 210) // azul
              pdf.rect(leftX + 0.6, innerY - 2.9, size - 1.2, size - 1.2, 'F')
            }
            const linesOpt = linesPerOpt[idx]
            linesOpt.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 12, innerY); innerY += lineH })
            innerY += 2
          })
          y += totalH + 4
          continue
        }

        // Desarrollo: punteo de conceptos clave (viñetas)
  const qd = q as any
  const header = `${num}. ${qd.prompt}${ptsLabel}`
        const keyPointsFromSample = (txt?: string): string[] => {
          if (!txt) return []
          
          // Nuevo formato con RESPUESTA CORRECTA y RÚBRICA
          const hasNewFormat = txt.includes('RESPUESTA CORRECTA:') || txt.includes('RÚBRICA:')
          
          if (hasNewFormat) {
            const bullets: string[] = []
            
            // Extraer sección de respuesta correcta
            const respMatch = txt.match(/RESPUESTA CORRECTA:\s*([\s\S]*?)(?=RÚBRICA:|$)/i)
            if (respMatch) {
              const respLines = respMatch[1].split('\n')
                .map(l => l.replace(/^[•\-]\s*/, '').trim())
                .filter(l => l && !l.match(/^(Operación|Paso \d|Resultado|Procedimiento):/i))
              
              // Extraer el resultado o respuesta principal
              const resultLine = respLines.find(l => l.match(/^(Resultado|=)/i) || l.includes('='))
              if (resultLine) {
                bullets.push(`✓ ${resultLine.replace(/^Resultado:\s*/i, 'Respuesta: ')}`)
              } else if (respLines.length > 0) {
                // Tomar las líneas de operación/resultado
                respLines.slice(0, 3).forEach(l => {
                  if (l.includes(':')) bullets.push(`✓ ${l}`)
                  else bullets.push(`✓ ${l}`)
                })
              }
            }
            
            // Extraer rúbrica de puntaje
            const rubricMatch = txt.match(/RÚBRICA:\s*([\s\S]*?)$/i)
            if (rubricMatch) {
              bullets.push('') // Línea en blanco para separar
              bullets.push('PUNTAJE PARCIAL:')
              const rubricLines = rubricMatch[1].split('\n')
                .map(l => l.replace(/^[•\-]\s*/, '').trim())
                .filter(l => l && l.match(/^\d+%:/))
              rubricLines.forEach(l => bullets.push(l))
            }
            
            return bullets.filter(b => b !== undefined).slice(0, 8)
          }
          
          // 1) Formato antiguo: limpiar encabezados conocidos
          let cleaned = txt
            .replace(/(^|\s)respuesta\s+esperada\s*:\s*/i, ' ')
            .replace(/se\s+espera\s+que\s+el\s+estudiante\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim()

          // 2) segmentar por saltos, puntos y delimitadores comunes
          let segments = cleaned
            .split(/\n|\r|[;•\u2022\u25CF]|\.|—|–| - /g)
            .flatMap(s => s.split(/\s+y\s+|\s+e\s+/i))
            .map(s => s.trim())
            .filter(Boolean)

          // 3) normalizar segmentos a conceptos mínimos
          const tema = (test?.topic || '')
          const normalize = (s: string): string | null => {
            const low = s.toLowerCase()
            // reglas específicas
            if (low.includes('concepto')) {
              if (tema) return `Conceptos centrales de ${tema}`
              // intentar extraer después de "de"
              const m = s.match(/conceptos?\s+centrales?\s+de\s+(.+)/i)
              return m ? `Conceptos centrales de ${m[1].trim()}` : 'Conceptos centrales'
            }
            if (low.includes('definición')) return tema ? `Definición de ${tema}` : 'Definición'
            if (low.includes('característica')) return tema ? `Características de ${tema}` : 'Características'
            if (low.includes('función')) return tema ? `Funciones de ${tema}` : 'Funciones'
            if (low.includes('ejemplo')) return 'Ejemplos'
            if (low.includes('conclus')) return 'Conclusiones fundamentadas'
            if (low.includes('justific')) return 'Justificación/argumentos clave'
            if (low.includes('anális')) return tema ? `Análisis de ${tema}` : 'Análisis'

            // eliminar verbos comunes al inicio para dejar el sustantivo clave
            const pruned = s.replace(/^(explique|explicar|describa|describir|establezca|establecer|analice|analizar|compare|comparar|defina|definir|mencione|mencionar|liste|listar|argumente|argumentar|concluya|concluir)\s+(sobre|de|del|de la|los|las)?\s*/i, '')
            // si tras podar sigue largo, quedarnos con 3-8 palabras
            const words = pruned.trim().split(/\s+/)
            if (words.length >= 3) return words.slice(0, Math.min(8, words.length)).join(' ')
            return pruned.trim() || null
          }

          const normalized = Array.from(new Set(
            segments
              .map(normalize)
              .filter((x): x is string => !!x)
              .map(s => s.replace(/[,:;.-]+$/g, ''))
          ))

          // limitar a 4–6 puntos
          return normalized.slice(0, 6)
        }
        let bullets = keyPointsFromSample(qd.sampleAnswer)
        if (bullets.length === 0) {
          const tema = (test?.topic || 'tema')
          bullets = [
            `Conceptos centrales de ${tema}`,
            `Componentes/etapas clave de ${tema}`,
            `Ejemplos aplicados`,
            `Conclusiones fundamentadas`,
          ]
        }
        const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
        const labelH = lineH
        const wText = maxWidth - boxPaddingX * 2 - 8
        const bulletsH = bullets.reduce((acc, item) => acc + (pdf.splitTextToSize(item, wText).length * lineH + 2), 0)
        const totalH = boxPaddingY * 2 + headerH + 4 + labelH + bulletsH + 2
        ensureSpace(totalH + 2)
        drawBox(totalH)
        let innerY = y + boxPaddingY + 2
        pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
        pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
        innerY += 2
        pdf.text('Conceptos clave:', margin + boxPaddingX + 6, innerY)
        innerY += lineH
        pdf.setFont('helvetica','normal')
        bullets.forEach((b) => {
          const x = margin + boxPaddingX + 6
          const bullet = '• '
          const lines = pdf.splitTextToSize(b, wText)
          // primera línea con viñeta
          if (lines.length > 0) {
            pdf.text(bullet + lines[0], x, innerY)
            innerY += lineH
          }
          for (let k = 1; k < lines.length; k++) {
            pdf.text('  ' + lines[k], x, innerY)
            innerY += lineH
          }
          innerY += 2
        })
        y += totalH + 4
      }

      addFooter()
      const filename = `${test?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'prueba'}-${courseSectionName?.replace(/[^a-zA-Z0-9]/g, '_') || 'curso'}-CLAVE.pdf`
      pdf.save(filename)
    } catch (error) {
      console.error('[TestViewDialog] Error al generar PDF de respuestas:', error)
      alert('Error al generar el PDF de respuestas. Inténtelo nuevamente.')
    }
  }

  // 📄 NUEVO: Exportar PDF con una copia por estudiante del curso (incluye nombre y RUT)
  const handleExportPDFCourse = async () => {
    try {
      // Verificar que las preguntas estén disponibles antes de generar el PDF
      if (!questions || questions.length === 0) {
        console.warn('[TestViewDialog] No hay preguntas disponibles para generar el PDF de curso')
        alert('Espera un momento mientras se cargan las preguntas...')
        return
      }
      
      // Pequeña pausa para asegurar que el estado esté completamente actualizado
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Obtener estudiantes filtrados por sección
      const studentsInSection = filtered.filter((s: any) => s.name && s.name.trim())
      if (studentsInSection.length === 0) {
        alert('No hay estudiantes en este curso/sección para generar el PDF.')
        return
      }

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 15
      const maxWidth = pageWidth - margin * 2
      const lineH = 6

      // Para cada estudiante, generar una copia de la prueba
      for (let studentIdx = 0; studentIdx < studentsInSection.length; studentIdx++) {
        const student = studentsInSection[studentIdx]
        
        if (studentIdx > 0) {
          pdf.addPage()
        }

        let y = margin

        const ensureSpace = (h: number) => {
          if (y + h > pageHeight - margin) {
            addFooter()
            pdf.addPage()
            y = margin
            drawHeader(true)
          }
        }

        const text = (str: string, opts?: { size?: number; bold?: boolean; add?: number }) => {
          const size = opts?.size ?? 12
          const bold = opts?.bold ?? false
          const add = opts?.add ?? 0
          pdf.setFont('helvetica', bold ? 'bold' : 'normal')
          pdf.setFontSize(size)
          const lines = pdf.splitTextToSize(str, maxWidth)
          ensureSpace(lines.length * lineH + add)
          lines.forEach((l: string) => { pdf.text(l, margin, y); y += lineH })
          y += add
        }

        const drawHeader = (compact = false) => {
          pdf.setFont('helvetica', 'bold')
          if (!compact) {
            // Título centrado grande
            pdf.setFontSize(18)
            const title = (test?.title || 'PRUEBA').toUpperCase()
            const tW = pdf.getTextWidth(title)
            pdf.text(title, (pageWidth - tW) / 2, y)
            y += 8
            // Línea decorativa
            pdf.setDrawColor(50)
            pdf.setLineWidth(0.8)
            pdf.line(margin, y, pageWidth - margin, y)
            pdf.setLineWidth(0.4)
            y += 6
            // Datos de la prueba
            text(`TEMA: ${test?.topic || '-'}`, { bold: true })
            const courseSec = courseName ? `${courseName} ${courseSectionName}` : (courseSectionName || '-')
            text(`CURSO/SECCIÓN: ${courseSec}`, { bold: true })
            text(`ASIGNATURA: ${subjectName || 'Ciencias Naturales'}`, { bold: true })
            // Puntaje total
            const counts = test?.counts || { tf: 0, mc: 0, ms: 0, des: 0 }
            const totalQuestions = (counts.tf || 0) + (counts.mc || 0) + (counts.ms || 0) + (counts.des || 0)
            const totalPoints = (typeof test?.totalPoints === 'number' && (test?.totalPoints as number) > 0) ? (test!.totalPoints as number) : totalQuestions
            text(`PUNTAJE TOTAL: ${totalPoints} pts`, { bold: true })
            y += 4
            
            // 📌 NOMBRE Y RUT DEL ESTUDIANTE (pre-llenado)
            pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12)
            const nombreLabel = 'NOMBRE DEL ESTUDIANTE:'
            pdf.text(nombreLabel, margin, y)
            pdf.setFont('helvetica', 'normal')
            const nombreX = margin + pdf.getTextWidth(nombreLabel) + 3
            pdf.text(student.name || '', nombreX, y)
            // Línea bajo el nombre
            const lineStart = nombreX + pdf.getTextWidth(student.name || '') + 2
            if (lineStart < pageWidth - margin) {
              pdf.line(lineStart, y, pageWidth - margin, y)
            }
            y += 7
            
            // RUT del estudiante
            pdf.setFont('helvetica', 'bold')
            const rutLabel = 'RUT:'
            pdf.text(rutLabel, margin, y)
            pdf.setFont('helvetica', 'normal')
            const rutX = margin + pdf.getTextWidth(rutLabel) + 3
            const rutValue = student.rut || '_______________'
            pdf.text(rutValue, rutX, y)
            y += 8
            
            pdf.setDrawColor(30)
            pdf.line(margin, y, pageWidth - margin, y)
            y += 6
          } else {
            // Encabezado compacto para páginas siguientes
            pdf.setFontSize(12)
            const title = (test?.title || 'PRUEBA').toUpperCase()
            pdf.text(title, margin, y)
            // Nombre del estudiante a la derecha
            const studentInfo = `${student.name}${student.rut ? ` - ${student.rut}` : ''}`
            pdf.setFont('helvetica','normal')
            pdf.text(studentInfo, pageWidth - margin - pdf.getTextWidth(studentInfo), y)
            y += 4
            pdf.setDrawColor(30)
            pdf.line(margin, y, pageWidth - margin, y)
            y += 4
          }
        }

        const addFooter = () => {
          const page = (pdf as any).internal?.getNumberOfPages?.() || (pdf as any).internal?.pages?.length || 1
          pdf.setFont('helvetica','normal'); pdf.setFontSize(9)
          pdf.text(`Página ${page}`, pageWidth - margin - 20, pageHeight - 6)
        }

        // Estética base
        pdf.setTextColor(0)
        pdf.setDrawColor(30)
        pdf.setLineWidth(0.4)

        // Pinta el primer encabezado
        drawHeader(false)

        // Usar las preguntas del useMemo (ya procesadas con fallback)
        const qs = questions
        const letters = ['A','B','C','D','E','F']
        const boxPaddingX = 4
        const boxPaddingY = 4

        const calcTextHeight = (s: string, width: number) => {
          const lines = pdf.splitTextToSize(s, width)
          return lines.length * lineH
        }

        const drawBox = (height: number) => {
          const x = margin
          const w = pageWidth - margin * 2
          const h = height
          pdf.setDrawColor(60)
          pdf.roundedRect(x, y, w, h, 2, 2)
          // Banda lateral
          pdf.setFillColor(235, 232, 246)
          pdf.rect(x + 1.5, y + 1.5, 3, h - 3, 'F')
        }

        for (let i = 0; i < qs.length; i++) {
          const q: any = qs[i]
          const num = i + 1
          const pts = q.type === 'tf' ? perQuestionPoints.tf
            : q.type === 'mc' ? perQuestionPoints.mc
            : q.type === 'ms' ? perQuestionPoints.ms
            : perQuestionPoints.des
          const ptsLabel = pts ? ` (${fmtPts(pts)} pts)` : ''

          if (q.type === 'tf') {
            const title = `${num}. ${q.text}${ptsLabel}`
            const titleH = calcTextHeight(title, maxWidth - boxPaddingX * 2)
            const totalH = boxPaddingY * 2 + titleH + 10
            ensureSpace(totalH + 2)
            drawBox(totalH)
            let innerY = y + boxPaddingY + 2
            pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
            const lines = pdf.splitTextToSize(title, maxWidth - boxPaddingX * 2)
            lines.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
            pdf.setFont('helvetica','normal')
            pdf.text('V (    )', margin + boxPaddingX + 10, innerY + 2)
            pdf.text('F (    )', margin + boxPaddingX + 40, innerY + 2)
            y += totalH + 4
            continue
          }

          if (q.type === 'mc') {
            const header = `${num}. ${q.text}${ptsLabel}`
            const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
            const optionHeights = q.options.map((opt: string, idx: number) => calcTextHeight(`(${letters[idx] || String(idx+1)}) ${opt}`, maxWidth - boxPaddingX * 2 - 4))
            const optionsH = optionHeights.reduce((a: number, b: number) => a + b + 2, 0)
            const totalH = boxPaddingY * 2 + headerH + 2 + optionsH
            ensureSpace(totalH + 2)
            drawBox(totalH)
            let innerY = y + boxPaddingY + 2
            pdf.setFont('helvetica','bold')
            pdf.setFontSize(12)
            pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
            innerY += 1
            pdf.setFont('helvetica','normal')
            q.options.forEach((opt: string, idx: number) => {
              const linesOpt = pdf.splitTextToSize(`(${letters[idx] || String(idx+1)}) ${opt}`, maxWidth - boxPaddingX * 2 - 4)
              linesOpt.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 8, innerY); innerY += lineH })
              innerY += 2
            })
            y += totalH + 4
            continue
          }

          if (q.type === 'ms') {
            const header = `${num}. ${q.text}${ptsLabel}`
            const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
            let optionsH = 0
            const linesPerOpt: Array<string[]> = []
            q.options.forEach((opt: any, idx: number) => {
              const linesOpt = pdf.splitTextToSize(`(${letters[idx] || String(idx+1)}) ${opt.text}`, maxWidth - boxPaddingX * 2 - 12)
              linesPerOpt.push(linesOpt as unknown as string[])
              optionsH += linesOpt.length * lineH + 4
            })
            const totalH = boxPaddingY * 2 + headerH + 2 + optionsH
            ensureSpace(totalH + 2)
            drawBox(totalH)
            let innerY = y + boxPaddingY + 2
            pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
            pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
            innerY += 2
            pdf.setFont('helvetica','normal')
            q.options.forEach((_opt: any, idx: number) => {
              pdf.rect(margin + boxPaddingX + 6, innerY - 3.5, 3.5, 3.5)
              const linesOpt = linesPerOpt[idx]
              linesOpt.forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 12, innerY); innerY += lineH })
              innerY += 2
            })
            y += totalH + 4
            continue
          }

          // Desarrollo
          const header = `${num}. ${q.prompt}${ptsLabel}`
          const headerH = calcTextHeight(header, maxWidth - boxPaddingX * 2)
          const linesCount = 7
          const linesArea = linesCount * (lineH + 2) + 2
          const totalH = boxPaddingY * 2 + headerH + 6 + linesArea
          ensureSpace(totalH + 2)
          drawBox(totalH)
          let innerY = y + boxPaddingY + 2
          pdf.setFont('helvetica','bold'); pdf.setFontSize(12)
          pdf.splitTextToSize(header, maxWidth - boxPaddingX * 2).forEach((l: string) => { pdf.text(l, margin + boxPaddingX + 6, innerY); innerY += lineH })
          innerY += 4
          for (let k = 0; k < linesCount; k++) {
            pdf.line(margin + boxPaddingX + 6, innerY, pageWidth - margin - boxPaddingX, innerY)
            innerY += lineH + 2
          }
          y += totalH + 4
        }

        addFooter()
      }

      const filename = `${test?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'prueba'}-${courseSectionName?.replace(/[^a-zA-Z0-9]/g, '_') || 'curso'}-CURSO.pdf`
      pdf.save(filename)
    } catch (error) {
      console.error('[TestViewDialog] Error al generar PDF del curso:', error)
      alert('Error al generar el PDF del curso. Inténtelo nuevamente.')
    }
  }

  // Verificar si las preguntas están cargándose
  const isLoading = !questions || questions.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Limitar alto y permitir desplazamiento para pruebas largas */}
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">Vista: {test?.title || "Prueba"}</DialogTitle>
        </DialogHeader>
        
        {/* Indicador de carga mientras se generan las preguntas */}
        {isLoading && (
          <div className="flex items-center justify-center p-8 bg-fuchsia-50 dark:bg-fuchsia-900/20 rounded-lg border border-fuchsia-200 dark:border-fuchsia-800">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-fuchsia-600"></div>
              <p className="text-sm text-fuchsia-700 dark:text-fuchsia-300 font-medium">
                Cargando preguntas...
              </p>
              <p className="text-xs text-muted-foreground">
                Por favor espera un momento mientras se genera el contenido de la prueba.
              </p>
            </div>
          </div>
        )}
        
        <div className="mb-3 text-sm text-muted-foreground">
          {(() => {
            const counts = test?.counts || { tf: 0, mc: 0, ms: 0, des: 0 }
            const totalQuestions = (counts.tf || 0) + (counts.mc || 0) + (counts.ms || 0) + (counts.des || 0)
            const totalPoints = (typeof test?.totalPoints === 'number' && (test?.totalPoints as number) > 0) ? (test!.totalPoints as number) : totalQuestions
            return `Puntaje total: ${totalPoints} pts`
          })()}
        </div>
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="text-sm text-muted-foreground font-medium">
            {courseName ? `${courseName} ${courseSectionName}` : courseSectionName}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleExportPDF}
              disabled={!questions || questions.length === 0}
              className={`border-fuchsia-200 text-fuchsia-800 hover:bg-fuchsia-600 hover:text-white dark:border-fuchsia-800 font-medium ${(!questions || questions.length === 0) ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              📄 Descargar PDF
            </Button>
            <Button
              variant="outline"
              onClick={handleExportPDFAnswered}
              disabled={!questions || questions.length === 0}
              className={`border-green-200 text-green-800 hover:bg-green-600 hover:text-white dark:border-green-800 font-medium ${(!questions || questions.length === 0) ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              ✅ Revisado (PDF)
            </Button>
            <Button
              variant="outline"
              onClick={handleExportPDFCourse}
              disabled={!questions || questions.length === 0}
              className={`border-blue-200 text-blue-800 hover:bg-blue-600 hover:text-white dark:border-blue-800 font-medium ${(!questions || questions.length === 0) ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              👥 PDF Curso
            </Button>
          </div>
        </div>

        {/* Estilos de impresión personalizados */}
        <style jsx>{`
          @media print {
            .print-break-inside-avoid {
              break-inside: avoid;
              page-break-inside: avoid;
            }
            .print-break-after {
              break-after: page;
              page-break-after: always;
            }
            .print-margin {
              margin: 20mm;
            }
          }
        `}</style>

        {/* Contenido imprimible de la prueba */}
        <div
          ref={contentRef}
          className="mt-3 border rounded-md p-8 space-y-8 bg-white text-black dark:bg-white dark:text-black border-gray-200 dark:border-gray-300 print:bg-white print:text-black print-margin print:shadow-none"
        >
          {/* Encabezado de la prueba */}
          <div className="space-y-6 print-break-inside-avoid" data-pdf-block>
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold uppercase tracking-wide print:text-3xl">{test?.title || "PRUEBA"}</h1>
            </div>
            
            {/* Información organizada con mejor espaciado */}
            <div className="space-y-4 text-base leading-relaxed print:text-lg">
              <div className="border-b pb-2 print:border-black">
                <span className="font-semibold uppercase tracking-wide">Tema:</span> 
                <span className="ml-3">{test?.topic || "-"}</span>
              </div>
              <div className="border-b pb-2 print:border-black">
                <span className="font-semibold uppercase tracking-wide">Curso/Sección:</span> 
                <span className="ml-3">{courseName ? `${courseName} ${courseSectionName}` : courseSectionName}</span>
              </div>
              <div className="border-b pb-2 print:border-black">
                <span className="font-semibold uppercase tracking-wide">Asignatura:</span> 
                <span className="ml-3">{subjectName || "Ciencias Naturales"}</span>
              </div>
              <div className="mt-6 pt-4">
                <span className="font-semibold uppercase tracking-wide">Nombre del estudiante:</span> 
                <span className="ml-3 border-b-2 border-dotted border-gray-400 print:border-black inline-block w-80 pb-1"></span>
              </div>
            </div>
          </div>

          {/* Separador entre información inicial y preguntas */}
          <div className="border-t-2 border-gray-300 dark:border-gray-300 print:border-black my-8"></div>

          {/* Indicador de carga si no hay preguntas */}
          {(!questions || questions.length === 0) && (
            <div className="flex flex-col items-center justify-center py-16 space-y-4">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-fuchsia-200 border-t-fuchsia-600"></div>
              <p className="text-lg text-muted-foreground">Generando preguntas...</p>
              <p className="text-sm text-muted-foreground">Por favor espere mientras se crean las preguntas de la prueba.</p>
            </div>
          )}

          {/* Preguntas con mayor separación */}
          <div className="space-y-8">
            {questions.map((q, idx) => {
              const num = idx + 1
              const pts = (q as any).type === 'tf' ? perQuestionPoints.tf
                : (q as any).type === 'mc' ? perQuestionPoints.mc
                : (q as any).type === 'ms' ? perQuestionPoints.ms
                : perQuestionPoints.des
              const ptsLabel = pts ? ` (${fmtPts(pts)} pts)` : ''
              if ((q as any).type === "tf") {
                const qt = q as QuestionTF
                return (
                  <div key={q.id} data-pdf-block className="text-base leading-relaxed p-4 border-l-4 border-blue-200 bg-blue-50/30 print:border-l-2 print:border-black print:bg-white print-break-inside-avoid">
                    <div className="font-semibold mb-3 text-lg print:text-xl">{num}. {qt.text}<span className="text-sm font-normal text-muted-foreground">{ptsLabel}</span></div>
                    <div className="ml-4 text-lg space-x-8 print:text-xl">
                      <span>V (     )</span>
                      <span>F (     )</span>
                    </div>
                  </div>
                )
              }
              if ((q as any).type === "mc") {
                const qm = q as QuestionMC
                const letters = ["A", "B", "C", "D", "E", "F"]
                return (
                  <div key={q.id} data-pdf-block className="text-base leading-relaxed p-4 border-l-4 border-green-200 bg-green-50/30 print:border-l-2 print:border-black print:bg-white print-break-inside-avoid">
                    <div className="font-semibold mb-4 text-lg print:text-xl">{num}. {qm.text}<span className="text-sm font-normal text-muted-foreground">{ptsLabel}</span></div>
                    <ul className="ml-4 space-y-3">
                      {qm.options.map((opt, i) => (
                        <li key={i} className="text-base leading-relaxed print:text-lg">
                          <span className="font-medium">({letters[i] || String(i + 1)})</span> {opt}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              }
              if ((q as any).type === "ms") {
                const qs = q as QuestionMS
                const letters = ["A", "B", "C", "D", "E", "F"]
                return (
                  <div key={q.id} data-pdf-block className="text-base leading-relaxed p-4 border-l-4 border-purple-200 bg-purple-50/30 print:border-l-2 print:border-black print:bg-white print-break-inside-avoid">
                    <div className="font-semibold mb-4 text-lg print:text-xl">{num}. {qs.text}<span className="text-sm font-normal text-muted-foreground">{ptsLabel}</span></div>
                    <ul className="ml-4 space-y-3">
                      {qs.options.map((opt, i) => (
                        <li key={i} className="text-base leading-relaxed print:text-lg flex items-center">
                          <span className="inline-block w-6 h-6 border-2 border-gray-400 dark:border-gray-500 mr-3 print:border-black print:border-2"></span>
                          <span className="font-medium">({letters[i] || String(i + 1)})</span>
                          <span className="ml-2">{opt.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              }
              // Desarrollo
              const qd = q as QuestionDES
              return (
                <div key={q.id} data-pdf-block className="text-base leading-relaxed p-4 border-l-4 border-orange-200 bg-orange-50/30 print:border-l-2 print:border-black print:bg-white print-break-inside-avoid">
                  <div className="font-semibold mb-4 text-lg print:text-xl">{num}. {qd.prompt}<span className="text-sm font-normal text-muted-foreground">{ptsLabel}</span></div>
                  <div className="ml-4 mt-4 h-32 border-2 border-gray-300 rounded-lg bg-white/50 print:border-black print:bg-white print:h-40" />
                  <div className="ml-4 mt-2 text-xs text-gray-500 dark:text-gray-700 italic print:text-sm print:text-black">
                    Espacio para desarrollo de la respuesta
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
