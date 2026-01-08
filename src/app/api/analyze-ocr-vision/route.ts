import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

type InputImage = { pageNum?: number; dataUrl: string }

function safeJsonParse(text: string): any {
  const clean = String(text)
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()

  try {
    return JSON.parse(clean)
  } catch {}

  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(clean.slice(start, end + 1))
  }
  throw new Error('No se pudo parsear JSON desde la respuesta del modelo')
}

function getApiKey() {
  return (
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY
  )
}

function stripDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (m) return { mimeType: m[1], base64: m[2] }
  // fallback: asumir PNG
  return { mimeType: 'image/png', base64: dataUrl }
}

export async function POST(request: NextRequest) {
  try {
    const { images, questionsCount, title, topic, subjectName } = (await request.json()) as {
      images: InputImage[]
      questionsCount?: number
      title?: string
      topic?: string
      subjectName?: string
    }

    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ success: false, error: 'Se requieren imágenes' }, { status: 400 })
    }

    const apiKey = getApiKey()
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'API key no configurada', fallback: true }, { status: 200 })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' })

    const qCount = typeof questionsCount === 'number' && questionsCount > 0 ? questionsCount : 0
    const contextLine = [title, subjectName, topic].filter(Boolean).join(' | ')

    const prompt = `ROL: Auditor Forense de Exámenes Escolares (Visión Artificial OMR).

CONTEXTO DE LA PRUEBA: ${contextLine || 'N/D'}
PREGUNTAS ESPERADAS: ${qCount || 'Se detectará automáticamente'}

## TAREA PRINCIPAL:
Analiza VISUALMENTE cada página para detectar TODAS las preguntas visibles.
⚠️ CRÍTICO: DEBES REPORTAR CADA PREGUNTA INDIVIDUALMENTE, del 1 al ${qCount > 0 ? qCount : 'último número visible'}.
NO AGRUPES, NO OMITAS, NO SALTES ninguna pregunta.

## 📋 TIPOS DE PREGUNTAS A DETECTAR:

### TIPO 1: VERDADERO/FALSO (V/F)
Formato típico: "V ( ) F ( )" o "Verdadero ( ) Falso ( )"
- Si ves marca en V → detected = "V", questionType = "tf"
- Si ves marca en F → detected = "F", questionType = "tf"

### TIPO 2: ALTERNATIVAS / OPCIÓN MÚLTIPLE (A, B, C, D)
Formato típico: "a) ( ) b) ( ) c) ( ) d) ( )" o "A. B. C. D."
- Si ves marca en A → detected = "A", questionType = "mc"
- Si ves marca en B → detected = "B", questionType = "mc"
- Si ves marca en C → detected = "C", questionType = "mc"
- Si ves marca en D → detected = "D", questionType = "mc"
- También puede haber E, F si hay más opciones

### TIPO 3: SELECCIÓN MÚLTIPLE (varias correctas)
Formato típico: Igual que alternativas pero puede tener MÚLTIPLES marcas válidas
- Si ves marcas en A y C → detected = "A,C", questionType = "ms"
- Si ves marcas en B, C y D → detected = "B,C,D", questionType = "ms"

## 📋 PROTOCOLO DE DETECCIÓN SECUENCIAL:

### PASO 1: ESCANEO VISUAL COMPLETO
- Localiza TODAS las preguntas numeradas en el documento
- Identifica el TIPO de cada pregunta (V/F, alternativas, selección múltiple)
- Cuenta cuántas preguntas hay en total

### PASO 2: ANÁLISIS PREGUNTA POR PREGUNTA
Para CADA pregunta del 1 al último número:

**Si es V/F:**
a) Localiza los paréntesis de V ( ) y F ( )
b) ¿Hay marca en V? → detected = "V"
c) ¿Hay marca en F? → detected = "F"
d) ¿Ambos vacíos? → detected = null

**Si es ALTERNATIVAS (A,B,C,D):**
a) Localiza las opciones a) b) c) d) o A. B. C. D.
b) ¿Cuál tiene la marca (X, círculo, check)? → detected = "A", "B", "C" o "D"
c) ¿Ninguna marcada? → detected = null
d) ¿Más de una marcada? → detected = null (invalidado) para opción múltiple simple

**Si es SELECCIÓN MÚLTIPLE:**
a) Localiza todas las opciones
b) ¿Cuáles tienen marca? → detected = "A,C" (separadas por coma, en orden alfabético)
c) ¿Ninguna marcada? → detected = null

### PASO 3: CLASIFICACIÓN DE MARCAS:
- "STRONG_X": Una X clara y fuerte → VÁLIDA
- "CHECK": Un check/palomita ✓ → VÁLIDA  
- "CIRCLE": Círculo alrededor de la opción → VÁLIDA
- "FILL": Opción rellenada/sombreada → VÁLIDA
- "EMPTY": Sin marca → detected = null
- "WEAK_MARK": Garabato dudoso → detected = null

### DETECCIÓN DE ESTUDIANTE:
- Busca "Nombre:", "Estudiante:" en el encabezado
- Busca "RUT:" seguido de números

## FORMATO DE RESPUESTA (JSON PURO):

{
  "questionsFoundInDocument": número_total_de_preguntas_detectadas,
  "pages": [
    {
      "pageIndex": 0,
      "pageNum": 1,
      "student": {
        "name": "Nombre del estudiante o null",
        "rut": "RUT o null"
      },
      "answers": [
        {"questionNum": 1, "questionType": "tf", "evidence": "STRONG_X en V", "detected": "V", "points": 5},
        {"questionNum": 2, "questionType": "tf", "evidence": "STRONG_X en F", "detected": "F", "points": 5},
        {"questionNum": 3, "questionType": "mc", "evidence": "CIRCLE en opción B", "detected": "B", "points": 5},
        {"questionNum": 4, "questionType": "mc", "evidence": "STRONG_X en opción A", "detected": "A", "points": 5},
        {"questionNum": 5, "questionType": "ms", "evidence": "STRONG_X en A y C", "detected": "A,C", "points": 5},
        {"questionNum": 6, "questionType": "mc", "evidence": "EMPTY - sin marca", "detected": null, "points": null}
      ]
    }
  ]
}

## ⚠️ CHECKLIST FINAL ANTES DE RESPONDER:
1. ¿Incluí TODAS las preguntas del 1 al último número? ✓
2. ¿Identifiqué correctamente el TIPO de cada pregunta (tf/mc/ms)? ✓
3. ¿Las alternativas están en MAYÚSCULA (A, B, C, D)? ✓
4. ¿Las selecciones múltiples están separadas por coma (A,C,D)? ✓
5. ¿Las preguntas sin marca tienen detected = null? ✓
6. ¿El JSON es válido, sin texto adicional? ✓

Devuelve SOLO JSON válido, sin markdown ni explicaciones.
`

    const parts: any[] = [{ text: prompt }]
    for (const img of images) {
      const { mimeType, base64 } = stripDataUrl(img.dataUrl)
      parts.push({
        inlineData: {
          mimeType,
          data: base64,
        },
      })
    }

    const result = await model.generateContent(parts)
    const response = await result.response
    const text = response.text()

    try {
      const analysis = safeJsonParse(text)
      return NextResponse.json({ success: true, analysis, rawResponse: text })
    } catch (parseError) {
      console.error('Error parseando respuesta de Gemini (visión):', parseError)
      return NextResponse.json({ success: false, error: 'Error parseando respuesta de IA', rawResponse: text }, { status: 200 })
    }
  } catch (error: any) {
    console.error('Error en análisis OCR visión:', error)
    return NextResponse.json(
      { success: false, error: error?.message || 'Error al analizar OCR', fallback: true },
      { status: 500 }
    )
  }
}
