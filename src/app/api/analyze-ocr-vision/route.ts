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

🔴 MUY IMPORTANTE: Si ves "4. Problema 1:" o similar, eso es la PREGUNTA 4 de tipo DESARROLLO.
Las preguntas que dicen "Problema", "Ejercicio", "Resuelve" son de tipo DESARROLLO (des).

## 📋 TIPOS DE PREGUNTAS A DETECTAR:

### TIPO 1: VERDADERO/FALSO (V/F)
Formato típico: "V ( ) F ( )" o "Verdadero ( ) Falso ( )"
- Si ves marca en V → detected = "V", questionType = "tf"
- Si ves marca en F → detected = "F", questionType = "tf"

### TIPO 2: ALTERNATIVAS / OPCIÓN MÚLTIPLE (A, B, C, D)
FORMATOS COMUNES (todos válidos):
- Formato 1: "a) ( ) b) ( ) c) ( ) d) ( )" con paréntesis después
- Formato 2: "A. B. C. D." con punto después
- Formato 3: "(A) (B) (C) (D)" con paréntesis ALREDEDOR de la letra ← COMÚN EN CHILE
- Formato 4: "( ) A  ( ) B  ( ) C  ( ) D" con paréntesis antes

🔴 MÉTODO OBLIGATORIO - CUENTA LAS LÍNEAS:
1. Las opciones SIEMPRE van en orden: A es la PRIMERA línea, B es la SEGUNDA, C es la TERCERA, D es la CUARTA
2. NO te confundas por el símbolo al inicio - mira el CONTENIDO de cada opción
3. Busca la MARCA (X, ✓, círculo, relleno) - puede estar DENTRO del paréntesis
4. Identifica en QUÉ LÍNEA (1ª, 2ª, 3ª, 4ª) está la marca
5. Esa línea te dice la letra: 1ª=A, 2ª=B, 3ª=C, 4ª=D

🔴 EJEMPLO CONCRETO:
Si ves esto:
  (A) Confiar en el primer resultado      ← Línea 1 = opción A
  (⊗) Realizar la operación inversa       ← Línea 2 = opción B (TIENE LA X)
  (C) No verificar                         ← Línea 3 = opción C  
  (D) Preguntar a un compañero            ← Línea 4 = opción D
→ La marca X está en la LÍNEA 2 → detected = "B"

🔴 ERROR COMÚN A EVITAR:
- NO reportes la letra que ves al lado de la marca
- SÍ reporta según la POSICIÓN (línea 1,2,3,4 = A,B,C,D)

Reglas de detección:
- Primera opción con marca → detected = "A", questionType = "mc"
- Segunda opción con marca → detected = "B", questionType = "mc"
- Tercera opción con marca → detected = "C", questionType = "mc"
- Cuarta opción con marca → detected = "D", questionType = "mc"
- También puede haber E, F si hay más opciones

### TIPO 3: SELECCIÓN MÚLTIPLE (varias correctas)
⚠️ CRÍTICO: Revisa CADA opción individualmente para detectar TODAS las marcas.
Formatos de marca válidos para checkboxes:
- Checkbox relleno: ☑, ■, ▪, █, ✓ dentro de cuadro
- X dentro de cuadro: ☒, [X], (X)
- Cuadro con cualquier contenido visible vs cuadro vacío: □, ☐

🔴 MÉTODO OBLIGATORIO PARA SELECCIÓN MÚLTIPLE:
1. Examina CADA opción (A, B, C, D) una por una
2. Para cada opción, verifica si el checkbox/cuadro tiene marca o está relleno
3. Compara checkbox vacío (□) vs checkbox marcado (■, ☑, ☒)
4. Reporta TODAS las letras que tienen marca, separadas por coma

EJEMPLOS:
- □ A) texto  □ B) texto  ■ C) texto  ■ D) texto → detected = "C,D", questionType = "ms"
- ☐ (A)  ☐ (B)  ☑ (C)  ☑ (D) → detected = "C,D", questionType = "ms"  
- Marcas en A y C → detected = "A,C", questionType = "ms"
- Marcas en B, C y D → detected = "B,C,D", questionType = "ms"
- Solo una marca en C → detected = "C", questionType = "ms"

### TIPO 4: DESARROLLO / PROBLEMA (Respuesta escrita) ⚠️ MUY IMPORTANTE - NO OMITIR
⚠️ PUEDE ESTAR EN CUALQUIER POSICIÓN (1, 2, 3, 4, 5, etc.) - NO asumas que siempre es la última pregunta.

CÓMO IDENTIFICAR UNA PREGUNTA DE DESARROLLO:
- Contiene palabras como: "Problema", "Ejercicio", "Resuelve", "Calcula", "Escribe", "Explica", "Responde"
- Tiene líneas en blanco para escribir la respuesta
- NO tiene alternativas (A, B, C, D) ni opciones V/F
- Tiene espacio amplio para respuesta manuscrita
- Puede incluir "(XX pts)" indicando que vale más puntos

Formato de detección:
- questionType = "des"
- detected = "[texto extraído de la respuesta manuscrita]" (máximo 500 caracteres)
- evidence = "TEXTO manuscrito detectado" o "EMPTY - sin respuesta"

🔴 OBLIGATORIO: SIEMPRE incluir las preguntas de desarrollo en "answers"
- EXTRAE el texto completo de la respuesta del estudiante
- Si hay operaciones matemáticas, extrae números y resultados (ej: "12 - 4 = 8")
- Si hay texto escrito, extráelo completo (ej: "quedan 8 pajaros")
- SOLO si el área está completamente vacía → detected = null

🔴 EJEMPLOS CONCRETOS DE DESARROLLO:
Ejemplo 1 - Pregunta 4:
"4. Problema 1: Había 12 pájaros en un árbol. Se fueron 4 volando. ¿Cuántos quedaron? (25 pts)"
Área de respuesta tiene escrito: "quedan 8 pajaros" y "12 - 4 = 8"
→ {"questionNum": 4, "questionType": "des", "evidence": "TEXTO manuscrito detectado", "detected": "quedan 8 pajaros. 12 - 4 = 8", "points": 25}

Ejemplo 2 - Pregunta 2:
"2. Ejercicio: Juan tiene 5 canicas y le regalan 3 más. ¿Cuántas tiene ahora?"
Área de respuesta tiene escrito: "tiene 8 canicas"
→ {"questionNum": 2, "questionType": "des", "evidence": "TEXTO manuscrito detectado", "detected": "tiene 8 canicas", "points": null}

Ejemplo 3 - Sin respuesta:
"3. Problema: ..." con área de respuesta vacía
→ {"questionNum": 3, "questionType": "des", "evidence": "EMPTY - sin respuesta", "detected": null, "points": null}

⚠️ CRÍTICO: Las preguntas de desarrollo son OBLIGATORIAS en el análisis.
Si ves una pregunta tipo problema con espacio para escribir, DEBES incluirla en "answers".

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
⚠️ MUY IMPORTANTE:
a) Localiza TODAS las opciones (pueden estar en formato A), a), (A), etc.)
b) Para CADA opción, identifica la LETRA (A, B, C, D)
c) Busca cuál tiene marca (X, círculo, check, relleno)
d) REPORTA la LETRA de la opción marcada, NO la posición visual
e) ¿Ninguna marcada? → detected = null
f) ¿Más de una marcada? → detected = null (invalidado) para opción múltiple simple

**Si es SELECCIÓN MÚLTIPLE:**
⚠️ CRÍTICO - Examina CADA opción individualmente:
a) Para la opción A: ¿tiene checkbox relleno/marcado? (■, ☑, ☒, X) → SÍ/NO
b) Para la opción B: ¿tiene checkbox relleno/marcado? → SÍ/NO
c) Para la opción C: ¿tiene checkbox relleno/marcado? → SÍ/NO
d) Para la opción D: ¿tiene checkbox relleno/marcado? → SÍ/NO
e) Reporta TODAS las letras con SÍ, separadas por coma, en orden alfabético
f) Ejemplo: Si C=SÍ y D=SÍ → detected = "C,D"
g) ¿Ninguna marcada? → detected = null

**Si es DESARROLLO/PROBLEMA:**
a) Busca el área de respuesta (líneas, cuadro, espacio bajo la pregunta)
b) LEE TODO el texto manuscrito o impreso que el estudiante escribió
c) Extrae números, operaciones matemáticas, pasos y conclusiones
d) detected = texto completo de la respuesta (máx 500 chars)
e) Si está vacío o ilegible → detected = null
f) questionType = "des"

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
        {"questionNum": 6, "questionType": "mc", "evidence": "EMPTY - sin marca", "detected": null, "points": null},
        {"questionNum": 7, "questionType": "des", "evidence": "TEXTO manuscrito", "detected": "El resultado es 42 pasajeros. Primero 38-12+9=35, luego 35-8+15=42", "points": 25}
      ]
    }
  ]
}

## ⚠️ CHECKLIST FINAL ANTES DE RESPONDER:
1. ¿Incluí TODAS las preguntas del 1 al último número? ✓
2. ¿Identifiqué correctamente el TIPO de cada pregunta (tf/mc/ms/des)? ✓
3. ¿Las alternativas están en MAYÚSCULA (A, B, C, D)? ✓
4. ¿Las selecciones múltiples están separadas por coma (A,C,D)? ✓
5. ¿Las preguntas sin marca/respuesta tienen detected = null? ✓
6. ¿La letra reportada corresponde a la OPCIÓN con marca, no a la posición visual? ✓
7. 🔴 ¿INCLUÍ las preguntas de DESARROLLO (des) y extraje el TEXTO MANUSCRITO? ✓ OBLIGATORIO
8. ¿El texto de desarrollo incluye números, operaciones y palabras escritas? ✓
9. ¿El JSON es válido, sin texto adicional? ✓

🔴 RECORDATORIO FINAL: Las preguntas de desarrollo (questionType="des") son OBLIGATORIAS.
Si ves una pregunta tipo problema con espacio para escribir, DEBES incluirla en "answers".

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
    
    console.log('[OMR-VISION] 📝 Respuesta RAW de Gemini (primeros 2000 chars):')
    console.log(text.substring(0, 2000))

    try {
      const analysis = safeJsonParse(text)
      
      // 🆕 LOG: Verificar TODAS las preguntas detectadas
      console.log(`[OMR-VISION] 📊 questionsFoundInDocument: ${analysis?.questionsFoundInDocument}`)
      if (analysis?.pages) {
        for (const page of analysis.pages) {
          console.log(`[OMR-VISION] 📄 Página ${page.pageNum || page.pageIndex}: ${page.answers?.length || 0} respuestas`)
          if (Array.isArray(page.answers)) {
            for (const ans of page.answers) {
              const qType = ans.questionType || ans.type || 'unknown'
              const qNum = ans.questionNum || ans.q
              const qVal = ans.detected ?? ans.val
              console.log(`[OMR-VISION]   → P${qNum} (${qType}): "${qVal}" | evidence="${ans.evidence}"`)
              
              // Log especial para desarrollo
              if (qType === 'des') {
                console.log(`[OMR-VISION] 📝 DESARROLLO detectado: P${qNum} = "${qVal}"`)
              }
            }
          }
        }
      }
      
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
