import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Configuración del Route Segment para App Router
export const maxDuration = 60; // Máximo tiempo de ejecución en segundos
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { imageBase64, questions, pageNumber, focusQuestionNums, focusDevelopment } = await request.json();

    if (!imageBase64) {
      return NextResponse.json({ error: 'La imagen es requerida' }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    
    if (!apiKey) {
      console.warn('⚠️ Clave de Gemini no configurada para análisis OMR');
      return NextResponse.json({ success: false, error: 'API key no configurada', fallback: true });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    // Usar gemini-2.5-flash - modelo más reciente y disponible
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // 1. LIMPIEZA CRÍTICA DEL BASE64
    // Si el string viene con "data:image/png;base64,..." hay que quitarlo.
    const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');

    // 2. CONSTRUCCIÓN DEL CONTEXTO (PREGUNTAS)
    const questionsContext = Array.isArray(questions) && questions.length > 0
      ? `ESTRUCTURA ESPERADA DE LA PRUEBA (Úsala como guía - las opciones están en orden A, B, C, D de arriba a abajo):
         ${questions.map((q: any, i: number) => {
           if (q.type === 'tf') {
             return `P${i+1}: [Verdadero/Falso] - "${q.text?.substring(0, 50)}..."`
           } else if (q.type === 'mc') {
             const opts = (q.options || []).map((o: string, j: number) => `${String.fromCharCode(65+j)}=${o?.substring(0, 20)}`).join(' | ')
             return `P${i+1}: [MC - Opciones: ${opts}] "${q.text?.substring(0, 30)}..."`
           } else if (q.type === 'ms') {
             const opts = (q.options || []).map((o: any, j: number) => `${String.fromCharCode(65+j)}=${(typeof o === 'string' ? o : o?.text)?.substring(0, 15)}`).join(' | ')
             return `P${i+1}: [MS - Múltiples: ${opts}] "${q.text?.substring(0, 30)}..."`
           } else if (q.type === 'des') {
             return `P${i+1}: [DESARROLLO - Extraer TEXTO MANUSCRITO completo] "${q.text?.substring(0, 50)}..."`
           }
           return `P${i+1}: [Otro tipo]`
         }).join('\n         ')}`
      : 'Estructura genérica: Busca preguntas numeradas.';

    const focusNums: number[] = Array.isArray(focusQuestionNums)
      ? focusQuestionNums.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
      : [];
    
    // 🆕 Instrucción especial para desarrollo
    const devFocusLine = focusDevelopment
      ? `\n\n🔴 MODO DESARROLLO OBLIGATORIO:\n- Esta pregunta es de DESARROLLO (respuesta escrita)\n- DEBES extraer TODO el texto manuscrito que el estudiante escribió\n- Busca texto, números, operaciones matemáticas (ej: "12 - 4 = 8")\n- Si ves cualquier texto escrito a mano, extráelo completo\n- val debe contener el texto extraído, NO null\n`
      : '';
      
    const focusLine = focusNums.length > 0
      ? `\n\nMODO RE-CHEQUEO (FOCO): Analiza SOLO estas preguntas: ${focusNums.join(', ')}.\n- Ignora el resto del documento.\n- NO devuelvas preguntas fuera del foco.\n- Devuelve exactamente esas preguntas en "answers" (una entrada por cada número solicitado).${devFocusLine}\n`
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
FORMATOS COMUNES (todos válidos):
- Formato 1: "a) ( ) b) ( ) c) ( ) d) ( )" con paréntesis después
- Formato 2: "A. B. C. D." con punto después
- Formato 3: "(A) (B) (C) (D)" con paréntesis ALREDEDOR de la letra ← COMÚN EN CHILE
- Formato 4: "( ) A  ( ) B  ( ) C  ( ) D" con paréntesis antes

⚠️ REGLA CRÍTICA PARA DETECTAR LA OPCIÓN MARCADA:

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
→ La marca X está en la LÍNEA 2 → val = "B"

🔴 ERROR COMÚN A EVITAR:
- NO reportes la letra que ves al lado de la marca
- SÍ reporta según la POSICIÓN (línea 1,2,3,4 = A,B,C,D)

Reglas de detección:
- Marca en 1ª opción → val = "A", type = "mc"
- Marca en 2ª opción → val = "B", type = "mc"
- Marca en 3ª opción → val = "C", type = "mc"
- Marca en 4ª opción → val = "D", type = "mc"

### TIPO 3: SELECCIÓN MÚLTIPLE (varias correctas)
⚠️ CRÍTICO: Revisa CADA opción individualmente para detectar TODAS las marcas.
Formatos de marca válidos:
- Checkbox relleno: ☑, ■, ▪, █, ✓ dentro de cuadro
- X dentro de cuadro: ☒, [X], (X)
- Cuadro con cualquier contenido visible vs cuadro vacío: □, ☐

🔴 MÉTODO OBLIGATORIO PARA SELECCIÓN MÚLTIPLE:
1. Examina CADA opción (A, B, C, D) una por una
2. Para cada opción, verifica si el checkbox/cuadro tiene marca o está relleno
3. Compara checkbox vacío (□) vs checkbox marcado (■, ☑, ☒)
4. Reporta TODAS las letras que tienen marca, separadas por coma

EJEMPLOS:
- □ A) texto  □ B) texto  ■ C) texto  ■ D) texto → val = "C,D", type = "ms"
- ☐ (A)  ☐ (B)  ☑ (C)  ☑ (D) → val = "C,D", type = "ms"
- Marcas en A y C → val = "A,C", type = "ms"
- Marcas en B, C y D → val = "B,C,D", type = "ms"
- Solo una marca en C → val = "C", type = "ms"

### TIPO 4: DESARROLLO / PROBLEMA (Respuesta escrita) ⚠️ MUY IMPORTANTE
Formato: Pregunta con espacio para escribir respuesta (líneas, cuadro, espacio en blanco)
- 🔴 CRÍTICO: SIEMPRE incluir las preguntas de desarrollo en "answers"
- El estudiante escribe texto manuscrito o impreso como respuesta
- EXTRAE TODO el texto que el estudiante escribió, incluyendo:
  * Texto descriptivo ("quedan 8 pájaros", "el resultado es...")
  * Operaciones matemáticas ("12 - 4 = 8", "5 + 3 = 8")
  * Números y cálculos escritos
  * Cualquier palabra o frase visible en el área de respuesta
- type = "des"
- val = "[texto extraído completo]" (máximo 500 caracteres)
- Si hay CUALQUIER texto escrito en el área de respuesta → val = ese texto
- SOLO si el área está completamente vacía → val = null
- evidence = "TEXTO: [primeras palabras de la respuesta]"

🔴 EJEMPLO DE DESARROLLO:
Pregunta: "Había 12 pájaros. Se fueron 4. ¿Cuántos quedaron?"
Área de respuesta tiene escrito: "quedan 8 pajaros" y "12 - 4 = 8"
→ { "q": 4, "type": "des", "val": "quedan 8 pajaros. 12 - 4 = 8", "evidence": "TEXTO manuscrito detectado" }

⚠️ NO OMITAS las preguntas de desarrollo - son tan importantes como las demás.

## 📋 PROTOCOLO DE DETECCIÓN:

### PASO 1: LOCALIZAR Y CLASIFICAR PREGUNTAS
- Escanea el documento de arriba a abajo
- Identifica CADA pregunta numerada (1, 2, 3, 4, 5, ...)
- Determina el TIPO: ¿Es V/F o tiene alternativas A,B,C,D?

### PASO 2: ANALIZAR CADA PREGUNTA DE ALTERNATIVAS
⚠️ MUY IMPORTANTE: Para cada pregunta de alternativas:
1. IDENTIFICA TODAS las opciones (A, B, C, D, etc.)
2. Para CADA opción, verifica si tiene marca (X, círculo, check, relleno)
3. La marca puede estar:
   - Dentro de un paréntesis: (X) B → opción B marcada
   - Al lado de la letra: X B) → opción B marcada
   - Sobre la letra o texto de la opción
4. REPORTA la LETRA de la opción que tiene la marca, NO la posición visual

**Si es V/F:**
- Localiza V ( ) y F ( )
- ¿Cuál tiene marca? → val = "V" o "F"

**Si es ALTERNATIVAS:**
- Lee CADA línea de opción de arriba a abajo
- Identifica la LETRA (A, B, C, D) de cada opción
- Busca la marca (X, círculo, check) en cada opción
- REPORTA la letra de la opción marcada
- ¿Más de una marcada en opción simple? → val = null (invalidado)

**Si es SELECCIÓN MÚLTIPLE:**
⚠️ CRÍTICO - Examina CADA opción individualmente:
1. Opción A: ¿tiene checkbox relleno/marcado? (■, ☑, ☒, X) → SÍ/NO
2. Opción B: ¿tiene checkbox relleno/marcado? → SÍ/NO
3. Opción C: ¿tiene checkbox relleno/marcado? → SÍ/NO
4. Opción D: ¿tiene checkbox relleno/marcado? → SÍ/NO
5. Reporta TODAS las letras con SÍ, separadas por coma
Ejemplo: Si C=SÍ y D=SÍ → val = "C,D"

**Si es DESARROLLO/PROBLEMA:**
- Busca el área de respuesta (líneas, cuadro, espacio bajo la pregunta)
- LEE TODO el texto manuscrito o impreso que el estudiante escribió
- Extrae números, operaciones matemáticas, y conclusiones
- val = texto completo de la respuesta (máx 500 chars)
- Si está vacío o ilegible → val = null

### PASO 3: CLASIFICAR LA MARCA
- "STRONG_X": X clara → VÁLIDA
- "CHECK": Check/palomita ✓ → VÁLIDA
- "CIRCLE": Círculo alrededor → VÁLIDA
- "FILL": Rellenado/sombreado → VÁLIDA
- "EMPTY": Sin marca → val = null

### DETECCIÓN DE ESTUDIANTE (MUY IMPORTANTE):
- Busca en la parte SUPERIOR del documento: "Nombre:", "Estudiante:", "Alumno:" seguido de texto manuscrito o impreso
- El nombre suele estar en las primeras líneas del documento
- Extrae el NOMBRE COMPLETO (nombre y apellidos) - ejemplo: "María García López", "Juan Pérez"
- Si ves "Nombre del estudiante:" o similar, extrae lo que está DESPUÉS de los dos puntos
- NO devuelvas "DEL ESTUDIANTE" - eso es parte del encabezado, busca el nombre REAL escrito
- Busca "RUT:" seguido de números (opcional)

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
    { "q": 6, "type": "mc", "evidence": "EMPTY - sin marca", "val": null },
    { "q": 7, "type": "des", "evidence": "TEXTO manuscrito detectado", "val": "El resultado es 42 pasajeros porque 38-12+9=35, luego 35-8+15=42" }
  ],
  "confidence": "High"
}

## ⚠️ CHECKLIST ANTES DE RESPONDER:
1. ¿Incluí TODAS las preguntas del 1 al ${totalQuestions > 0 ? totalQuestions : 'último'}? ✓
2. ¿Identifiqué el TIPO correcto (tf/mc/ms/des)? ✓
3. ¿Las alternativas están en MAYÚSCULA (A, B, C, D)? ✓
4. ¿Las preguntas sin marca/respuesta tienen val = null? ✓
5. ¿La letra reportada corresponde a la OPCIÓN con marca, no a la posición visual? ✓
6. 🔴 ¿INCLUÍ las preguntas de DESARROLLO (des) y extraje el TEXTO MANUSCRITO? ✓
7. ¿El texto de desarrollo incluye números, operaciones y palabras escritas? ✓

⚠️ RECORDATORIO FINAL: Las preguntas de desarrollo (des) son OBLIGATORIAS.
Si ves una pregunta tipo problema con espacio para escribir, DEBES incluirla en "answers" con type="des" y val="[texto que escribió el estudiante]".

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
