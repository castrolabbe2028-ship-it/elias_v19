// API Route para generar preguntas con IA (OpenRouter o Gemini)
import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { openrouter } from "@/lib/openrouter";

// Determinar qué proveedor de IA usar
const useOpenRouter = !!process.env.OPENROUTER_API_KEY;

// Inicializa el cliente de Gemini como fallback
const genAI = new GoogleGenerativeAI(
  process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ""
);

// Fallback local cuando no hay API Key o la IA falla
function buildFallbackQuestions(topic: string, numQuestions: number, language: 'es' | 'en' = 'es') {
  const trueLabel = language === 'en' ? 'True' : 'Verdadero';
  const falseLabel = language === 'en' ? 'False' : 'Falso';

  const baseCount = Math.floor(numQuestions / 3);
  let remainder = numQuestions % 3;
  let mcCount = baseCount;
  let msCount = baseCount;
  let tfCount = baseCount;
  if (remainder > 0) { mcCount++; remainder--; }
  if (remainder > 0) { msCount++; remainder--; }

  const out: any[] = [];
  // multiple_choice
  for (let i = 0; i < mcCount; i++) {
    out.push({
      type: 'multiple_choice',
      question: `${language === 'en' ? 'Choose the correct option about' : 'Elige la opción correcta sobre'} ${topic} (${i+1})`,
      options: [
        `${topic}: A`,
        `${topic}: B`,
        `${topic}: C`,
        `${topic}: D`,
      ],
      correct: Math.floor(Math.random() * 4),
      explanation: language === 'en' ? 'Basic generated question.' : 'Pregunta generada localmente.'
    });
  }
  // multiple_select
  for (let i = 0; i < msCount; i++) {
    const indices = [0,1,2,3].filter(() => Math.random() > 0.5);
    const correct = indices.length > 0 ? indices : [0,2];
    out.push({
      type: 'multiple_select',
      question: `${language === 'en' ? 'Select all correct options about' : 'Selecciona todas las opciones correctas sobre'} ${topic} (${i+1})`,
      options: [
        `${topic}: Opt 1`,
        `${topic}: Opt 2`,
        `${topic}: Opt 3`,
        `${topic}: Opt 4`,
      ],
      correct,
      explanation: language === 'en' ? 'Multiple correct answers possible.' : 'Puede haber múltiples respuestas correctas.'
    });
  }
  // true_false
  for (let i = 0; i < tfCount; i++) {
    out.push({
      type: 'true_false',
      question: `${language === 'en' ? 'Statement about' : 'Afirmación sobre'} ${topic} (${i+1})`,
      options: [trueLabel, falseLabel],
      correct: Math.random() > 0.5 ? 0 : 1,
      explanation: language === 'en' ? 'Basic statement for practice.' : 'Afirmación básica para práctica.'
    });
  }
  return out.slice(0, numQuestions);
}

export async function POST(request: Request) {
  try {
    // Extraer los parámetros del cuerpo de la petición temprano (para fallback)
    const { topic, numQuestions, language = 'es' } = await request.json();

    // Verificar si hay alguna API Key configurada (OpenRouter o Google)
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const hasGoogleAI = !!(process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    
    if (!hasOpenRouter && !hasGoogleAI) {
      console.warn("[API Route] ⚠️ No AI API keys configured, using local fallback");
      const questions = buildFallbackQuestions(topic, Number(numQuestions) || 5, language);
      return NextResponse.json(questions);
    }

    if (!topic || !numQuestions) {
      return NextResponse.json(
        { error: "Faltan los parámetros 'topic' y 'numQuestions'" },
        { status: 400 }
      );
    }

    // --- LÓGICA DE DISTRIBUCIÓN DE PREGUNTAS ---
    const baseCount = Math.floor(numQuestions / 3);
    let remainder = numQuestions % 3;

    let mcCount = baseCount; // multiple_choice
    let msCount = baseCount; // multiple_select
    let tfCount = baseCount; // true_false

    // Distribuir el resto para alcanzar el total exacto
    if (remainder > 0) {
      mcCount++;
      remainder--;
    }
    if (remainder > 0) {
      msCount++;
      remainder--;
    }

    console.log(`[API Route] Petición para ${numQuestions} preguntas sobre "${topic}"`);
    console.log(`[API Route] Distribución: ${mcCount} Alternativas, ${msCount} Selección Múltiple, ${tfCount} V/F`);

    // 2. PROMPT MEJORADO CON INSTRUCCIONES MATEMÁTICAS EXACTAS Y SOPORTE MULTIIDIOMA
    const languageInstructions = {
      es: {
        trueLabel: "Verdadero",
        falseLabel: "Falso",
        generateText: "Genera un cuestionario",
        languageNote: "IMPORTANTE: Todas las preguntas, opciones y explicaciones deben estar en ESPAÑOL."
      },
      en: {
        trueLabel: "True", 
        falseLabel: "False",
        generateText: "Generate a quiz",
        languageNote: "IMPORTANT: All questions, options and explanations must be in ENGLISH."
      }
    };

    const lang = languageInstructions[language as keyof typeof languageInstructions] || languageInstructions.es;

    const userPrompt = `
      ${lang.generateText} de exactamente ${numQuestions} preguntas sobre "${topic}" para estudiantes de secundaria, distribuidas de la siguiente manera:
      - Exactamente ${mcCount} preguntas de tipo "multiple_choice" (selección única con 4 opciones).
      - Exactamente ${msCount} preguntas de tipo "multiple_select" (selección múltiple con 4 opciones).
      - Exactamente ${tfCount} preguntas de tipo "true_false" (verdadero o falso).

      ${lang.languageNote}

      IMPORTANTE: El total debe ser exactamente ${numQuestions} preguntas (${mcCount} + ${msCount} + ${tfCount} = ${numQuestions}).
      
      Asegúrate de que las preguntas y sus opciones sean únicas y no se repitan.
      Tu respuesta DEBE SER ÚNICAMENTE un objeto JSON válido, sin texto introductorio, sin explicaciones y sin formato Markdown.
      
      El JSON debe ser un array de exactamente ${numQuestions} objetos. Cada objeto debe tener:
      1. "type": una cadena que sea "multiple_choice", "multiple_select", o "true_false"
      2. "question": el texto de la pregunta
      3. "options": un array de strings con las alternativas
         - Para "true_false", este array debe ser siempre ["${lang.trueLabel}", "${lang.falseLabel}"]
         - Para los otros dos tipos, debe contener exactamente 4 opciones de texto
      4. "correct": la respuesta correcta
         - Para "multiple_choice" y "true_false", debe ser un NÚMERO con el índice correcto (ej: 0)
         - Para "multiple_select", debe ser un ARRAY de NÚMEROS con los índices correctos (ej: [1, 3])
      5. "explanation": una breve explicación de la respuesta correcta
    `;

    try {
      let text: string;
      
      // Usar OpenRouter si está configurado, sino usar Gemini
      if (hasOpenRouter) {
        console.log("[API Route] 🚀 Using OpenRouter for question generation");
        text = await openrouter.generateContent(userPrompt, {
          systemPrompt: language === 'es' 
            ? 'Eres un profesor experto creando evaluaciones educativas. Responde SOLO con JSON válido.'
            : 'You are an expert teacher creating educational evaluations. Respond ONLY with valid JSON.',
          temperature: 0.7,
          maxTokens: 4096,
        });
        console.log("[API Route] OpenRouter response received");
      } else {
        console.log("[API Route] 🤖 Using Gemini for question generation");
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const result = await model.generateContent(userPrompt);
        const response = await result.response;
        text = response.text();
        console.log("[API Route] Gemini response received");
      }

      console.log("[API Route] AI Response:", text.substring(0, 200) + "...");

      // 3. Limpiar y parsear la respuesta JSON
      // A veces la IA devuelve el JSON envuelto en ```json ... ```
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error("La respuesta de la IA no contiene un JSON válido.");
      }

      const cleanedJson = jsonMatch[0];
      const questions = JSON.parse(cleanedJson);

      console.log(`[API Route] JSON parseado correctamente. Devolviendo ${questions.length} preguntas.`);

      // 4. Validar que la cantidad de preguntas sea correcta
      if (questions.length !== numQuestions) {
        console.warn(`[API Route] ⚠️ Se esperaban ${numQuestions} preguntas pero se generaron ${questions.length}. Ajustando...`);
        
        if (questions.length > numQuestions) {
          // Si hay más preguntas de las esperadas, tomar solo las primeras
          questions.splice(numQuestions);
        } else {
          // Si hay menos preguntas, generar preguntas adicionales simples
          while (questions.length < numQuestions) {
            questions.push({
              type: "true_false",
              question: `Pregunta adicional ${questions.length + 1} sobre ${topic}`,
              options: ["Verdadero", "Falso"],
              correct: 0,
              explanation: "Pregunta generada para completar el cuestionario."
            });
          }
        }
      }

      // 5. Verificar distribución final
      const finalDistribution = {
        multiple_choice: questions.filter((q: any) => q.type === 'multiple_choice').length,
        multiple_select: questions.filter((q: any) => q.type === 'multiple_select').length,
        true_false: questions.filter((q: any) => q.type === 'true_false').length
      };

      console.log(`[API Route] ✅ Distribución final:`, finalDistribution);
      console.log(`[API Route] ✅ Total: ${finalDistribution.multiple_choice + finalDistribution.multiple_select + finalDistribution.true_false} preguntas`);

      // 6. Devolver las preguntas al frontend
      return NextResponse.json(questions);

    } catch (error) {
      console.error("[API Route] ❌ Error al generar preguntas con la API de Gemini:", error);
      // Fallback local si falla Gemini
      const fallback = buildFallbackQuestions(topic, Number(numQuestions) || 5, language);
      console.warn("[API Route] ✅ Devolviendo fallback local con", fallback.length, "preguntas");
      return NextResponse.json(fallback);
    }
  } catch (error) {
    console.error("[API Route] ❌ Error al procesar la petición:", error);
    // Último recurso: fallback genérico
    try {
      const questions = buildFallbackQuestions('general', 5, 'es');
      return NextResponse.json(questions);
    } catch {
      return NextResponse.json(
        { error: "Error interno del servidor." },
        { status: 500 }
      );
    }
  }
}
