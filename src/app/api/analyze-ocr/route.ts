import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Configuración del Route Segment para App Router
export const maxDuration = 60; // Máximo tiempo de ejecución en segundos
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { imageBase64, questions, pageNumber, focusQuestionNums } = await request.json();

    if (!imageBase64) {
      return NextResponse.json({ error: 'La imagen es requerida' }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    
    if (!apiKey) {
      console.warn('⚠️ Clave de Gemini no configurada para análisis OMR');
      return NextResponse.json({ success: false, error: 'API key no configurada', fallback: true });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    // 1. LIMPIEZA CRÍTICA DEL BASE64
    // Si el string viene con "data:image/png;base64,..." hay que quitarlo.
    const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');

    // 2. CONSTRUCCIÓN DEL CONTEXTO (PREGUNTAS)
    const questionsContext = Array.isArray(questions) && questions.length > 0
      ? `ESTRUCTURA ESPERADA DE LA PRUEBA (Úsala como guía de ubicación):
         ${questions.map((q: any, i: number) => {
           if (q.type === 'tf') {
             return `P${i+1}: [Verdadero/Falso] - "${q.text?.substring(0, 50)}..."`
           } else if (q.type === 'mc') {
             const opts = (q.options || []).map((o: string, j: number) => `${String.fromCharCode(65+j)}) ${o?.substring(0, 15)}`).join(', ')
             return `P${i+1}: [Opción Múltiple: ${opts}] - "${q.text?.substring(0, 40)}..."`
           }
           return `P${i+1}: [Otro tipo]`
         }).join('\n         ')}`
      : 'Estructura genérica: Busca preguntas numeradas.';

    const focusNums: number[] = Array.isArray(focusQuestionNums)
      ? focusQuestionNums.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
      : [];
    const focusLine = focusNums.length > 0
      ? `\n\nMODO RE-CHEQUEO (FOCO): Analiza SOLO estas preguntas: ${focusNums.join(', ')}.\n- Ignora el resto del documento.\n- NO devuelvas preguntas fuera del foco.\n- Devuelve exactamente esas preguntas en "answers" (una entrada por cada número solicitado).\n`
      : '';

    const totalQuestions = Array.isArray(questions) ? questions.length : 0;

    // 3. PROMPT MEJORADO - SOPORTA V/F, ALTERNATIVAS Y SELECCIÓN MÚLTIPLE
    const prompt = `
ROL: Auditor Forense de Exámenes Escolares (Visión Artificial OMR).

TAREA: Analizar la imagen y extraer TODAS las preguntas visibles.
⚠️ CRÍTICO: DEBES REPORTAR CADA PREGUNTA DEL 1 AL ${totalQuestions > 0 ? totalQuestions : 'ÚLTIMO NÚMERO VISIBLE'}.

${focusLine}

${questionsContext}

## 📋 TIPOS DE PREGUNTAS A DETECTAR:

### TIPO 1: VERDADERO/FALSO (V/F)
Formato: "V ( ) F ( )" o "Verdadero ( ) Falso ( )"
- Marca en V → val = "V", type = "tf"
- Marca en F → val = "F", type = "tf"

### TIPO 2: ALTERNATIVAS / OPCIÓN MÚLTIPLE (A, B, C, D)
Formato: "a) ( ) b) ( ) c) ( ) d) ( )" o "A. B. C. D."
- Marca en A → val = "A", type = "mc"
- Marca en B → val = "B", type = "mc"
- Marca en C → val = "C", type = "mc"
- Marca en D → val = "D", type = "mc"

### TIPO 3: SELECCIÓN MÚLTIPLE (varias correctas)
Igual que alternativas pero puede tener MÚLTIPLES marcas
- Marcas en A y C → val = "A,C", type = "ms"
- Marcas en B, C y D → val = "B,C,D", type = "ms"

## 📋 PROTOCOLO DE DETECCIÓN:

### PASO 1: LOCALIZAR Y CLASIFICAR PREGUNTAS
- Escanea el documento de arriba a abajo
- Identifica CADA pregunta numerada (1, 2, 3, 4, 5, ...)
- Determina el TIPO: ¿Es V/F o tiene alternativas A,B,C,D?

### PASO 2: ANALIZAR CADA PREGUNTA
**Si es V/F:**
- Localiza V ( ) y F ( )
- ¿Cuál tiene marca? → val = "V" o "F"

**Si es ALTERNATIVAS:**
- Localiza a) b) c) d) o A. B. C. D.
- ¿Cuál tiene marca (X, círculo, check)? → val = "A", "B", "C" o "D"
- ¿Más de una marcada en opción simple? → val = null (invalidado)

**Si es SELECCIÓN MÚLTIPLE:**
- ¿Cuáles tienen marca? → val = "A,C" (separadas por coma)

### PASO 3: CLASIFICAR LA MARCA
- "STRONG_X": X clara → VÁLIDA
- "CHECK": Check/palomita ✓ → VÁLIDA
- "CIRCLE": Círculo alrededor → VÁLIDA
- "FILL": Rellenado/sombreado → VÁLIDA
- "EMPTY": Sin marca → val = null

### DETECCIÓN DE ESTUDIANTE:
- Busca "Nombre:", "Estudiante:" seguido de texto
- Busca "RUT:" seguido de números

## FORMATO DE SALIDA (JSON PURO):
{
  "studentName": "Nombre detectado o null",
  "rut": "RUT detectado o null",
  "questionsFound": número_total_de_preguntas,
  "answers": [
    { "q": 1, "type": "tf", "evidence": "STRONG_X en V", "val": "V" },
    { "q": 2, "type": "tf", "evidence": "STRONG_X en F", "val": "F" },
    { "q": 3, "type": "mc", "evidence": "CIRCLE en opción B", "val": "B" },
    { "q": 4, "type": "mc", "evidence": "STRONG_X en opción A", "val": "A" },
    { "q": 5, "type": "ms", "evidence": "STRONG_X en A y C", "val": "A,C" },
    { "q": 6, "type": "mc", "evidence": "EMPTY - sin marca", "val": null }
  ],
  "confidence": "High"
}

## ⚠️ CHECKLIST ANTES DE RESPONDER:
1. ¿Incluí TODAS las preguntas del 1 al ${totalQuestions > 0 ? totalQuestions : 'último'}? ✓
2. ¿Identifiqué el TIPO correcto (tf/mc/ms)? ✓
3. ¿Las alternativas están en MAYÚSCULA (A, B, C, D)? ✓
4. ¿Las preguntas sin marca tienen val = null? ✓

Devuelve SOLO JSON válido.
`;

    // 4. PREPARACIÓN MULTIMODAL
    const imagePart = {
      inlineData: {
        data: cleanBase64,
        mimeType: 'image/jpeg',
      },
    };

    // 5. GENERACIÓN
    console.log(`[OMR] 🔍 Analizando página ${pageNumber || 'N/A'} con Gemini Vision...`);
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();
    console.log(`[OMR] 📝 Respuesta raw:`, text.substring(0, 500));

    // 6. PARSEO SEGURO
    try {
      const jsonString = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analysis = JSON.parse(jsonString);
      
      console.log(`[OMR] ✅ Página ${pageNumber}: ${analysis.questionsFound || 0} preguntas, ${analysis.answers?.filter((a: any) => a.val !== null).length || 0} respondidas`);
      
      return NextResponse.json({
        success: true,
        analysis,
        pageNumber
      });
    } catch (parseError: any) {
      console.error('[OMR] ❌ Error parseando JSON:', parseError.message);
      console.error('[OMR] Texto recibido:', text);
      return NextResponse.json({
        success: false,
        error: 'Error parseando respuesta de IA',
        rawResponse: text
      });
    }

  } catch (error: any) {
    console.error('[OMR] ❌ Error general:', error);
    return NextResponse.json(
      { success: false, error: error.message, fallback: true },
      { status: 500 }
    );
  }
}
