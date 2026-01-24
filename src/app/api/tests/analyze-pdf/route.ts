import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai'

// Inicializar Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '')

// Tipos de respuesta
interface AnalyzedQuestion {
  id: string
  type: 'tf' | 'mc' | 'ms' | 'des'
  text: string
  options?: string[] // Para mc
  optionsWithCorrect?: Array<{ text: string; correct: boolean }> // Para ms
  correctIndex?: number // Para mc
  answer?: boolean // Para tf
  prompt?: string // Para des (alias de text)
}

interface AnalysisResult {
  success: boolean
  title?: string
  topic?: string
  questions: AnalyzedQuestion[]
  counts: { tf: number; mc: number; ms: number; des: number }
  rawText?: string
  error?: string
}

// Función para extraer texto del PDF usando la API de Gemini
async function extractAndAnalyzePDF(base64Data: string, mimeType: string, language: 'es' | 'en'): Promise<AnalysisResult> {
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
    })

    const prompt = language === 'es' 
      ? `Analiza este documento PDF de una prueba educativa y extrae TODAS las preguntas que encuentres.

Para cada pregunta, identifica:
1. El tipo de pregunta:
   - "tf" para Verdadero/Falso
   - "mc" para Alternativas (una respuesta correcta)
   - "ms" para Selección Múltiple (varias respuestas correctas)
   - "des" para preguntas de Desarrollo/Ensayo

2. El texto completo de la pregunta
3. Las opciones de respuesta (si las tiene)
4. La respuesta correcta si está indicada en el documento

IMPORTANTE: Responde SOLO con un JSON válido, sin texto adicional, con esta estructura exacta:
{
  "title": "Título de la prueba (si lo encuentras)",
  "topic": "Tema principal de la prueba (infiere del contenido)",
  "questions": [
    {
      "type": "tf",
      "text": "El agua hierve a 100 grados Celsius",
      "answer": true
    },
    {
      "type": "mc",
      "text": "¿Cuál es la capital de Chile?",
      "options": ["Buenos Aires", "Santiago", "Lima", "Montevideo"],
      "correctIndex": 1
    },
    {
      "type": "ms",
      "text": "Selecciona todos los números primos",
      "optionsWithCorrect": [
        {"text": "2", "correct": true},
        {"text": "4", "correct": false},
        {"text": "5", "correct": true},
        {"text": "9", "correct": false}
      ]
    },
    {
      "type": "des",
      "text": "Explica el ciclo del agua"
    }
  ]
}

Si no puedes determinar la respuesta correcta, usa valores por defecto (false para tf, 0 para correctIndex).
Extrae TODAS las preguntas que puedas identificar en el documento.`
      : `Analyze this PDF document of an educational test and extract ALL questions you find.

For each question, identify:
1. The question type:
   - "tf" for True/False
   - "mc" for Multiple Choice (one correct answer)
   - "ms" for Multiple Selection (multiple correct answers)
   - "des" for Essay/Development questions

2. The complete question text
3. The answer options (if any)
4. The correct answer if indicated in the document

IMPORTANT: Respond ONLY with valid JSON, no additional text, with this exact structure:
{
  "title": "Test title (if found)",
  "topic": "Main topic of the test (infer from content)",
  "questions": [
    {
      "type": "tf",
      "text": "Water boils at 100 degrees Celsius",
      "answer": true
    },
    {
      "type": "mc",
      "text": "What is the capital of France?",
      "options": ["London", "Paris", "Berlin", "Madrid"],
      "correctIndex": 1
    },
    {
      "type": "ms",
      "text": "Select all prime numbers",
      "optionsWithCorrect": [
        {"text": "2", "correct": true},
        {"text": "4", "correct": false},
        {"text": "5", "correct": true},
        {"text": "9", "correct": false}
      ]
    },
    {
      "type": "des",
      "text": "Explain the water cycle"
    }
  ]
}

If you cannot determine the correct answer, use default values (false for tf, 0 for correctIndex).
Extract ALL questions you can identify in the document.`

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Data
        }
      },
      { text: prompt }
    ])

    const response = result.response
    const text = response.text()
    
    // Intentar parsear el JSON de la respuesta
    let parsedResponse: any
    try {
      // Limpiar el texto por si tiene markdown
      let cleanText = text.trim()
      if (cleanText.startsWith('```json')) {
        cleanText = cleanText.replace(/^```json\s*/, '').replace(/```\s*$/, '')
      } else if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```\s*/, '').replace(/```\s*$/, '')
      }
      parsedResponse = JSON.parse(cleanText)
    } catch (parseError) {
      console.error('[analyze-pdf] Error parsing JSON response:', parseError)
      console.log('[analyze-pdf] Raw response:', text)
      return {
        success: false,
        questions: [],
        counts: { tf: 0, mc: 0, ms: 0, des: 0 },
        rawText: text,
        error: 'Could not parse AI response as JSON'
      }
    }

    // Procesar las preguntas
    const questions: AnalyzedQuestion[] = (parsedResponse.questions || []).map((q: any, idx: number) => {
      const id = `q_${Date.now()}_${idx}`
      const type = q.type as 'tf' | 'mc' | 'ms' | 'des'
      
      const base: AnalyzedQuestion = {
        id,
        type,
        text: q.text || q.prompt || ''
      }

      switch (type) {
        case 'tf':
          base.answer = typeof q.answer === 'boolean' ? q.answer : false
          break
        case 'mc':
          base.options = Array.isArray(q.options) ? q.options : []
          base.correctIndex = typeof q.correctIndex === 'number' ? q.correctIndex : 0
          break
        case 'ms':
          if (Array.isArray(q.optionsWithCorrect)) {
            base.optionsWithCorrect = q.optionsWithCorrect.map((opt: any) => ({
              text: String(opt.text || opt),
              correct: Boolean(opt.correct)
            }))
          } else if (Array.isArray(q.options)) {
            // Fallback si vienen como array simple
            base.optionsWithCorrect = q.options.map((opt: any) => ({
              text: String(opt.text || opt),
              correct: Boolean(opt.correct)
            }))
          }
          break
        case 'des':
          base.prompt = q.text || q.prompt || ''
          break
      }

      return base
    })

    // Contar por tipo
    const counts = {
      tf: questions.filter(q => q.type === 'tf').length,
      mc: questions.filter(q => q.type === 'mc').length,
      ms: questions.filter(q => q.type === 'ms').length,
      des: questions.filter(q => q.type === 'des').length
    }

    return {
      success: true,
      title: parsedResponse.title || undefined,
      topic: parsedResponse.topic || undefined,
      questions,
      counts,
      rawText: text
    }

  } catch (error: any) {
    console.error('[analyze-pdf] Error analyzing PDF:', error)
    return {
      success: false,
      questions: [],
      counts: { tf: 0, mc: 0, ms: 0, des: 0 },
      error: error?.message || 'Unknown error analyzing PDF'
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const language = (formData.get('language') as string) === 'en' ? 'en' : 'es'

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      )
    }

    // Validar tipo de archivo
    const validTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']
    if (!validTypes.includes(file.type)) {
      return NextResponse.json(
        { success: false, error: 'Invalid file type. Supported: PDF, PNG, JPG, WEBP' },
        { status: 400 }
      )
    }

    // Convertir archivo a base64
    const arrayBuffer = await file.arrayBuffer()
    const base64Data = Buffer.from(arrayBuffer).toString('base64')

    // Analizar con Gemini
    const result = await extractAndAnalyzePDF(base64Data, file.type, language)

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Analysis failed' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      title: result.title,
      topic: result.topic,
      questions: result.questions,
      counts: result.counts,
      totalQuestions: result.questions.length
    })

  } catch (error: any) {
    console.error('[api/tests/analyze-pdf] Error:', error)
    return NextResponse.json(
      { success: false, error: error?.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
