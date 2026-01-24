import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

function getApiKey() {
  return (
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY
  );
}

function stripDataUrl(input: string): { mimeType: string; base64: string } {
  const m = String(input || '').match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { mimeType: m[1], base64: m[2] };
  // fallback: asumimos JPEG (renderPdfToImages produce JPEG)
  return { mimeType: 'image/jpeg', base64: String(input || '') };
}

/**
 * Endpoint simplificado SOLO para extraer texto manuscrito de preguntas de desarrollo.
 * Usa un prompt muy específico y simple para maximizar la detección de texto.
 */
export async function POST(request: NextRequest) {
  try {
    const { imageBase64, imageDataUrl, questionNum, questionText, mimeType } = await request.json();

    const rawImage = imageDataUrl || imageBase64;

    if (!rawImage) {
      return NextResponse.json({ success: false, error: 'Imagen requerida' }, { status: 400 });
    }

    const apiKey = getApiKey();
    
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'API key no configurada' }, { status: 200 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    // Resolver mimeType + base64
    const parsed = stripDataUrl(rawImage);
    const finalMime = (typeof mimeType === 'string' && mimeType.trim()) ? mimeType.trim() : parsed.mimeType;
    const cleanBase64 = parsed.base64;
    
    console.log(`[ExtractDev] 📊 Preparando imagen: mimeType=${finalMime}, base64Length=${cleanBase64.length}`);

    // Prompt MUY simple y específico - MEJORADO
    const prompt = `Eres un experto en OCR de exámenes escolares manuscritos.

TAREA: Extraer el texto ESCRITO A MANO por el estudiante en la PREGUNTA ${questionNum}.

${questionText ? `PREGUNTA ${questionNum}: "${questionText}"` : `Busca la pregunta número ${questionNum} en el documento.`}

INSTRUCCIONES:
1. Localiza la pregunta ${questionNum} en la imagen (puede decir "Problema ${questionNum}" o simplemente "${questionNum}.")
2. Mira DEBAJO de esa pregunta, en las líneas de respuesta
3. Extrae TODO el texto manuscrito que veas (palabras, números, operaciones matemáticas)
4. Si hay múltiples líneas escritas, inclúyelas todas separadas por " | "

EJEMPLOS DE RESPUESTAS MANUSCRITAS:
- "es una resta | 12 - 4 = 8 | quedaron 8 pajaros"
- "La respuesta es 15"
- "5 + 3 = 8"

RESPONDE SOLO con este JSON:
{
  "questionNum": ${questionNum},
  "extractedText": "texto manuscrito aquí" o null si NO hay texto escrito,
  "confidence": "high" | "medium" | "low"
}

⚠️ IMPORTANTE: Si ves CUALQUIER texto escrito a mano (aunque sea una palabra o número), extráelo. 
Solo devuelve null si las líneas de respuesta están COMPLETAMENTE vacías.

JSON:`;

    const imagePart = {
      inlineData: {
        data: cleanBase64,
        mimeType: finalMime,
      },
    };

    console.log(`[ExtractDev] 🔍 Extrayendo texto de desarrollo P${questionNum}...`);
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();
    
    console.log(`[ExtractDev] 📝 Respuesta raw:`, text.substring(0, 300));

    try {
      const jsonString = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analysis = JSON.parse(jsonString);
      
      console.log(`[ExtractDev] ✅ P${questionNum}: extractedText="${analysis.extractedText}" confidence=${analysis.confidence}`);
      
      return NextResponse.json({
        success: true,
        questionNum: analysis.questionNum,
        extractedText: analysis.extractedText,
        confidence: analysis.confidence,
      });
    } catch (parseError: any) {
      console.error('[ExtractDev] ❌ Error parseando JSON:', parseError.message);
      return NextResponse.json({
        success: false,
        error: 'Error parseando respuesta',
        rawResponse: text
      });
    }

  } catch (error: any) {
    console.error('[ExtractDev] ❌ Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
