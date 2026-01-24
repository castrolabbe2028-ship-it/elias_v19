"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import { Eye, ClipboardCheck, FileSearch, Trash2, CheckCircle, Wand2, Upload } from "lucide-react"
import { useLanguage } from "@/contexts/language-context"
import { useAuth } from "@/contexts/auth-context"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import TestViewDialog from "@/components/pruebas/TestViewDialog"
import TestReviewDialog from "@/components/pruebas/TestReviewDialog"
import TestBuilder from "@/components/pruebas/TestBuilder"
import ManualTestBuilder from "@/components/pruebas/ManualTestBuilder"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// Tipos
export type TestItem = {
	id: string
	title: string
	description?: string
	createdAt: number
	courseId?: string
	sectionId?: string
	subjectId?: string
	subjectName?: string
	topic?: string
	counts?: { tf: number; mc: number; ms: number; des?: number }
	weights?: { tf: number; mc: number; ms: number; des: number }
	totalPoints?: number
	total?: number
	questions?: any[]
	status?: "generating" | "ready"
	progress?: number
	ownerId?: string
	ownerUsername?: string
}

const TESTS_BASE_KEY = "smart-student-tests"
const getTestsKey = (user?: { username?: string | null } | null): string => {
	const uname = user?.username ? String(user.username).trim().toLowerCase() : ""
	return uname ? `${TESTS_BASE_KEY}_${uname}` : TESTS_BASE_KEY
}
const getReviewKey = (id: string) => `smart-student-test-reviews_${id}`

export default function PruebasPage() {
	const { translate, language } = useLanguage()
	const { user } = useAuth()

	// Modo de creación: 'automatic' o 'manual'
	const [creationMode, setCreationMode] = useState<'automatic' | 'manual'>('automatic')

	const [tests, setTests] = useState<TestItem[]>([])
	const [builder, setBuilder] = useState<any>({})

	const [selected, setSelected] = useState<TestItem | null>(null)
	const [openView, setOpenView] = useState(false)
	const [openReview, setOpenReview] = useState(false)

	// Confirmación de borrado
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [deleteTarget, setDeleteTarget] = useState<TestItem | null>(null)

	// Progreso simulado
	const progressIntervalRef = useRef<number | null>(null)

	// Datos base (solo para etiquetas mínimas)
	const [courses, setCourses] = useState<any[]>([])
	const [sections, setSections] = useState<any[]>([])
	const [subjects, setSubjects] = useState<any[]>([])

	// Cargar datasets y pruebas
	useEffect(() => {
		try {
			setCourses(JSON.parse(localStorage.getItem("smart-student-courses") || "[]"))
			setSections(JSON.parse(localStorage.getItem("smart-student-sections") || "[]"))
			setSubjects(JSON.parse(localStorage.getItem("smart-student-subjects") || "[]"))
		} catch {}

		try {
			const key = getTestsKey(user)
			const raw = localStorage.getItem(key)
			if (raw) {
				setTests(JSON.parse(raw))
			} else {
				const globalRaw = localStorage.getItem(TESTS_BASE_KEY)
				if (globalRaw) {
					const globalItems: TestItem[] = JSON.parse(globalRaw)
					const mine = user
						? globalItems.filter(
								(t) => (t.ownerId === (user as any).id) || (t.ownerUsername === (user as any).username)
							)
						: globalItems
					if (mine.length > 0) {
						localStorage.setItem(key, JSON.stringify(mine))
						setTests(mine)
					} else setTests([])
				} else setTests([])
			}
		} catch (e) {
			console.error("[Pruebas] Error cargando/migrando historial:", e)
		}

		const onStorage = (e: StorageEvent) => {
			if (!e.key) return
			const currentKey = getTestsKey(user)
			if (e.key === currentKey) setTests(JSON.parse(e.newValue || "[]"))
			if (e.key === "smart-student-courses") setCourses(JSON.parse(e.newValue || "[]"))
			if (e.key === "smart-student-sections") setSections(JSON.parse(e.newValue || "[]"))
			if (e.key === "smart-student-subjects") setSubjects(JSON.parse(e.newValue || "[]"))
		}
		window.addEventListener("storage", onStorage)
		return () => window.removeEventListener("storage", onStorage)
	}, [user?.username])

	const saveTests = (items: TestItem[]) => {
		const key = getTestsKey(user)
		setTests(items)
		localStorage.setItem(key, JSON.stringify(items))
		window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(items) }))
	}

	const patchTest = (id: string, patch: Partial<TestItem>) => {
		const key = getTestsKey(user)
		setTests((prev) => {
			const updated: TestItem[] = prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
			localStorage.setItem(key, JSON.stringify(updated))
			window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(updated) }))
			return updated
		})
	}

	// Progreso simulado si status === 'generating'
	useEffect(() => {
		const hasGenerating = tests.some((t) => t.status === "generating")
		if (hasGenerating && !progressIntervalRef.current) {
			progressIntervalRef.current = window.setInterval(() => {
				setTests((prev) => {
					const updated: TestItem[] = prev.map((t) => {
						if (t.status === "generating") {
							const inc = Math.floor(Math.random() * 8) + 3
							const next = Math.min(100, (t.progress || 0) + inc)
							return { ...t, progress: next, status: (next >= 100 ? "ready" : "generating") as "ready" | "generating" }
						}
						return t
					})
					const key = getTestsKey(user)
					localStorage.setItem(key, JSON.stringify(updated))
					window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(updated) }))
					if (!updated.some((x) => x.status === "generating") && progressIntervalRef.current) {
						window.clearInterval(progressIntervalRef.current)
						progressIntervalRef.current = null
					}
					return updated
				})
			}, 600) as unknown as number
		}
		if (!hasGenerating && progressIntervalRef.current) {
			window.clearInterval(progressIntervalRef.current)
			progressIntervalRef.current = null
		}
		return () => {
			if (progressIntervalRef.current) {
				window.clearInterval(progressIntervalRef.current)
				progressIntervalRef.current = null
			}
		}
	}, [tests])

	// Obtener la versión más actualizada del test seleccionado desde el array tests
	const selectedTest = useMemo(() => {
		if (!selected) return undefined
		// Buscar el test actualizado en el array para obtener las questions más recientes
		const updated = tests.find(t => t.id === selected.id)
		return updated || selected
	}, [selected, tests])

	const handleOpenView = (t: TestItem) => { setSelected(t); setOpenView(true) }
	const handleOpenReview = (t?: TestItem) => { if (t) setSelected(t); setOpenReview(true) }

	const hasAnyReview = (id: string) => {
		try { const raw = localStorage.getItem(getReviewKey(id)); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) && arr.length > 0 } catch { return false }
	}

	// Generador local mejorado con preguntas variadas y educativas
	const generateLocalQuestions = (topic: string, counts?: { tf?: number; mc?: number; ms?: number; des?: number }, subjectName?: string, courseName?: string) => {
		const res: any[] = []
		if (!counts) return res
		const makeId = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
		const cleanTopic = (topic || 'el tema').trim()
		const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
		
		// Texto combinado para detección
		const detectionText = (topic + ' ' + (subjectName || '')).toLowerCase()
		const courseText = (courseName || '').toLowerCase()
		
		// Detectar nivel del curso
		// Nivel 1: 1ro-2do Básico (6-8 años) - números hasta 100, sumas y restas simples
		// Nivel 2: 3ro-4to Básico (8-10 años) - números hasta 1000, multiplicación, división simple
		// Nivel 3: 5to-6to Básico (10-12 años) - fracciones, decimales, geometría básica
		// Nivel 4: 7mo-8vo Básico (12-14 años) - porcentajes, ecuaciones simples, geometría
		// Nivel 5: 1ro-4to Medio (14-18 años) - álgebra, trigonometría, funciones
		let courseLevel = 3 // Por defecto nivel medio
		if (/1r[oa]?\s*b[aá]sic|2d[oa]?\s*b[aá]sic|primero\s*b|segundo\s*b/i.test(courseText)) {
			courseLevel = 1
		} else if (/3r[oa]?\s*b[aá]sic|4t[oa]?\s*b[aá]sic|tercero\s*b|cuarto\s*b/i.test(courseText)) {
			courseLevel = 2
		} else if (/5t[oa]?\s*b[aá]sic|6t[oa]?\s*b[aá]sic|quinto\s*b|sexto\s*b/i.test(courseText)) {
			courseLevel = 3
		} else if (/7m[oa]?\s*b[aá]sic|8v[oa]?\s*b[aá]sic|s[eé]ptimo|octavo/i.test(courseText)) {
			courseLevel = 4
		} else if (/1r[oa]?\s*medi|2d[oa]?\s*medi|3r[oa]?\s*medi|4t[oa]?\s*medi|primero\s*m|segundo\s*m|tercero\s*m|cuarto\s*m/i.test(courseText)) {
			courseLevel = 5
		}
		
		console.log('[generateLocalQuestions] Detectando:', { topic, subjectName, courseName, courseLevel, detectionText })
		
		// Detectar tipo de asignatura para personalizar preguntas
		const isMath = /matem[aá]tica|math|algebra|geometr[ií]a|aritm[eé]tica|c[aá]lculo|ecuacion|fracci[oó]n|porcentaje|trigonometr|sumas?|restas?|multiplic|divisi|n[uú]mero/i.test(detectionText)
		const isPhysics = /f[ií]sica|physics|mec[aá]nica|cin[eé]tica|din[aá]mica|fuerza|velocidad|aceleraci[oó]n|energ[ií]a|trabajo|potencia/i.test(detectionText)
		const isExactScience = isMath || isPhysics
		const isScience = /ciencia|biolog[ií]a|qu[ií]mica|naturaleza|ambiente|ecolog|sistema|c[eé]lula|planeta/i.test(detectionText)
		const isHistory = /historia|geograf[ií]a|social|civica|ciudadan|gobierno|pa[ií]s|cultura|civilizaci/i.test(detectionText)
		const isLanguage = /lenguaje|literatura|español|gram[aá]tica|ortograf|lectura|escritura|comunicaci/i.test(detectionText)
		
		console.log('[generateLocalQuestions] Tipo detectado:', { isMath, isPhysics, isExactScience, courseLevel })
		
		// ============ EJERCICIOS POR NIVEL ============
		// Plantillas de preguntas V/F - EJERCICIOS adaptados por nivel
		let tfTemplates: { text: string; answer: boolean }[] = []
		
		if (isExactScience) {
			if (courseLevel === 1) {
				// 1ro-2do Básico: Sumas y restas simples hasta 20
				tfTemplates = [
					{ text: `5 + 3 = 8`, answer: true },
					{ text: `7 + 2 = 10`, answer: false },
					{ text: `10 - 4 = 6`, answer: true },
					{ text: `8 - 3 = 4`, answer: false },
					{ text: `6 + 4 = 10`, answer: true },
					{ text: `9 - 5 = 4`, answer: true },
					{ text: `3 + 5 = 9`, answer: false },
					{ text: `12 - 7 = 5`, answer: true },
					{ text: `4 + 4 = 8`, answer: true },
					{ text: `15 - 8 = 6`, answer: false },
					{ text: `2 + 9 = 11`, answer: true },
					{ text: `11 - 6 = 5`, answer: true },
				]
			} else if (courseLevel === 2) {
				// 3ro-4to Básico: Operaciones hasta 1000, multiplicación simple
				tfTemplates = [
					{ text: `45 + 28 = 73`, answer: true },
					{ text: `67 - 39 = 28`, answer: true },
					{ text: `5 × 6 = 30`, answer: true },
					{ text: `8 × 7 = 54`, answer: false },
					{ text: `124 + 56 = 180`, answer: true },
					{ text: `200 - 75 = 125`, answer: true },
					{ text: `9 × 4 = 36`, answer: true },
					{ text: `7 × 8 = 54`, answer: false },
					{ text: `150 + 250 = 400`, answer: true },
					{ text: `6 × 6 = 36`, answer: true },
				]
			} else if (courseLevel === 3) {
				// 5to-6to Básico: Fracciones, decimales
				tfTemplates = [
					{ text: `1/2 + 1/4 = 3/4`, answer: true },
					{ text: `0.5 + 0.25 = 0.75`, answer: true },
					{ text: `2/3 es mayor que 1/2`, answer: true },
					{ text: `0.8 es menor que 0.75`, answer: false },
					{ text: `3/4 = 0.75`, answer: true },
					{ text: `234 × 10 = 2340`, answer: true },
					{ text: `1/3 + 1/3 = 2/3`, answer: true },
					{ text: `500 ÷ 5 = 100`, answer: true },
				]
			} else {
				// Nivel 4-5: Más avanzado
				tfTemplates = [
					{ text: `Si un producto cuesta $80 y tiene 25% de descuento, el precio final es $60.`, answer: true },
					{ text: `El perímetro de un rectángulo de 10cm x 5cm es 30cm.`, answer: true },
					{ text: `Si 3x = 27, entonces x = 9.`, answer: true },
					{ text: `El área de un cuadrado de lado 8cm es 64cm².`, answer: true },
					{ text: `El 20% de 150 es igual a 30.`, answer: true },
					{ text: `La fracción 3/4 es mayor que 2/3.`, answer: true },
				]
			}
		} else if (isScience) {
			tfTemplates = [
				{ text: `${cap(cleanTopic)} es un proceso fundamental que ocurre en todos los seres vivos.`, answer: true },
				{ text: `Los cambios en ${cleanTopic} pueden afectar a otros sistemas relacionados.`, answer: true },
				{ text: `${cap(cleanTopic)} solo puede observarse en condiciones de laboratorio.`, answer: false },
				{ text: `El estudio de ${cleanTopic} ayuda a comprender mejor nuestro entorno.`, answer: true },
				{ text: `${cap(cleanTopic)} es un fenómeno que no tiene relación con la vida cotidiana.`, answer: false },
				{ text: `Los científicos utilizan el método científico para estudiar ${cleanTopic}.`, answer: true },
				{ text: `${cap(cleanTopic)} es un proceso que permanece siempre constante.`, answer: false },
				{ text: `Comprender ${cleanTopic} es importante para el cuidado del medio ambiente.`, answer: true },
			]
		} else if (isHistory) {
			tfTemplates = [
				{ text: `Los eventos relacionados con ${cleanTopic} tuvieron impacto en la sociedad de su época.`, answer: true },
				{ text: `${cap(cleanTopic)} es un tema que solo interesa a los historiadores profesionales.`, answer: false },
				{ text: `El estudio de ${cleanTopic} nos ayuda a entender el presente.`, answer: true },
				{ text: `Los cambios provocados por ${cleanTopic} fueron inmediatos y sin consecuencias posteriores.`, answer: false },
				{ text: `${cap(cleanTopic)} involucró la participación de diferentes grupos sociales.`, answer: true },
				{ text: `Podemos aprender lecciones valiosas del estudio de ${cleanTopic}.`, answer: true },
				{ text: `${cap(cleanTopic)} no tiene ninguna relevancia para nuestra vida actual.`, answer: false },
				{ text: `El análisis de ${cleanTopic} requiere considerar múltiples perspectivas.`, answer: true },
			]
		} else {
			tfTemplates = [
				{ text: `El conocimiento de ${cleanTopic} es aplicable en situaciones de la vida real.`, answer: true },
				{ text: `${cap(cleanTopic)} es un concepto que no tiene relación con otras áreas del conocimiento.`, answer: false },
				{ text: `Comprender ${cleanTopic} requiere práctica y estudio constante.`, answer: true },
				{ text: `${cap(cleanTopic)} puede ser entendido de una sola manera, sin interpretaciones.`, answer: false },
				{ text: `El aprendizaje de ${cleanTopic} contribuye al desarrollo del pensamiento crítico.`, answer: true },
				{ text: `${cap(cleanTopic)} es un tema que solo se estudia en el colegio.`, answer: false },
				{ text: `Existen diferentes formas de aplicar los conceptos de ${cleanTopic}.`, answer: true },
				{ text: `El dominio de ${cleanTopic} se logra únicamente memorizando definiciones.`, answer: false },
			]
		}
		
		// Barajar y seleccionar preguntas V/F
		const shuffledTF = [...tfTemplates].sort(() => Math.random() - 0.5)
		for (let i = 0; i < (counts.tf || 0); i++) {
			const template = shuffledTF[i % shuffledTF.length]
			res.push({ id: makeId('tf'), type: 'tf', text: template.text, answer: template.answer })
		}
		
		// Plantillas de selección múltiple - EJERCICIOS adaptados por nivel
		let mcTemplates: { text: string; options: string[]; correctIndex: number }[] = []
		
		if (isExactScience) {
			if (courseLevel === 1) {
				// 1ro-2do Básico: Operaciones simples hasta 20
				mcTemplates = [
					{ text: `¿Cuánto es 5 + 4?`, options: ['7', '8', '9', '10'], correctIndex: 2 },
					{ text: `¿Cuánto es 8 - 3?`, options: ['4', '5', '6', '7'], correctIndex: 1 },
					{ text: `Si tienes 6 manzanas y te dan 3 más, ¿cuántas tienes?`, options: ['7', '8', '9', '10'], correctIndex: 2 },
					{ text: `Tienes 10 lápices y regalas 4. ¿Cuántos te quedan?`, options: ['5', '6', '7', '8'], correctIndex: 1 },
					{ text: `¿Cuánto es 7 + 5?`, options: ['10', '11', '12', '13'], correctIndex: 2 },
					{ text: `¿Cuánto es 15 - 7?`, options: ['6', '7', '8', '9'], correctIndex: 2 },
					{ text: `Si hay 4 pájaros y llegan 6 más, ¿cuántos hay?`, options: ['8', '9', '10', '11'], correctIndex: 2 },
					{ text: `¿Cuánto es 9 + 2?`, options: ['10', '11', '12', '13'], correctIndex: 1 },
				]
			} else if (courseLevel === 2) {
				// 3ro-4to Básico: Operaciones hasta 1000
				mcTemplates = [
					{ text: `¿Cuánto es 45 + 28?`, options: ['63', '73', '83', '53'], correctIndex: 1 },
					{ text: `¿Cuánto es 100 - 36?`, options: ['54', '64', '74', '84'], correctIndex: 1 },
					{ text: `¿Cuánto es 6 × 7?`, options: ['35', '42', '48', '49'], correctIndex: 1 },
					{ text: `Si tienes 120 caramelos y das 45, ¿cuántos quedan?`, options: ['65', '75', '85', '95'], correctIndex: 1 },
					{ text: `¿Cuánto es 8 × 9?`, options: ['63', '72', '81', '64'], correctIndex: 1 },
					{ text: `¿Cuánto es 250 + 175?`, options: ['415', '425', '435', '325'], correctIndex: 1 },
				]
			} else if (courseLevel === 3) {
				// 5to-6to Básico: Fracciones, decimales
				mcTemplates = [
					{ text: `¿Cuánto es 1/2 + 1/4?`, options: ['1/2', '2/4', '3/4', '1'], correctIndex: 2 },
					{ text: `¿Cuánto es 0.5 + 0.3?`, options: ['0.7', '0.8', '0.9', '1.0'], correctIndex: 1 },
					{ text: `¿Qué fracción es mayor?`, options: ['1/3', '1/2', '1/4', '1/5'], correctIndex: 1 },
					{ text: `¿Cuánto es 3.5 × 2?`, options: ['5.5', '6.0', '6.5', '7.0'], correctIndex: 3 },
					{ text: `¿Cuánto es 150 ÷ 5?`, options: ['25', '30', '35', '40'], correctIndex: 1 },
				]
			} else {
				// Nivel 4-5: Más avanzado
				mcTemplates = [
					{ text: `¿Cuál es el 25% de 200?`, options: ['40', '50', '60', '75'], correctIndex: 1 },
					{ text: `Si x + 15 = 42, entonces x =`, options: ['17', '27', '37', '57'], correctIndex: 1 },
					{ text: `El área de un rectángulo de 8×5 es:`, options: ['30', '35', '40', '45'], correctIndex: 2 },
					{ text: `¿Cuánto es (-5) + 8?`, options: ['3', '-3', '13', '-13'], correctIndex: 0 },
				]
			}
		} else if (isScience) {
			mcTemplates = [
				{ text: `¿Cuál es la importancia principal de estudiar ${cleanTopic}?`, options: ['No tiene importancia', 'Solo para aprobar exámenes', 'Comprender nuestro entorno', 'Es obligatorio'], correctIndex: 2 },
				{ text: `¿Qué método utilizan los científicos para estudiar ${cleanTopic}?`, options: ['Adivinación', 'Método científico', 'Opiniones personales', 'Tradición oral'], correctIndex: 1 },
				{ text: `¿Cómo se relaciona ${cleanTopic} con la vida cotidiana?`, options: ['No se relaciona', 'Solo en el laboratorio', 'En múltiples aspectos diarios', 'Solo en la escuela'], correctIndex: 2 },
				{ text: `¿Qué actitud es más apropiada al estudiar ${cleanTopic}?`, options: ['Memorizar sin entender', 'Curiosidad y observación', 'Solo leer el libro', 'No hacer preguntas'], correctIndex: 1 },
			]
		} else {
			mcTemplates = [
				{ text: `¿Por qué es importante aprender sobre ${cleanTopic}?`, options: ['Solo para las notas', 'Para el desarrollo personal', 'No es importante', 'Solo para el examen'], correctIndex: 1 },
				{ text: `¿Cuál es la mejor forma de estudiar ${cleanTopic}?`, options: ['Memorizar todo', 'Comprender y practicar', 'Solo leer una vez', 'Copiar las respuestas'], correctIndex: 1 },
				{ text: `¿Cómo podemos aplicar ${cleanTopic} en la vida real?`, options: ['No se puede aplicar', 'En diversas situaciones', 'Solo en el trabajo', 'Nunca se usa'], correctIndex: 1 },
				{ text: `¿Qué habilidad desarrollamos al estudiar ${cleanTopic}?`, options: ['Ninguna', 'Pensamiento crítico', 'Solo memoria', 'Nada útil'], correctIndex: 1 },
			]
		}
		
		const shuffledMC = [...mcTemplates].sort(() => Math.random() - 0.5)
		for (let i = 0; i < (counts.mc || 0); i++) {
			const template = shuffledMC[i % shuffledMC.length]
			res.push({ id: makeId('mc'), type: 'mc', text: template.text, options: [...template.options], correctIndex: template.correctIndex })
		}
		
		// Selección múltiple (varias correctas) - EJERCICIOS adaptados por nivel
		let msTemplates: { text: string; options: { text: string; correct: boolean }[] }[] = []
		
		if (isExactScience) {
			if (courseLevel === 1) {
				// 1ro-2do Básico: Operaciones simples
				msTemplates = [
					{ text: `Selecciona TODAS las sumas que dan 10:`, options: [
						{ text: `5 + 5`, correct: true },
						{ text: `7 + 3`, correct: true },
						{ text: `6 + 3`, correct: false },
						{ text: `8 + 2`, correct: true },
					]},
					{ text: `¿Cuáles restas dan como resultado 5?`, options: [
						{ text: `10 - 5`, correct: true },
						{ text: `8 - 3`, correct: true },
						{ text: `9 - 3`, correct: false },
						{ text: `7 - 2`, correct: true },
					]},
					{ text: `Selecciona los números mayores que 5:`, options: [
						{ text: `7`, correct: true },
						{ text: `3`, correct: false },
						{ text: `9`, correct: true },
						{ text: `4`, correct: false },
					]},
					{ text: `¿Cuáles sumas dan un resultado mayor que 10?`, options: [
						{ text: `6 + 6`, correct: true },
						{ text: `5 + 4`, correct: false },
						{ text: `8 + 5`, correct: true },
						{ text: `7 + 2`, correct: false },
					]},
				]
			} else if (courseLevel === 2) {
				// 3ro-4to Básico
				msTemplates = [
					{ text: `Selecciona TODAS las operaciones que dan 100:`, options: [
						{ text: `50 + 50`, correct: true },
						{ text: `75 + 25`, correct: true },
						{ text: `60 + 30`, correct: false },
						{ text: `10 × 10`, correct: true },
					]},
					{ text: `¿Cuáles números son pares?`, options: [
						{ text: `24`, correct: true },
						{ text: `37`, correct: false },
						{ text: `58`, correct: true },
						{ text: `46`, correct: true },
					]},
					{ text: `Selecciona las multiplicaciones que dan más de 50:`, options: [
						{ text: `8 × 7`, correct: true },
						{ text: `6 × 6`, correct: false },
						{ text: `9 × 8`, correct: true },
						{ text: `7 × 5`, correct: false },
					]},
				]
			} else {
				// Niveles 3-5: Más avanzado
				msTemplates = [
					{ text: `Selecciona las fracciones equivalentes a 1/2:`, options: [
						{ text: `2/4`, correct: true },
						{ text: `3/6`, correct: true },
						{ text: `2/3`, correct: false },
						{ text: `4/8`, correct: true },
					]},
					{ text: `¿Cuáles números son divisibles por 5?`, options: [
						{ text: `25`, correct: true },
						{ text: `32`, correct: false },
						{ text: `40`, correct: true },
						{ text: `55`, correct: true },
					]},
					{ text: `Selecciona los números mayores que 0.5:`, options: [
						{ text: `0.75`, correct: true },
						{ text: `0.3`, correct: false },
						{ text: `0.8`, correct: true },
						{ text: `0.25`, correct: false },
					]},
				]
			}
		} else {
			msTemplates = [
				{ text: `Selecciona todas las afirmaciones correctas sobre ${cleanTopic}:`, options: [
					{ text: `Es importante para el aprendizaje`, correct: true },
					{ text: `Se puede aplicar en la vida real`, correct: true },
					{ text: `No tiene ninguna utilidad práctica`, correct: false },
					{ text: `Solo sirve para aprobar exámenes`, correct: false },
				]},
				{ text: `¿Cuáles son características del estudio de ${cleanTopic}?`, options: [
					{ text: `Requiere práctica constante`, correct: true },
					{ text: `Se aprende de un día para otro`, correct: false },
					{ text: `Desarrolla habilidades de pensamiento`, correct: true },
					{ text: `Es completamente innecesario`, correct: false },
				]},
				{ text: `Marca las opciones que describen correctamente ${cleanTopic}:`, options: [
					{ text: `Tiene aplicación en diferentes contextos`, correct: true },
					{ text: `Es un tema aislado sin conexiones`, correct: false },
					{ text: `Contribuye a la formación integral`, correct: true },
					{ text: `Solo interesa a los expertos`, correct: false },
				]},
			]
		}
		
		const shuffledMS = [...msTemplates].sort(() => Math.random() - 0.5)
		for (let i = 0; i < (counts.ms || 0); i++) {
			const template = shuffledMS[i % shuffledMS.length]
			res.push({ id: makeId('ms'), type: 'ms', text: template.text, options: [...template.options].sort(() => Math.random() - 0.5) })
		}
		
		// Preguntas de desarrollo
		for (let i = 0; i < (counts.des || 0); i++) {
			if (isMath) {
				const mathProblem = getMathProblemWithAnswer(topic, i + 1, courseLevel)
				res.push({ id: makeId('des'), type: 'des', prompt: mathProblem.prompt, sampleAnswer: mathProblem.sampleAnswer })
			} else {
				const desTemplates = [
					{
						prompt: `Explica con tus propias palabras qué es ${cleanTopic} y por qué es importante estudiarlo. Incluye al menos dos ejemplos.`,
						sampleAnswer: `RESPUESTA ESPERADA:\n• Definición clara de ${cleanTopic}\n• Importancia/relevancia del tema\n• Al menos 2 ejemplos concretos\n\nRÚBRICA DE PUNTAJE:\n• Puntaje completo (100%): Definición correcta + importancia + 2 ejemplos\n• Puntaje parcial (75%): Definición + importancia O definición + 2 ejemplos\n• Puntaje parcial (50%): Solo definición correcta O solo ejemplos\n• Puntaje mínimo (25%): Intento de respuesta con algún concepto correcto`
					},
					{
						prompt: `Describe cómo se relaciona ${cleanTopic} con situaciones de tu vida cotidiana. Fundamenta tu respuesta.`,
						sampleAnswer: `RESPUESTA ESPERADA:\n• Conexión entre ${cleanTopic} y la vida diaria\n• Al menos 2 situaciones cotidianas\n• Fundamentación/explicación de cada relación\n\nRÚBRICA DE PUNTAJE:\n• Puntaje completo (100%): 2+ situaciones bien fundamentadas\n• Puntaje parcial (75%): 2 situaciones con fundamentación básica\n• Puntaje parcial (50%): 1 situación bien explicada\n• Puntaje mínimo (25%): Intento con alguna relación identificada`
					},
					{
						prompt: `Analiza las principales características de ${cleanTopic} y explica cómo estas se aplican en la práctica.`,
						sampleAnswer: `RESPUESTA ESPERADA:\n• Al menos 3 características principales de ${cleanTopic}\n• Explicación de cada característica\n• Aplicación práctica de cada una\n\nRÚBRICA DE PUNTAJE:\n• Puntaje completo (100%): 3+ características con aplicación práctica\n• Puntaje parcial (75%): 3 características sin aplicación O 2 con aplicación\n• Puntaje parcial (50%): 2 características identificadas\n• Puntaje mínimo (25%): 1 característica correcta`
					},
					{
						prompt: `¿Qué aprendiste sobre ${cleanTopic}? Menciona al menos tres aspectos importantes y explica cada uno.`,
						sampleAnswer: `RESPUESTA ESPERADA:\n• 3 aspectos importantes de ${cleanTopic}\n• Explicación de cada aspecto\n• Demostración de comprensión del tema\n\nRÚBRICA DE PUNTAJE:\n• Puntaje completo (100%): 3 aspectos bien explicados\n• Puntaje parcial (75%): 3 aspectos con explicación básica O 2 bien explicados\n• Puntaje parcial (50%): 2 aspectos mencionados\n• Puntaje mínimo (25%): 1 aspecto correcto`
					},
					{
						prompt: `Compara ${cleanTopic} con otros temas que hayas estudiado. ¿Qué similitudes y diferencias encuentras?`,
						sampleAnswer: `RESPUESTA ESPERADA:\n• Identificación de tema(s) relacionados\n• Al menos 2 similitudes\n• Al menos 2 diferencias\n• Análisis comparativo coherente\n\nRÚBRICA DE PUNTAJE:\n• Puntaje completo (100%): 2+ similitudes y 2+ diferencias\n• Puntaje parcial (75%): 2 similitudes O 2 diferencias bien explicadas\n• Puntaje parcial (50%): 1 similitud y 1 diferencia\n• Puntaje mínimo (25%): Intento de comparación con algún elemento correcto`
					},
				]
				const template = desTemplates[i % desTemplates.length]
				res.push({ id: makeId('des'), type: 'des', prompt: template.prompt, sampleAnswer: template.sampleAnswer })
			}
		}
		return res
	}

	// Generador de problemas de matemáticas CON respuesta y rúbrica
	const getMathProblemWithAnswer = (topic: string, num: number, courseLevel: number = 3): { prompt: string; sampleAnswer: string } => {
		const topicLower = topic.toLowerCase()
		
		// Sumas y restas - ADAPTADO POR NIVEL
		if (/suma|resta|adici[oó]n|sustracci[oó]n/.test(topicLower)) {
			if (courseLevel === 1) {
				const problems = [
					{
						prompt: `Problema ${num}: Tienes 8 manzanas y tu mamá te da 5 más. ¿Cuántas manzanas tienes ahora? Dibuja las manzanas y escribe el resultado.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 8 + 5 = 13\n• Resultado: 13 manzanas\n\nRÚBRICA:\n• 100%: Operación correcta + resultado correcto + dibujo\n• 75%: Operación y resultado correctos sin dibujo\n• 50%: Operación planteada correctamente pero error en cálculo\n• 25%: Intento de suma identificado`
					},
					{
						prompt: `Problema ${num}: Había 12 pájaros en un árbol. Se fueron 4 volando. ¿Cuántos pájaros quedaron? Haz un dibujo y escribe la resta.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 12 - 4 = 8\n• Resultado: 8 pájaros\n\nRÚBRICA:\n• 100%: Resta correcta + resultado + dibujo\n• 75%: Resta y resultado correctos\n• 50%: Operación planteada bien, error en cálculo\n• 25%: Identifica que es resta`
					},
					{
						prompt: `Problema ${num}: María tiene 6 lápices rojos y 7 lápices azules. ¿Cuántos lápices tiene en total? Escribe la suma.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 6 + 7 = 13\n• Resultado: 13 lápices\n\nRÚBRICA:\n• 100%: Suma correcta + resultado\n• 75%: Operación planteada correctamente\n• 50%: Error de cálculo menor (±1)\n• 25%: Identifica que es suma`
					},
					{
						prompt: `Problema ${num}: Pedro tenía 15 caramelos. Le dio 6 a su hermana. ¿Cuántos caramelos le quedan? Escribe el cálculo.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 15 - 6 = 9\n• Resultado: 9 caramelos\n\nRÚBRICA:\n• 100%: Resta correcta + resultado\n• 75%: Operación bien planteada\n• 50%: Error de cálculo menor\n• 25%: Identifica operación`
					},
					{
						prompt: `Problema ${num}: En una caja hay 9 pelotas. Sacamos 3 pelotas. ¿Cuántas pelotas quedan en la caja?`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 9 - 3 = 6\n• Resultado: 6 pelotas\n\nRÚBRICA:\n• 100%: Resta y resultado correctos\n• 75%: Operación planteada bien\n• 50%: Error menor en cálculo\n• 25%: Intento válido`
					}
				]
				return problems[num % problems.length]
			} else if (courseLevel === 2) {
				const problems = [
					{
						prompt: `Problema ${num}: En una biblioteca hay 156 libros de cuentos y 87 libros de ciencia. ¿Cuántos libros hay en total? Muestra tu procedimiento.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 156 + 87 = 243\n• Resultado: 243 libros\n• Procedimiento: Suma con reserva\n\nRÚBRICA:\n• 100%: Resultado correcto con procedimiento\n• 75%: Resultado correcto sin procedimiento\n• 50%: Procedimiento correcto, error de cálculo\n• 25%: Identifica la operación correcta`
					},
					{
						prompt: `Problema ${num}: Juan tiene 250 figuritas. Le regala 75 a su amigo. ¿Cuántas figuritas le quedan? Desarrolla paso a paso.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 250 - 75 = 175\n• Resultado: 175 figuritas\n\nRÚBRICA:\n• 100%: Resultado correcto con desarrollo\n• 75%: Resultado correcto\n• 50%: Error de cálculo con procedimiento correcto\n• 25%: Plantea la resta correctamente`
					},
					{
						prompt: `Problema ${num}: Una tienda vendió 328 helados el lunes y 195 el martes. ¿Cuántos helados vendió en total? Muestra el cálculo.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 328 + 195 = 523\n• Resultado: 523 helados\n\nRÚBRICA:\n• 100%: Suma correcta con procedimiento\n• 75%: Resultado correcto\n• 50%: Error de cálculo menor\n• 25%: Identifica que es suma`
					},
					{
						prompt: `Problema ${num}: Había 500 personas en un estadio. Se fueron 168. ¿Cuántas personas quedaron?`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 500 - 168 = 332\n• Resultado: 332 personas\n\nRÚBRICA:\n• 100%: Resta correcta\n• 75%: Procedimiento correcto\n• 50%: Error de cálculo\n• 25%: Plantea resta`
					}
				]
				return problems[num % problems.length]
			} else {
				// Nivel 3+: Problemas más complejos
				const problems = [
					{
						prompt: `Problema ${num}: María tiene 45 manzanas. Le regala 18 a su vecino y luego compra 27 más en el mercado. ¿Cuántas manzanas tiene ahora? Muestra el procedimiento completo.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Paso 1: 45 - 18 = 27 manzanas\n• Paso 2: 27 + 27 = 54 manzanas\n• Resultado: 54 manzanas\n\nRÚBRICA:\n• 100%: Ambas operaciones correctas con procedimiento\n• 75%: Resultado correcto sin procedimiento detallado\n• 50%: Una operación correcta\n• 25%: Identifica las operaciones necesarias`
					},
					{
						prompt: `Problema ${num}: Un bus viaja con 38 pasajeros. En la primera parada bajan 12 y suben 9. En la segunda parada bajan 8 y suben 15. ¿Cuántos pasajeros hay al final? Desarrolla paso a paso.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Inicial: 38 pasajeros\n• Parada 1: 38 - 12 + 9 = 35 pasajeros\n• Parada 2: 35 - 8 + 15 = 42 pasajeros\n• Resultado: 42 pasajeros\n\nRÚBRICA:\n• 100%: Todas las operaciones correctas paso a paso\n• 75%: Resultado correcto con procedimiento básico\n• 50%: Dos paradas calculadas correctamente\n• 25%: Una parada calculada correctamente`
					},
					{
						prompt: `Problema ${num}: Pedro ahorra $125 el lunes, $89 el martes y gasta $67 el miércoles. ¿Cuánto dinero tiene? Explica tu procedimiento.`,
						sampleAnswer: `RESPUESTA CORRECTA:\n• Total ahorrado: 125 + 89 = $214\n• Después del gasto: 214 - 67 = $147\n• Resultado: $147\n\nRÚBRICA:\n• 100%: Cálculo correcto con procedimiento\n• 75%: Resultado correcto\n• 50%: Suma correcta pero error en resta\n• 25%: Identifica las operaciones`
					}
				]
				return problems[num % problems.length]
			}
		}
		
		// Multiplicación
		if (/multiplic|producto|veces/.test(topicLower)) {
			const problems = [
				{
					prompt: `Problema ${num}: Una caja contiene 24 lápices. Si hay 15 cajas, ¿cuántos lápices hay en total? Muestra tu procedimiento.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 24 × 15 = 360\n• Resultado: 360 lápices\n\nRÚBRICA:\n• 100%: Multiplicación correcta con procedimiento\n• 75%: Resultado correcto\n• 50%: Error de cálculo con procedimiento válido\n• 25%: Identifica que es multiplicación`
				},
				{
					prompt: `Problema ${num}: Un teatro tiene 28 filas con 32 asientos cada una. ¿Cuál es la capacidad total del teatro? Desarrolla el cálculo.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 28 × 32 = 896\n• Resultado: 896 asientos\n\nRÚBRICA:\n• 100%: Multiplicación correcta + desarrollo\n• 75%: Resultado correcto\n• 50%: Procedimiento correcto, error de cálculo\n• 25%: Plantea multiplicación`
				},
				{
					prompt: `Problema ${num}: Si un libro cuesta $45 y se compran 7 libros, ¿cuánto se paga en total? Explica paso a paso.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 45 × 7 = 315\n• Resultado: $315\n\nRÚBRICA:\n• 100%: Resultado correcto con explicación\n• 75%: Resultado correcto\n• 50%: Error menor en cálculo\n• 25%: Identifica operación`
				}
			]
			return problems[num % problems.length]
		}
		
		// División
		if (/divisi[oó]n|dividir|cociente|reparto/.test(topicLower)) {
			const problems = [
				{
					prompt: `Problema ${num}: Se tienen 156 chocolates para repartir entre 12 niños en partes iguales. ¿Cuántos chocolates recibe cada niño? ¿Sobran chocolates? Muestra el procedimiento.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 156 ÷ 12 = 13\n• Resultado: 13 chocolates cada uno, sobran 0\n\nRÚBRICA:\n• 100%: División correcta + residuo identificado\n• 75%: Cociente correcto\n• 50%: Procedimiento correcto, error en cálculo\n• 25%: Plantea división correctamente`
				},
				{
					prompt: `Problema ${num}: Un granjero tiene 245 huevos y quiere ponerlos en cajas de 30. ¿Cuántas cajas puede llenar completamente? ¿Cuántos huevos quedan? Desarrolla.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 245 ÷ 30 = 8 resto 5\n• Resultado: 8 cajas completas, quedan 5 huevos\n\nRÚBRICA:\n• 100%: Cociente y residuo correctos\n• 75%: Cociente correcto\n• 50%: Procedimiento correcto\n• 25%: Plantea división`
				},
				{
					prompt: `Problema ${num}: Si un viaje de 728 km se divide en 4 días iguales, ¿cuántos km se recorren cada día? Explica tu cálculo.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 728 ÷ 4 = 182\n• Resultado: 182 km por día\n\nRÚBRICA:\n• 100%: División correcta con explicación\n• 75%: Resultado correcto\n• 50%: Error de cálculo menor\n• 25%: Identifica operación`
				}
			]
			return problems[num % problems.length]
		}
		
		// Fracciones
		if (/fracci[oó]n|numerador|denominador|quebrado/.test(topicLower)) {
			const problems = [
				{
					prompt: `Problema ${num}: Juan comió 2/5 de una pizza y María comió 1/4 de la misma pizza. ¿Qué fracción de la pizza comieron entre los dos? Muestra el procedimiento completo.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 2/5 + 1/4 = 8/20 + 5/20 = 13/20\n• Resultado: 13/20 de la pizza\n• MCM de 5 y 4 = 20\n\nRÚBRICA:\n• 100%: Suma correcta con denominador común\n• 75%: Encuentra MCM correctamente\n• 50%: Suma fracciones incorrectamente pero identifica el proceso\n• 25%: Intenta sumar fracciones`
				},
				{
					prompt: `Problema ${num}: Una receta necesita 3/4 de taza de azúcar. Si quiero hacer la mitad de la receta, ¿cuánta azúcar necesito? Desarrolla paso a paso.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 3/4 ÷ 2 = 3/4 × 1/2 = 3/8\n• Resultado: 3/8 de taza\n\nRÚBRICA:\n• 100%: División/multiplicación correcta\n• 75%: Plantea la operación correcta\n• 50%: Intenta dividir la fracción\n• 25%: Identifica que debe dividir`
				},
				{
					prompt: `Problema ${num}: De un pastel, Ana come 1/3, Luis come 1/6 y queda el resto. ¿Qué fracción del pastel quedó? Explica.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 1 - (1/3 + 1/6) = 1 - (2/6 + 1/6) = 1 - 3/6 = 1/2\n• Resultado: 1/2 del pastel\n\nRÚBRICA:\n• 100%: Resultado correcto con procedimiento\n• 75%: Suma las fracciones correctamente\n• 50%: Encuentra MCM pero error en resta\n• 25%: Identifica que debe restar de 1`
				}
			]
			return problems[num % problems.length]
		}
		
		// Porcentajes
		if (/porcentaje|%|descuento|aumento/.test(topicLower)) {
			const problems = [
				{
					prompt: `Problema ${num}: Una tienda ofrece 25% de descuento en un producto que cuesta $120. ¿Cuál es el precio final? Muestra todos los cálculos.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Descuento: 120 × 0.25 = $30\n• Precio final: 120 - 30 = $90\n• Resultado: $90\n\nRÚBRICA:\n• 100%: Cálculo del descuento y precio final correctos\n• 75%: Descuento calculado correctamente\n• 50%: Procedimiento correcto con error de cálculo\n• 25%: Identifica que debe calcular porcentaje`
				},
				{
					prompt: `Problema ${num}: Si el precio de un artículo aumentó de $80 a $100, ¿cuál fue el porcentaje de aumento? Desarrolla el procedimiento.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Aumento: 100 - 80 = $20\n• Porcentaje: (20/80) × 100 = 25%\n• Resultado: 25% de aumento\n\nRÚBRICA:\n• 100%: Porcentaje correcto con procedimiento\n• 75%: Calcula el aumento correctamente\n• 50%: Procedimiento correcto con error\n• 25%: Identifica la diferencia de precios`
				},
				{
					prompt: `Problema ${num}: En una clase de 40 estudiantes, el 35% son mujeres. ¿Cuántas mujeres hay en la clase? Explica paso a paso.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Operación: 40 × 0.35 = 14\n• Resultado: 14 mujeres\n\nRÚBRICA:\n• 100%: Cálculo correcto con explicación\n• 75%: Resultado correcto\n• 50%: Error menor en cálculo\n• 25%: Plantea la operación correctamente`
				}
			]
			return problems[num % problems.length]
		}
		
		// Ecuaciones
		if (/ecuaci[oó]n|inc[oó]gnita|variable|despej/.test(topicLower)) {
			const problems = [
				{
					prompt: `Problema ${num}: Si el triple de un número más 7 es igual a 25, ¿cuál es el número? Plantea la ecuación y resuélvela paso a paso.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Ecuación: 3x + 7 = 25\n• Despeje: 3x = 25 - 7 = 18\n• Resultado: x = 18/3 = 6\n\nRÚBRICA:\n• 100%: Ecuación planteada y resuelta correctamente\n• 75%: Ecuación correcta, error en despeje\n• 50%: Plantea la ecuación correctamente\n• 25%: Identifica que es una ecuación`
				},
				{
					prompt: `Problema ${num}: La edad de Pedro es el doble de la edad de Juan más 5 años. Si Pedro tiene 35 años, ¿cuántos años tiene Juan? Desarrolla.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Ecuación: 2J + 5 = 35\n• Despeje: 2J = 30\n• Resultado: J = 15 años\n\nRÚBRICA:\n• 100%: Planteamiento y solución correctos\n• 75%: Ecuación bien planteada\n• 50%: Error en despeje con ecuación correcta\n• 25%: Identifica la relación entre edades`
				},
				{
					prompt: `Problema ${num}: Resuelve: 3x + 12 = 5x - 8. Muestra cada paso de la solución.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Paso 1: 12 + 8 = 5x - 3x\n• Paso 2: 20 = 2x\n• Resultado: x = 10\n\nRÚBRICA:\n• 100%: Solución correcta con todos los pasos\n• 75%: Despeje correcto con error de cálculo\n• 50%: Agrupa términos correctamente\n• 25%: Intenta despejar variables`
				}
			]
			return problems[num % problems.length]
		}
		
		// Geometría
		if (/geometr|[aá]rea|per[ií]metro|tri[aá]ngulo|rect[aá]ngulo|c[ií]rculo|cuadrado/.test(topicLower)) {
			const problems = [
				{
					prompt: `Problema ${num}: Un terreno rectangular mide 45 metros de largo y 28 metros de ancho. Calcula su perímetro y su área. Muestra el procedimiento.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Perímetro: 2(45 + 28) = 2(73) = 146 m\n• Área: 45 × 28 = 1260 m²\n\nRÚBRICA:\n• 100%: Perímetro y área correctos\n• 75%: Una de las dos medidas correcta\n• 50%: Fórmulas correctas con error de cálculo\n• 25%: Identifica las fórmulas a usar`
				},
				{
					prompt: `Problema ${num}: Un triángulo tiene base de 12 cm y altura de 8 cm. ¿Cuál es su área? Explica la fórmula utilizada.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Fórmula: A = (base × altura) / 2\n• Cálculo: (12 × 8) / 2 = 96/2 = 48\n• Resultado: 48 cm²\n\nRÚBRICA:\n• 100%: Fórmula y cálculo correctos\n• 75%: Fórmula correcta con error menor\n• 50%: Identifica la fórmula del triángulo\n• 25%: Intenta calcular área`
				},
				{
					prompt: `Problema ${num}: Un círculo tiene radio de 7 cm. Calcula su circunferencia y su área (usa π = 3.14). Desarrolla paso a paso.`,
					sampleAnswer: `RESPUESTA CORRECTA:\n• Circunferencia: 2πr = 2 × 3.14 × 7 = 43.96 cm\n• Área: πr² = 3.14 × 49 = 153.86 cm²\n\nRÚBRICA:\n• 100%: Circunferencia y área correctas\n• 75%: Una medida correcta\n• 50%: Fórmulas correctas con error de cálculo\n• 25%: Identifica las fórmulas del círculo`
				}
			]
			return problems[num % problems.length]
		}
		
		// Genérico
		return {
			prompt: `Problema ${num} - ${topic}: Plantea un problema práctico relacionado con el tema, identifica los datos, resuelve paso a paso y verifica tu respuesta.`,
			sampleAnswer: `RESPUESTA ESPERADA:\n• Identificación de datos del problema\n• Planteamiento de la operación\n• Desarrollo paso a paso\n• Resultado final verificado\n\nRÚBRICA:\n• 100%: Todos los pasos correctos\n• 75%: Procedimiento correcto con pequeño error\n• 50%: Planteamiento correcto\n• 25%: Identifica datos del problema`
		}
	}

	// Crear prueba: guarda item en estado "generating" y dispara SSE; fallback a generador local.
	const handleCreate = () => {
		if (!user) { alert('Usuario no autenticado'); return }
		if (!builder?.courseId || !builder?.sectionId || !builder?.subjectId) { alert(translate('testsSelectAllBeforeCreate')); return }
		const now = Date.now()
		const title = (builder?.topic?.trim() || 'Prueba') as string
		// Resolver nombre de asignatura
		const subjName = (() => {
			try {
				const list = Array.isArray(subjects) ? subjects : JSON.parse(localStorage.getItem('smart-student-subjects') || '[]')
				let found = list.find((x: any) => String(x?.id) === String(builder?.subjectId))
				if (found?.name) return found.name
				found = list.find((x: any) => String(x?.name) === String(builder?.subjectId))
				return found?.name || (builder?.subjectName || String(builder?.subjectId))
			} catch { return builder?.subjectName || String(builder?.subjectId) }
		})()
		
		// Resolver nombre del curso para adaptar nivel de ejercicios
		const courseName = (() => {
			try {
				// Buscar en courses y sections
				const courseList = Array.isArray(courses) ? courses : JSON.parse(localStorage.getItem('smart-student-courses') || '[]')
				const sectionList = Array.isArray(sections) ? sections : JSON.parse(localStorage.getItem('smart-student-sections') || '[]')
				
				// Buscar sección seleccionada
				const section = sectionList.find((s: any) => String(s?.id) === String(builder?.sectionId))
				if (section) {
					// Buscar curso de la sección
					const course = courseList.find((c: any) => String(c?.id) === String(section?.courseId || builder?.courseId))
					if (course?.name && section?.name) {
						return `${course.name} ${section.name}`
					}
					if (section?.name) return section.name
				}
				
				// Fallback: buscar curso directamente
				const course = courseList.find((c: any) => String(c?.id) === String(builder?.courseId))
				return course?.name || ''
			} catch { return '' }
		})()
		
		console.log('[Pruebas] Curso detectado:', courseName)
		
		const item: TestItem = {
			id: `test_${now}`,
			title,
			description: '',
			createdAt: now,
			courseId: builder.courseId,
			sectionId: builder.sectionId,
			subjectId: builder.subjectId,
			subjectName: subjName,
			topic: builder.topic,
			counts: builder.counts,
			weights: builder.weights,
			totalPoints: builder.totalPoints,
			total: builder.total,
			questions: [],
			status: 'generating',
			progress: 0,
			ownerId: (user as any).id,
			ownerUsername: (user as any).username,
		}
		saveTests([item, ...tests])

		try {
			const id = item.id
			const countTF = Number(builder?.counts?.tf || 0)
			const countMC = Number(builder?.counts?.mc || 0)
			const countMS = Number(builder?.counts?.ms || 0)
			const countDES = Number(builder?.counts?.des || 0)
			const questionCount = Math.max(1, countTF + countMC + countMS)
			const bookTitle = subjName || 'General'
			const topic = String(builder?.topic || title)
			
			// 🔢 DETECTAR SI ES MATEMÁTICAS/FÍSICA PARA USAR GENERADOR LOCAL
			// La IA no genera buenos ejercicios matemáticos, así que usamos el generador local
			const detectionText = (topic + ' ' + bookTitle).toLowerCase()
			const isMathSubject = /matem[aá]tica|math|algebra|geometr[ií]a|aritm[eé]tica|c[aá]lculo|ecuacion|fracci[oó]n|porcentaje|trigonometr|sumas?|restas?|multiplic|divisi|n[uú]mero|f[ií]sica|physics/i.test(detectionText)
			
			console.log('[Pruebas] Detección de materia:', { topic, bookTitle, isMathSubject })
			
			// Si es matemáticas/física, usar generador local directamente (tiene mejores ejercicios)
			if (isMathSubject) {
				console.log('[Pruebas] 🔢 Usando generador local para matemáticas/física')
				const localQuestions = generateLocalQuestions(topic, builder?.counts, subjName, courseName)
				patchTest(id, { questions: localQuestions, status: 'ready', progress: 100 })
				return
			}
			
			// Para otras materias, usar la IA
			// Pasar cantidades específicas por tipo a la API
			const params = new URLSearchParams({ 
				topic, 
				bookTitle, 
				language: language === 'en' ? 'en' : 'es', 
				questionCount: String(questionCount), 
				timeLimit: '120',
				tfCount: String(countTF),
				mcCount: String(countMC),
				msCount: String(countMS),
				desCount: String(countDES)
			})
			const es = new EventSource(`/api/tests/generate/stream?${params.toString()}`)
			es.addEventListener('progress', (evt: MessageEvent) => {
				try { const data = JSON.parse((evt as any).data); const p = Math.min(100, Number(data?.percent ?? 0)); patchTest(id, { progress: p }) } catch {}
			})
			es.addEventListener('done', (evt: MessageEvent) => {
				try {
					const payload = JSON.parse((evt as any).data)
					const aiOut = payload?.data
					
					// Mapear todas las preguntas de la IA
					const allMapped: any[] = (aiOut?.questions || []).map((q: any, idx: number) => {
						const makeId = (p: string) => `${p}_${now}_${idx}`
						if (q.type === 'TRUE_FALSE') return { id: makeId('tf'), type: 'tf', text: q.questionText || q.text || '', answer: !!q.correctAnswer }
						if (q.type === 'MULTIPLE_CHOICE') {
							const options: string[] = q.options || q.choices || []
							const correctIndex = typeof q.correctAnswerIndex === 'number' ? q.correctAnswerIndex : 0
							return { id: makeId('mc'), type: 'mc', text: q.questionText || q.text || '', options, correctIndex }
						}
						if (q.type === 'MULTIPLE_SELECTION') {
							const options: string[] = q.options || []
							const corrects: number[] = Array.isArray(q.correctAnswerIndices) ? q.correctAnswerIndices : []
							return { id: makeId('ms'), type: 'ms', text: q.questionText || q.text || '', options: options.map((t, i) => ({ text: String(t), correct: corrects.includes(i) })) }
						}
						return { id: makeId('des'), type: 'des', prompt: q.questionText || q.text || '' }
					})
					
					// Filtrar por tipo y limitar a las cantidades solicitadas
					const tfQuestions = allMapped.filter(q => q.type === 'tf').slice(0, countTF)
					const mcQuestions = allMapped.filter(q => q.type === 'mc').slice(0, countMC)
					const msQuestions = allMapped.filter(q => q.type === 'ms').slice(0, countMS)
					
					// Combinar las preguntas respetando las cantidades
					const mapped: any[] = [...tfQuestions, ...mcQuestions, ...msQuestions]
					
					// Si faltan preguntas de algún tipo, completar con el generador local
					const missingTF = countTF - tfQuestions.length
					const missingMC = countMC - mcQuestions.length
					const missingMS = countMS - msQuestions.length
					
					if (missingTF > 0 || missingMC > 0 || missingMS > 0) {
						console.log('[Pruebas] Completando preguntas faltantes:', { missingTF, missingMC, missingMS })
						const extras = generateLocalQuestions(topic, { tf: missingTF, mc: missingMC, ms: missingMS, des: 0 }, subjName, courseName)
						mapped.push(...extras)
					}
					
					const desCount = Number(builder?.counts?.des || 0)
					if (desCount > 0) {
						mapped.push(...generateLocalQuestions(topic, { tf: 0, mc: 0, ms: 0, des: desCount }, subjName, courseName))
					}
					patchTest(id, { questions: mapped, status: 'ready', progress: 100 })
				} finally { es.close() }
			})
			es.addEventListener('error', () => {
				es.close()
				const fallback = generateLocalQuestions(builder?.topic || title, builder?.counts, subjName, courseName)
				patchTest(item.id, { questions: fallback, status: 'ready', progress: 100 })
			})
		} catch (e) {
			console.error('[Pruebas] SSE error, usando generador local:', e)
			const fallback = generateLocalQuestions(builder?.topic || 'Tema', builder?.counts, builder?.subjectName, courseName)
			patchTest(item.id, { questions: fallback, status: 'ready', progress: 100 })
		}
	}

	// Handler para pruebas creadas manualmente
	const handleManualTestCreated = (test: TestItem) => {
		saveTests([test, ...tests])
	}

	return (
		<div className="p-6 space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold flex items-center gap-2">
						<span className="inline-flex items-center justify-center rounded-md border border-fuchsia-200 bg-fuchsia-100 text-fuchsia-800 dark:border-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-200 p-1">
							<ClipboardCheck className="size-5" />
						</span>
						<span>{translate('testsPageTitle')}</span>
					</h1>
					<p className="text-sm text-muted-foreground">{translate('testsPageSub')}</p>
				</div>
			</div>

			<div className="space-y-4">
				<div className="border rounded-lg p-4">
					{/* Tabs de modo Automático/Manual */}
					<div className="flex gap-2 mb-4">
						<button
							type="button"
							onClick={() => setCreationMode('automatic')}
							className={cn(
								"flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
								creationMode === 'automatic'
									? "bg-fuchsia-600 text-white shadow-md"
									: "bg-muted text-muted-foreground hover:bg-muted/80"
							)}
						>
							<Wand2 className="w-4 h-4" />
							{translate('testsModeAutomatic')}
						</button>
						<button
							type="button"
							onClick={() => setCreationMode('manual')}
							className={cn(
								"flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
								creationMode === 'manual'
									? "bg-fuchsia-600 text-white shadow-md"
									: "bg-muted text-muted-foreground hover:bg-muted/80"
							)}
						>
							<Upload className="w-4 h-4" />
							{translate('testsModeManual')}
						</button>
					</div>
					
					{/* Descripción del modo */}
					<div className="mb-4 text-xs text-muted-foreground bg-muted/30 rounded p-2">
						{creationMode === 'automatic' 
							? translate('testsModeAutomaticDesc')
							: translate('testsModeManualDesc')
						}
					</div>

					{/* Contenido según modo */}
					{creationMode === 'automatic' ? (
						<>
							<div className="mb-3 text-sm font-medium">{translate('testsCreateTitle')}</div>
							<div className="mb-2 text-xs text-muted-foreground">{translate('testsCreateHint')}</div>
							<TestBuilder value={builder} onChange={setBuilder} onCreate={handleCreate} />
						</>
					) : (
						<>
							<div className="mb-3 text-sm font-medium">{translate('testsManualUploadTitle')}</div>
							<div className="mb-2 text-xs text-muted-foreground">{translate('testsManualUploadHint')}</div>
							<ManualTestBuilder onTestCreated={handleManualTestCreated} />
						</>
					)}
				</div>
			</div>

			<div className="border rounded-lg">
				<div className="px-4 py-3">
					<div className="text-sm font-medium">{translate('testsHistoryTitle')}</div>
				</div>
				<div className="divide-y">
					{tests.length === 0 ? (
						<div className="p-8 text-center text-muted-foreground">{translate('testsHistoryEmpty')}</div>
					) : (
							tests.map((t) => (
							<div key={t.id} className="p-4 flex items-center justify-between gap-4">
								<div className="min-w-0">
										<p className="font-medium truncate">{t.title}</p>
										{/* Curso (Curso + Sección) */}
										<p className="text-xs text-muted-foreground truncate">
											{(() => {
												const sec = sections.find((s:any) => String(s.id) === String(t.sectionId))
												const course = courses.find((c:any) => String(c.id) === String(t.courseId || sec?.courseId))
												const courseLabel = course?.name ? String(course.name) : ''
												const sectionLabel = sec?.name ? String(sec.name) : ''
												const label = [courseLabel, sectionLabel].filter(Boolean).join(' ')
												return label ? `Curso: ${label}` : ''
											})()}
										</p>
										{/* Asignatura */}
										<p className="text-xs text-muted-foreground truncate">
											{(() => {
												const subj = subjects.find((s:any) => String(s.id) === String(t.subjectId)) || subjects.find((s:any) => String(s.name) === String(t.subjectId))
												const name = subj?.name || t.subjectName || (t.subjectId ? String(t.subjectId) : '')
												return name ? `Asignatura: ${name}` : ''
											})()}
										</p>
										{/* Distribución de puntaje por tipo */}
										{(() => {
											const w = t.weights || { tf: 25, mc: 25, ms: 25, des: (t.counts?.des ?? 0) > 0 ? 25 : 0 }
											const parts = [
												`TF ${Number(w.tf ?? 0)}%`,
												`MC ${Number(w.mc ?? 0)}%`,
												`MS ${Number(w.ms ?? 0)}%`,
												`DES ${Number(w.des ?? 0)}%`,
											]
											return (
												<p className="text-xs text-muted-foreground truncate">{`Distribución: ${parts.join(' · ')}`}</p>
											)
										})()}

										{/* Totales */}
										<p className="text-xs text-muted-foreground truncate">
											{`Total de preguntas: ${t.questions?.length ?? ((t.counts?.tf||0)+(t.counts?.mc||0)+(t.counts?.ms||0)+(t.counts?.des||0))}`}
										</p>
										{typeof t.totalPoints === 'number' && (
											<p className="text-xs text-muted-foreground truncate">{`Puntaje total: ${t.totalPoints} pts`}</p>
										)}
								</div>
								<div className="flex items-center gap-2">
									{t.status === 'generating' ? (
										<div className="flex items-center gap-2 mr-1 min-w-[100px]">
											<div className="w-24 h-2 bg-gray-200 dark:bg-gray-700 rounded" aria-label={`${Math.min(100, t.progress || 0)}%`}>
												<div className="h-2 bg-fuchsia-600 rounded" style={{ width: `${Math.min(100, t.progress || 0)}%` }} />
											</div>
											<span className="text-xs text-muted-foreground w-8 text-right">{Math.min(100, t.progress || 0)}%</span>
										</div>
									) : (
										<span className="inline-flex items-center text-green-600 dark:text-green-400 mr-1" title={translate('testsReady')} aria-label={translate('testsReady')}>
											<CheckCircle className="size-4" />
										</span>
									)}

									<Button 
										variant="outline" 
										onClick={() => handleOpenView(t)} 
										disabled={t.status === 'generating'}
										className={`p-2 text-fuchsia-800 border-fuchsia-200 hover:bg-fuchsia-600 hover:text-white dark:border-fuchsia-800 ${t.status === 'generating' ? 'opacity-50 cursor-not-allowed' : ''}`} 
										aria-label={translate('testsBtnView')} 
										title={t.status === 'generating' ? 'Generando prueba...' : translate('testsBtnView')}
									>
										<Eye className="size-4" />
									</Button>
									<Button 
										variant="outline" 
										onClick={() => handleOpenReview(t)} 
										disabled={t.status === 'generating'}
										className={`p-2 text-fuchsia-800 border-fuchsia-200 hover:bg-fuchsia-600 hover:text-white dark:border-fuchsia-800 ${t.status === 'generating' ? 'opacity-50 cursor-not-allowed' : ''}`} 
										aria-label={translate('testsReviewBtn')} 
										title={t.status === 'generating' ? 'Generando prueba...' : translate('testsReviewBtn')}
									>
										<FileSearch className="size-4" />
									</Button>
									<Button variant="outline" onClick={() => { setDeleteTarget(t); setDeleteOpen(true) }} className="p-2 text-fuchsia-800 border-fuchsia-200 hover:bg-fuchsia-600 hover:text-white dark:border-fuchsia-800" aria-label={translate('testsBtnDelete')} title={translate('testsBtnDelete')}>
										<Trash2 className="size-4" />
									</Button>
								</div>
							</div>
						))
					)}
				</div>
			</div>

			{/* Modales */}
			<TestViewDialog open={openView} onOpenChange={setOpenView} test={selectedTest} onReview={() => handleOpenReview()} />
			<TestReviewDialog open={openReview} onOpenChange={setOpenReview} test={selectedTest} />

			{/* Popup de confirmación de borrado */}
			<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{language === 'en' ? 'Delete test?' : '¿Eliminar prueba?'}</AlertDialogTitle>
						<AlertDialogDescription>
							{language === 'en' ? 'This action will remove the test, its review history and associated grades. You can’t undo this.' : 'Esta acción eliminará la prueba, su historial de revisión y las notas asociadas. No se puede deshacer.'}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							className="border-fuchsia-200 text-fuchsia-800 hover:bg-fuchsia-600 hover:text-white dark:border-fuchsia-800 focus-visible:ring-fuchsia-500"
						>
							{language === 'en' ? 'Cancel' : 'Cancelar'}
						</AlertDialogCancel>
						<AlertDialogAction
							className="bg-fuchsia-600 hover:bg-fuchsia-700 text-white focus-visible:ring-fuchsia-500"
							onClick={() => {
							if (!deleteTarget) return
							// Ejecutar borrado definitivo
							saveTests(tests.filter(x => x.id !== deleteTarget.id))
							try {
								const rkey = getReviewKey(deleteTarget.id)
								localStorage.setItem(rkey, '[]')
								window.dispatchEvent(new StorageEvent('storage', { key: rkey, newValue: '[]' }))
							} catch {}
							try {
								const { LocalStorageManager } = require('@/lib/education-utils')
								const saved = Number(localStorage.getItem('admin-selected-year') || '')
								const year = Number.isFinite(saved) && saved > 0 ? saved : new Date().getFullYear()
								const key = LocalStorageManager.keyForTestGrades(year)
								const raw = localStorage.getItem(key) || localStorage.getItem('smart-student-test-grades')
								if (raw) {
									const arr = JSON.parse(raw)
									const filtered = Array.isArray(arr) ? arr.filter((g: any) => g?.testId !== deleteTarget.id) : []
									LocalStorageManager.setTestGradesForYear(year, filtered, { preferSession: true })
									window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(filtered) }))
								}
							} catch {}
							setDeleteOpen(false)
							setDeleteTarget(null)
						}}>
							{language === 'en' ? 'Delete' : 'Eliminar'}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}


