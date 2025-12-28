
// src/ai/flows/generate-summary.ts
'use server';

/**
 * @fileOverview Generates a summary of a specific topic from a selected book.
 *
 * - generateSummary - A function that handles the summary generation process.
 * - GenerateSummaryInput - The input type for the generateSummary function.
 * - GenerateSummaryOutput - The return type for the generateSummary function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import { getOpenRouterClient, hasOpenRouterApiKey, OPENROUTER_MODELS } from '@/lib/openrouter-client';
import { getContentGenerationContext, generateAIPromptInstructions } from '@/lib/topic-descriptions';

// =============================================================================
// DETECTAR ASIGNATURAS CON CÁLCULOS (MATEMÁTICAS, FÍSICA, QUÍMICA, BIOLOGÍA)
// =============================================================================
type SubjectWithCalculations = 'matematicas' | 'fisica' | 'quimica' | 'biologia' | null;

function detectSubjectWithCalculations(bookTitle: string, topic: string): SubjectWithCalculations {
  const normalizedTitle = bookTitle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normalizedTopic = topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const combined = normalizedTitle + ' ' + normalizedTopic;
  
  // Detectar Matemáticas
  if (/matem|math|algebra|geometr|aritmet|calculo|trigonometr|ecuacion|numero|fraccion|decimal|porcentaje|division|multiplicacion|suma|resta|raiz|potencia/i.test(combined)) {
    return 'matematicas';
  }
  
  // Detectar Física
  if (/fisica|physics|cinematica|dinamica|mecanica|optica|termodinamica|electr|magneti|ondas|movimiento|fuerza|energia|trabajo|potencia|velocidad|aceleracion|newton|joule|watt/i.test(combined)) {
    return 'fisica';
  }
  
  // Detectar Química
  if (/quimica|chemistry|atomo|molecula|elemento|compuesto|reaccion|estequiometria|mol|concentracion|solucion|acido|base|ph|enlace|tabla periodica|valencia|oxidacion|reduccion/i.test(combined)) {
    return 'quimica';
  }
  
  // Detectar Biología con cálculos
  if (/biologia|biology|genetica|herencia|adn|cromosoma|mitosis|meiosis|poblacion|ecosistema|cadena trofica|metabolismo|fotosintesis|respiracion celular/i.test(combined)) {
    return 'biologia';
  }
  
  return null;
}

// Instrucciones adicionales para asignaturas con cálculos
function getCalculationInstructions(subjectType: SubjectWithCalculations, language: 'es' | 'en'): string {
  if (!subjectType) return '';
  
  const instructions: Record<SubjectWithCalculations, { es: string; en: string }> = {
    matematicas: {
      es: `
📐 INSTRUCCIONES ESPECIALES PARA MATEMÁTICAS:
- Incluye FÓRMULAS Y ECUACIONES relevantes
- Agrega EJEMPLOS RESUELTOS paso a paso
- Muestra el DESARROLLO de los ejercicios
- Incluye una sección "### Ejercicios Resueltos" con 3-5 problemas con sus soluciones completas`,
      en: `
📐 SPECIAL INSTRUCTIONS FOR MATHEMATICS:
- Include relevant FORMULAS AND EQUATIONS
- Add SOLVED EXAMPLES step by step
- Show the DEVELOPMENT of exercises
- Include a "### Solved Exercises" section with 3-5 problems with complete solutions`
    },
    fisica: {
      es: `
⚡ INSTRUCCIONES ESPECIALES PARA FÍSICA:
- Incluye FÓRMULAS relevantes (v=d/t, F=ma, E=mc², etc.)
- Agrega EJEMPLOS RESUELTOS con desarrollo paso a paso
- Muestra DIAGRAMAS conceptuales cuando sea posible
- Incluye UNIDADES de medida (m, kg, N, J, W, etc.)
- Agrega una sección "### Problemas Resueltos" con 3-4 ejercicios prácticos`,
      en: `
⚡ SPECIAL INSTRUCTIONS FOR PHYSICS:
- Include relevant FORMULAS (v=d/t, F=ma, E=mc², etc.)
- Add SOLVED EXAMPLES with step-by-step development
- Show conceptual DIAGRAMS when possible
- Include UNITS of measurement (m, kg, N, J, W, etc.)
- Add a "### Solved Problems" section with 3-4 practical exercises`
    },
    quimica: {
      es: `
🧪 INSTRUCCIONES ESPECIALES PARA QUÍMICA:
- Incluye FÓRMULAS químicas y ecuaciones (H₂O, CO₂, etc.)
- Agrega CÁLCULOS de estequiometría cuando corresponda
- Muestra BALANCEO de ecuaciones químicas
- Incluye unidades (mol, g/mol, M, pH)
- Agrega una sección "### Ejercicios Resueltos" con cálculos químicos`,
      en: `
🧪 SPECIAL INSTRUCTIONS FOR CHEMISTRY:
- Include CHEMICAL FORMULAS and equations (H₂O, CO₂, etc.)
- Add STOICHIOMETRY calculations when applicable
- Show BALANCING of chemical equations
- Include units (mol, g/mol, M, pH)
- Add a "### Solved Exercises" section with chemical calculations`
    },
    biologia: {
      es: `
🧬 INSTRUCCIONES ESPECIALES PARA BIOLOGÍA:
- Cuando sea sobre genética, incluye CRUCES GENÉTICOS (cuadros de Punnett)
- Muestra PROBABILIDADES en herencia
- Incluye PROPORCIONES fenotípicas y genotípicas
- Agrega ejemplos prácticos de cálculos biológicos cuando corresponda`,
      en: `
🧬 SPECIAL INSTRUCTIONS FOR BIOLOGY:
- When about genetics, include GENETIC CROSSES (Punnett squares)
- Show PROBABILITIES in inheritance
- Include PHENOTYPIC and GENOTYPIC RATIOS
- Add practical examples of biological calculations when applicable`
    }
  };
  
  return instructions[subjectType]?.[language] || '';
}

const GenerateSummaryInputSchema = z.object({
  bookTitle: z.string().describe('The title of the book to summarize from.'),
  topic: z.string().describe('The specific topic to summarize. This helps focus the summary.'),
  topicDescription: z.string().optional().describe('A description of the topic that provides orientation and context for the summary.'),
  includeKeyPoints: z.boolean().optional().describe('Whether to include 10 key points from the summary.'),
  language: z.enum(['es', 'en']).describe('The language for the output summary and key points (e.g., "es" for Spanish, "en" for English).'),
  pdfContent: z.string().optional().describe('The extracted content from the PDF book related to the topic. This provides the educational context for generating an accurate summary.'),
  course: z.string().optional().describe('The course level (e.g., "1ro Básico", "8vo Básico").'),
});

export type GenerateSummaryInput = z.infer<typeof GenerateSummaryInputSchema>;

const GenerateSummaryOutputSchema = z.object({
  summary: z.string().describe('The generated summary of the topic, potentially up to 10,000 words based on AI knowledge of the book and topic. Should be formatted in Markdown.'),
  keyPoints: z.array(z.string()).optional().describe('An array of 10 key points if requested, in the specified language.'),
  progress: z.string().describe('One-sentence progress of summary generation.'),
});

export type GenerateSummaryOutput = z.infer<typeof GenerateSummaryOutputSchema>;

// Función para generar resumen usando OpenRouter
async function generateWithOpenRouter(input: GenerateSummaryInput): Promise<GenerateSummaryOutput> {
  console.log('[generate-summary] Attempting OpenRouter generation...');
  console.log('[generate-summary] OPENROUTER_API_KEY exists:', !!process.env.OPENROUTER_API_KEY);
  console.log('[generate-summary] OPENROUTER_API_KEY length:', process.env.OPENROUTER_API_KEY?.length || 0);
  
  const client = getOpenRouterClient();
  if (!client) {
    console.error('[generate-summary] OpenRouter client not available - API key may be missing');
    throw new Error('OpenRouter client not available - check OPENROUTER_API_KEY environment variable');
  }
  
  console.log('[generate-summary] OpenRouter client obtained successfully');

  const isSpanish = input.language === 'es';
  
  // Obtener contexto de generación basado en el curso
  const courseContext = input.course ? getContentGenerationContext(input.course) : null;
  const adaptationInstructions = courseContext ? generateAIPromptInstructions(courseContext, input.language) : '';
  
  // Detectar si es asignatura con cálculos
  const subjectType = detectSubjectWithCalculations(input.bookTitle, input.topic);
  const calculationInstructions = getCalculationInstructions(subjectType, isSpanish ? 'es' : 'en');
  
  console.log('[generate-summary] Subject type detected:', subjectType || 'general');
  
  const systemPrompt = isSpanish 
    ? `Eres un experto educador y creador de contenido pedagógico especializado en el currículo escolar chileno. Tu tarea es crear resúmenes educativos de alta calidad en español, ADAPTADOS AL NIVEL DEL ESTUDIANTE.

IMPORTANTE:
- Genera contenido educativo REAL, ESPECÍFICO y DETALLADO sobre el tema
- ADAPTA la complejidad del lenguaje y los ejemplos según el nivel del curso
- NO uses frases genéricas como "es un tema importante" o "conjunto de conocimientos"
- Incluye definiciones claras, ejemplos concretos apropiados para la edad
- Usa formato Markdown con ## para títulos y ### para subtítulos
- Usa **negrita** para términos importantes
- Incluye ejemplos del mundo real apropiados para la edad del estudiante
${calculationInstructions}

${adaptationInstructions}`
    : `You are an expert educator and pedagogical content creator specialized in the Chilean school curriculum. Your task is to create high-quality educational summaries in English, ADAPTED TO THE STUDENT'S LEVEL.

IMPORTANT:
- Generate REAL, SPECIFIC and DETAILED educational content about the topic
- ADAPT the language complexity and examples according to the grade level
- DO NOT use generic phrases like "this is an important topic" or "set of knowledge"
- Include clear definitions, concrete examples appropriate for the age
- Use Markdown format with ## for titles and ### for subtitles
- Use **bold** for important terms
- Include real-world examples appropriate for the student's age
${calculationInstructions}

${adaptationInstructions}`;

  // Construir la descripción del tema si está disponible
  const topicContext = input.topicDescription 
    ? (isSpanish 
        ? `\n\n📋 ORIENTACIÓN DEL TEMA:\n${input.topicDescription}\n\nUsa esta descripción como guía para enfocar el contenido del resumen.`
        : `\n\n📋 TOPIC GUIDANCE:\n${input.topicDescription}\n\nUse this description as a guide to focus the summary content.`)
    : '';

  let userPrompt = isSpanish
    ? `Genera un resumen educativo sobre "${input.topic}" para la asignatura de ${input.bookTitle}${input.course ? ` (nivel: ${input.course})` : ''}.${topicContext}

⚠️ REQUISITO: El resumen debe estar ADAPTADO al nivel del estudiante. ${courseContext ? `Este estudiante tiene aproximadamente ${courseContext.approximateAge} años.` : ''}

El resumen DEBE incluir las siguientes secciones (adaptadas al nivel del estudiante):

1. **Introducción**: Qué es ${input.topic}, contexto y por qué es importante estudiarlo

2. **Conceptos Fundamentales**: Definiciones claras y precisas de los términos clave

3. **Desarrollo del Tema**: Explicación detallada con ejemplos apropiados para la edad

4. **Características y Componentes**: Elementos principales y clasificaciones del tema

5. **Ejemplos Prácticos y Aplicaciones**: Casos concretos que el estudiante pueda relacionar con su vida

6. **Importancia y Relevancia**: Por qué es relevante para el estudiante

7. **Conclusión**: Síntesis de los puntos principales`
    : `Generate an educational summary about "${input.topic}" for the subject ${input.bookTitle}${input.course ? ` (level: ${input.course})` : ''}.${topicContext}

⚠️ REQUIREMENT: The summary must be ADAPTED to the student's level. ${courseContext ? `This student is approximately ${courseContext.approximateAge} years old.` : ''}

The summary MUST include the following sections (adapted to the student's level):

1. **Introduction**: What is ${input.topic}, context and why it's important to study

2. **Fundamental Concepts**: Clear and precise definitions of key terms

3. **Topic Development**: Detailed explanation with age-appropriate examples

4. **Characteristics and Components**: Main elements and classifications of the topic

5. **Practical Examples and Applications**: Concrete cases the student can relate to their life

6. **Importance and Relevance**: Why it's relevant for the student

7. **Conclusion**: Synthesis of the main points`;

  // Si hay contenido PDF, agregarlo como contexto
  if (input.pdfContent && input.pdfContent.length > 100) {
    userPrompt += isSpanish
      ? `\n\n=== CONTENIDO DEL LIBRO DE TEXTO ===\nBasa tu resumen en esta información:\n\n${input.pdfContent}\n=== FIN DEL CONTENIDO ===`
      : `\n\n=== TEXTBOOK CONTENT ===\nBase your summary on this information:\n\n${input.pdfContent}\n=== END OF CONTENT ===`;
  }

  if (input.includeKeyPoints) {
    userPrompt += isSpanish
      ? `\n\nAdemás, al final incluye una sección "## Puntos Clave" con exactamente 10 puntos importantes del tema, cada uno en una línea separada comenzando con "- ".`
      : `\n\nAlso, at the end include a "## Key Points" section with exactly 10 important points about the topic, each on a separate line starting with "- ".`;
  }

  console.log('[generate-summary] Calling OpenRouter API...');
  const response = await client.generateText(systemPrompt, userPrompt, {
    model: OPENROUTER_MODELS.GPT_4O_MINI,
    temperature: 0.7,
    maxTokens: 8192,
  });
  console.log('[generate-summary] OpenRouter response received');

  // Extraer puntos clave si fueron solicitados
  let keyPoints: string[] | undefined;
  if (input.includeKeyPoints) {
    const keyPointsMatch = response.match(/##\s*(?:Puntos Clave|Key Points)\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (keyPointsMatch) {
      keyPoints = keyPointsMatch[1]
        .split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-\s*/, '').trim())
        .filter(point => point.length > 0)
        .slice(0, 10);
    }
  }

  return {
    summary: response,
    keyPoints,
    progress: isSpanish 
      ? `Resumen generado exitosamente usando OpenRouter para "${input.topic}".`
      : `Summary successfully generated using OpenRouter for "${input.topic}".`,
  };
}

export async function generateSummary(input: GenerateSummaryInput): Promise<GenerateSummaryOutput> {
  // Primero intentar con OpenRouter (prioridad principal)
  const hasOpenRouter = hasOpenRouterApiKey();
  console.log('[generate-summary] OpenRouter API available:', hasOpenRouter ? 'Yes' : 'No');
  
  if (hasOpenRouter) {
    try {
      console.log('[generate-summary] Trying OpenRouter first...');
      const result = await generateWithOpenRouter(input);
      console.log('[generate-summary] OpenRouter successful!');
      return result;
    } catch (error: any) {
      console.error('[generate-summary] OpenRouter error:', error?.message || error);
      // Continuar con Google Gemini como fallback
    }
  }

  // Fallback a Google Gemini
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
  const hasValidApiKey = apiKey && apiKey !== 'your_google_api_key_here' && apiKey.length > 10;
  
  console.log('[generate-summary] Google API key available:', hasValidApiKey ? 'Yes' : 'No');
  console.log('[generate-summary] Input topic:', input.topic);
  console.log('[generate-summary] Input subject:', input.bookTitle);
  console.log('[generate-summary] Has PDF content:', input.pdfContent ? `${input.pdfContent.length} chars` : 'No');
  
  // Intentar usar Google Gemini si hay API key
  if (hasValidApiKey) {
    try {
      console.log('[generate-summary] Calling Google Gemini AI flow...');
      const result = await generateSummaryFlow(input);
      console.log('[generate-summary] Google AI flow successful');
      return result;
    } catch (error: any) {
      console.error('[generate-summary] Error in Google AI flow:', error);
      
      // Detectar error de cuota excedida
      if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('quota')) {
        console.log('[generate-summary] Quota exceeded, using fallback...');
        return generateQuotaExceededFallback(input);
      }
      
      // Si falla la IA por otra razón, usar el fallback
    }
  }
  
  // Fallback: usar contenido del PDF si está disponible
  console.log('[generate-summary] Using fallback with PDF content...');
  return generateMockSummary(input);
}

function generateQuotaExceededFallback(input: GenerateSummaryInput): GenerateSummaryOutput {
  const isSpanish = input.language === 'es';
  
  // Si hay contenido PDF, usarlo
  if (input.pdfContent && input.pdfContent.length > 100) {
    const realSummary = generateRealSummaryFromContent(input.topic, input.bookTitle, input.pdfContent, isSpanish, input.course);
    const realKeyPoints = input.includeKeyPoints 
      ? extractRealKeyPoints(input.pdfContent, input.topic, isSpanish)
      : undefined;
    
    return {
      summary: realSummary,
      keyPoints: realKeyPoints,
      progress: isSpanish ? 
        'Resumen generado desde el contenido del libro (IA temporalmente no disponible por límite de cuota).' :
        'Summary generated from book content (AI temporarily unavailable due to quota limit).'
    };
  }
  
  // Mensaje específico de cuota excedida
  const quotaMessage = isSpanish 
    ? `# ⚠️ Límite de API Alcanzado

## El servicio de IA ha alcanzado su límite de uso

La API de Google Gemini ha excedido su cuota gratuita. Esto es temporal.

### Soluciones:

1. **Esperar**: La cuota se resetea automáticamente (generalmente cada día)
2. **Usar temas con contenido predefinido**: Algunos temas como "Sistema respiratorio", "La célula", "Fracciones" tienen contenido incorporado
3. **Contactar al administrador**: Para actualizar el plan de la API

### Temas disponibles sin conexión a IA:

**Ciencias Naturales:**
- Sistema respiratorio
- La célula
- Sistema digestivo
- El ciclo del agua
- Microorganismos
- Sistema nervioso
- Sistema óseo y muscular

**Matemáticas:**
- Fracciones
- Números enteros
- Ecuaciones
- Geometría básica

**Lenguaje:**
- Sujeto y predicado
- Tipos de textos
- Comprensión lectora

---

*Por favor, intenta con uno de estos temas o espera a que se resetee la cuota de la API.*`
    : `# ⚠️ API Limit Reached

## The AI service has reached its usage limit

The Google Gemini API has exceeded its free quota. This is temporary.

### Solutions:

1. **Wait**: The quota resets automatically (usually daily)
2. **Use topics with predefined content**: Some topics like "Respiratory system", "The cell", "Fractions" have built-in content
3. **Contact administrator**: To upgrade the API plan

---

*Please try one of the predefined topics or wait for the API quota to reset.*`;

  return {
    summary: quotaMessage,
    keyPoints: undefined,
    progress: isSpanish ? 
      'Límite de cuota de API alcanzado. Intenta más tarde.' :
      'API quota limit reached. Please try again later.'
  };
}

function generateMockSummary(input: GenerateSummaryInput): GenerateSummaryOutput {
  const isSpanish = input.language === 'es';
  
  // If we have PDF content, generate a real summary from it
  if (input.pdfContent && input.pdfContent.length > 100) {
    const realSummary = generateRealSummaryFromContent(input.topic, input.bookTitle, input.pdfContent, isSpanish, input.course);
    const realKeyPoints = input.includeKeyPoints 
      ? extractRealKeyPoints(input.pdfContent, input.topic, isSpanish)
      : undefined;
    
    return {
      summary: realSummary,
      keyPoints: realKeyPoints,
      progress: isSpanish ? 
        'Resumen generado basado en el contenido educativo del tema.' :
        'Summary generated based on educational topic content.'
    };
  }
  
  // Si no hay contenido PDF, generar un mensaje indicando que la IA debe generar el contenido
  // En lugar de un resumen genérico que no aporta valor
  const noContentMessage = isSpanish 
    ? `# Error: No se pudo generar el resumen

## El sistema no pudo acceder a la IA

Para generar un resumen educativo sobre "${input.topic}", el sistema necesita conectarse con el servicio de IA.

### Posibles causas:
- La API key de OpenRouter no está configurada correctamente
- El servicio de IA no está disponible temporalmente
- Error de conexión con el servidor

### Solución:
Por favor, verifica que las variables de entorno estén configuradas correctamente:
- OPENROUTER_API_KEY
- OPENROUTER_BASE_URL
- OPENROUTER_MODEL

---

*Este mensaje aparece porque no hay contenido específico del libro para este tema y no se pudo conectar con la IA.*`
    : `# Error: Could not generate summary

## The system could not access the AI

To generate an educational summary about "${input.topic}", the system needs to connect to the AI service.

### Possible causes:
- The OpenRouter API key is not configured correctly
- The AI service is temporarily unavailable
- Server connection error

### Solution:
Please verify that the environment variables are configured correctly:
- OPENROUTER_API_KEY
- OPENROUTER_BASE_URL
- OPENROUTER_MODEL

---

*This message appears because there is no specific book content for this topic and the AI connection failed.*`;

  return {
    summary: noContentMessage,
    keyPoints: undefined,
    progress: isSpanish ? 
      'Error: No se pudo conectar con el servicio de IA.' :
      'Error: Could not connect to the AI service.'
  };
}

// Generate a REAL summary by processing the actual PDF content
function generateRealSummaryFromContent(topic: string, bookTitle: string, pdfContent: string, isSpanish: boolean, course?: string): string {
  const courseInfo = course ? (isSpanish ? ` para ${course}` : ` for ${course}`) : '';
  
  // Parse and structure the PDF content
  const sections = parsePdfContentIntoSections(pdfContent);
  
  // Build a real educational summary
  if (isSpanish) {
    let summary = `# RESUMEN: ${topic.toUpperCase()}\n\n`;
    summary += `## Información General\n`;
    summary += `**Asignatura:** ${bookTitle}${courseInfo}\n`;
    summary += `**Tema:** ${topic}\n\n`;
    summary += `---\n\n`;
    
    // Introduction based on content
    summary += `## Introducción\n\n`;
    if (sections.introduction) {
      summary += sections.introduction + '\n\n';
    } else {
      summary += `${topic} es un tema fundamental en el estudio de ${bookTitle}. A continuación se presenta el contenido educativo completo basado en el currículo oficial.\n\n`;
    }
    
    // Main content - process each section
    summary += `## Contenido Educativo\n\n`;
    
    for (const section of sections.mainSections) {
      if (section.title) {
        summary += `### ${section.title}\n\n`;
      }
      summary += section.content + '\n\n';
    }
    
    // If there are definitions, add them
    if (sections.definitions.length > 0) {
      summary += `## Conceptos Clave\n\n`;
      for (const def of sections.definitions) {
        summary += `**${def.term}:** ${def.definition}\n\n`;
      }
    }
    
    // If there are examples, add them
    if (sections.examples.length > 0) {
      summary += `## Ejemplos y Aplicaciones\n\n`;
      for (const example of sections.examples) {
        summary += `- ${example}\n`;
      }
      summary += '\n';
    }
    
    // Conclusion
    summary += `## Conclusión\n\n`;
    summary += `El estudio de ${topic} es esencial para comprender los fundamentos de ${bookTitle}. `;
    summary += `Los conceptos presentados proporcionan una base sólida para el aprendizaje continuo en esta área del conocimiento.\n\n`;
    
    summary += `---\n\n`;
    summary += `*Resumen generado a partir del contenido oficial del libro de ${bookTitle}${courseInfo}.*`;
    
    return summary;
  } else {
    let summary = `# SUMMARY: ${topic.toUpperCase()}\n\n`;
    summary += `## General Information\n`;
    summary += `**Subject:** ${bookTitle}${courseInfo}\n`;
    summary += `**Topic:** ${topic}\n\n`;
    summary += `---\n\n`;
    
    summary += `## Introduction\n\n`;
    if (sections.introduction) {
      summary += sections.introduction + '\n\n';
    } else {
      summary += `${topic} is a fundamental topic in the study of ${bookTitle}. Below is the complete educational content based on the official curriculum.\n\n`;
    }
    
    summary += `## Educational Content\n\n`;
    
    for (const section of sections.mainSections) {
      if (section.title) {
        summary += `### ${section.title}\n\n`;
      }
      summary += section.content + '\n\n';
    }
    
    if (sections.definitions.length > 0) {
      summary += `## Key Concepts\n\n`;
      for (const def of sections.definitions) {
        summary += `**${def.term}:** ${def.definition}\n\n`;
      }
    }
    
    if (sections.examples.length > 0) {
      summary += `## Examples and Applications\n\n`;
      for (const example of sections.examples) {
        summary += `- ${example}\n`;
      }
      summary += '\n';
    }
    
    summary += `## Conclusion\n\n`;
    summary += `The study of ${topic} is essential for understanding the fundamentals of ${bookTitle}. `;
    summary += `The concepts presented provide a solid foundation for continued learning in this area of knowledge.\n\n`;
    
    summary += `---\n\n`;
    summary += `*Summary generated from the official ${bookTitle} textbook content${courseInfo}.*`;
    
    return summary;
  }
}

// Parse PDF content into structured sections
function parsePdfContentIntoSections(pdfContent: string): {
  introduction: string;
  mainSections: Array<{ title: string; content: string }>;
  definitions: Array<{ term: string; definition: string }>;
  examples: string[];
} {
  const lines = pdfContent.split('\n');
  const result = {
    introduction: '',
    mainSections: [] as Array<{ title: string; content: string }>,
    definitions: [] as Array<{ term: string; definition: string }>,
    examples: [] as string[]
  };
  
  let currentSection = { title: '', content: '' };
  let isFirstParagraph = true;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Check if it's a section header (numbered or all caps)
    const isHeader = /^(\d+\.?\s+)?[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]+$/.test(line) ||
                     /^#{1,3}\s+/.test(line) ||
                     /^CAPÍTULO|^UNIDAD|^PARTE|^SECCIÓN/i.test(line);
    
    if (isHeader) {
      // Save current section if it has content
      if (currentSection.content.trim()) {
        result.mainSections.push({ ...currentSection });
      }
      currentSection = { title: line.replace(/^#+\s*/, '').replace(/^\d+\.\s*/, ''), content: '' };
      isFirstParagraph = false;
      continue;
    }
    
    // Check for definitions (term: definition or term - definition)
    const defMatch = line.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]+)[:–-]\s*(.+)/);
    if (defMatch && defMatch[2].length > 20) {
      result.definitions.push({ term: defMatch[1].trim(), definition: defMatch[2].trim() });
    }
    
    // Check for examples (starts with - or • or "Ejemplo:")
    if (/^[-•]\s+/.test(line) || /^Ejemplo:/i.test(line)) {
      const example = line.replace(/^[-•]\s*/, '').replace(/^Ejemplo:\s*/i, '');
      if (example.length > 15) {
        result.examples.push(example);
      }
    }
    
    // Add to introduction if it's the first meaningful paragraph
    if (isFirstParagraph && line.length > 50 && !result.introduction) {
      result.introduction = line;
      isFirstParagraph = false;
      continue;
    }
    
    // Add to current section content
    if (currentSection.title || result.mainSections.length === 0) {
      currentSection.content += line + '\n';
    }
  }
  
  // Don't forget the last section
  if (currentSection.content.trim()) {
    result.mainSections.push(currentSection);
  }
  
  // If no sections were found, create one from the whole content
  if (result.mainSections.length === 0) {
    result.mainSections.push({ title: '', content: pdfContent });
  }
  
  return result;
}

// Extract real key points from the PDF content
function extractRealKeyPoints(pdfContent: string, topic: string, isSpanish: boolean): string[] {
  const keyPoints: string[] = [];
  const lines = pdfContent.split('\n').filter(l => l.trim().length > 0);
  
  // Extract definitions and important concepts
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip short lines
    if (trimmed.length < 30 || trimmed.length > 300) continue;
    
    // Look for definition patterns
    if (trimmed.includes(':') && !trimmed.startsWith('-') && keyPoints.length < 10) {
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 3 && colonIndex < trimmed.length - 20) {
        const term = trimmed.substring(0, colonIndex).trim();
        const definition = trimmed.substring(colonIndex + 1).trim();
        if (term.length < 50 && definition.length > 15) {
          keyPoints.push(`**${term}:** ${definition}`);
        }
      }
    }
    
    // Look for bullet points with educational content
    if (/^[-•]/.test(trimmed) && keyPoints.length < 10) {
      const content = trimmed.replace(/^[-•]\s*/, '');
      if (content.length > 25) {
        keyPoints.push(`${content}`);
      }
    }
    
    // Look for numbered items
    if (/^\d+\.\s+[A-Za-z]/.test(trimmed) && keyPoints.length < 10) {
      const content = trimmed.replace(/^\d+\.\s*/, '');
      if (content.length > 25 && content.length < 250) {
        keyPoints.push(`${content}`);
      }
    }
  }
  
  // Ensure we have at least 5 points
  const prefix = isSpanish ? 'Punto clave sobre' : 'Key point about';
  while (keyPoints.length < 5) {
    keyPoints.push(`**${prefix} ${topic}:** ${isSpanish ? 'Concepto fundamental relacionado con el tema de estudio.' : 'Fundamental concept related to the study topic.'}`);
  }
  
  // Return up to 10 unique points
  const uniquePoints = [...new Set(keyPoints)];
  return uniquePoints.slice(0, 10);
}

function generateSpanishMockSummary(topic: string, bookTitle: string): string {
  return `# Resumen: ${topic}

## Introducción

Este resumen aborda el tema "${topic}" basado en el contenido del libro "${bookTitle}". A continuación se presenta un análisis detallado de los conceptos más importantes relacionados con este tema.

## Marco Teórico

El estudio de ${topic} representa uno de los pilares fundamentales en el ámbito académico contemporáneo. Según las fuentes consultadas en "${bookTitle}", este concepto se desarrolla a través de múltiples dimensiones que requieren un análisis sistemático y comprehensivo.

### Definiciones Fundamentales

**${topic}** se define como un conjunto de procesos, conceptos y metodologías que permiten la comprensión profunda de fenómenos específicos. Esta definición abarca tanto los aspectos teóricos como las aplicaciones prácticas que se derivan del estudio sistemático del tema.

### Antecedentes Históricos

La evolución histórica del concepto de ${topic} ha sido marcada por importantes contribuciones de diversos autores y corrientes de pensamiento. Desde las primeras conceptualizaciones hasta las interpretaciones más actuales, se observa una progresión constante en la complejidad y profundidad del análisis.

## Desarrollo del Tema

### Componentes Principales

El análisis de ${topic} se estructura en varios componentes esenciales:

**1. Aspectos Conceptuales**
Los fundamentos conceptuales proporcionan la base teórica necesaria para comprender las implicaciones más amplias del tema. Estos incluyen definiciones precisas, marcos de referencia y modelos explicativos que facilitan la comprensión.

**2. Metodologías de Análisis**
Las diversas metodologías disponibles para el estudio de ${topic} ofrecen herramientas específicas para abordar diferentes aspectos del tema. Cada metodología presenta ventajas particulares según el contexto de aplicación.

**3. Aplicaciones Prácticas**
Las aplicaciones prácticas demuestran la relevancia del tema en contextos reales, proporcionando ejemplos concretos de cómo los conceptos teóricos se traducen en soluciones efectivas.

### Características Distintivas

Entre las características más destacadas de ${topic} se encuentran:

- **Multidisciplinariedad**: El tema incorpora elementos de múltiples disciplinas, creando un enfoque integrador.
- **Dinamismo**: Los conceptos evolucionan constantemente, adaptándose a nuevos contextos y descubrimientos.
- **Aplicabilidad**: Existe una clara conexión entre la teoría y la práctica.
- **Relevancia**: El tema mantiene su importancia en el ámbito académico y profesional.

## Análisis Crítico

### Fortalezas del Enfoque

El tratamiento de ${topic} en "${bookTitle}" presenta varias fortalezas significativas:

**Claridad Conceptual**: Los conceptos se presentan de manera clara y estructurada, facilitando la comprensión progresiva del tema.

**Rigor Metodológico**: Se emplea un enfoque metodológico riguroso que garantiza la validez de los análisis presentados.

**Actualidad**: El contenido refleja los desarrollos más recientes en el campo, manteniendo la relevancia contemporánea.

### Áreas de Desarrollo

No obstante, existen áreas que podrían beneficiarse de mayor desarrollo:

**Integración Interdisciplinaria**: Aunque se aborda la multidisciplinariedad, podría profundizarse la integración entre diferentes campos de conocimiento.

**Casos de Estudio**: La inclusión de más casos de estudio prácticos fortalecería la conexión entre teoría y aplicación.

**Perspectivas Futuras**: Una mayor exploración de las tendencias futuras enriquecería la proyección del tema.

## Implicaciones y Aplicaciones

### Contexto Académico

En el ámbito académico, ${topic} representa una oportunidad para desarrollar nuevas líneas de investigación y profundizar en aspectos específicos que requieren mayor exploración. Las instituciones educativas pueden beneficiarse significativamente de la incorporación sistemática de estos conceptos en sus programas de estudio.

### Contexto Profesional

Desde una perspectiva profesional, la comprensión de ${topic} proporciona herramientas valiosas para la toma de decisiones y la resolución de problemas complejos. Los profesionales que dominen estos conceptos estarán mejor preparados para enfrentar los desafíos contemporáneos.

### Impacto Social

El impacto social de ${topic} se manifiesta a través de múltiples canales, contribuyendo al desarrollo de soluciones innovadoras para problemas sociales complejos. Esta dimensión social refuerza la relevancia del tema más allá del ámbito puramente académico.

## Metodologías de Investigación

### Enfoques Cuantitativos

Los enfoques cuantitativos proporcionan herramientas estadísticas y matemáticas para el análisis de ${topic}. Estos métodos permiten la medición objetiva de variables y la identificación de patrones significativos.

### Enfoques Cualitativos

Los enfoques cualitativos complementan el análisis cuantitativo mediante la exploración profunda de significados, contextos y perspectivas subjetivas relacionadas con ${topic}.

### Metodologías Mixtas

La combinación de enfoques cuantitativos y cualitativos ofrece una perspectiva más completa y robusta para el estudio de ${topic}, aprovechando las fortalezas de ambas tradiciones metodológicas.

## Perspectivas Futuras

### Tendencias Emergentes

Las tendencias emergentes en el estudio de ${topic} sugieren direcciones prometedoras para la investigación futura. Estas incluyen nuevas tecnologías, enfoques interdisciplinarios y metodologías innovadoras.

### Desafíos Anticipados

Los desafíos anticipados requieren preparación y adaptación constante. La identificación temprana de estos desafíos permite el desarrollo de estrategias proactivas.

### Oportunidades de Desarrollo

Las oportunidades de desarrollo se presentan tanto en el ámbito teórico como en el práctico, ofreciendo múltiples vías para la contribución al conocimiento y la aplicación.

## Conclusiones

El análisis de ${topic} basado en "${bookTitle}" revela la complejidad y riqueza de este tema fundamental. La comprensión profunda de sus múltiples dimensiones proporciona una base sólida para futuras exploraciones y aplicaciones.

Las principales conclusiones incluyen:

**Relevancia Contemporánea**: ${topic} mantiene una relevancia significativa en el contexto actual, requiriendo atención continua y desarrollo sistemático.

**Potencial de Aplicación**: Existe un considerable potencial para la aplicación práctica de los conceptos teóricos, especialmente en contextos profesionales y sociales.

**Necesidad de Investigación Continua**: La naturaleza dinámica del tema requiere investigación continua para mantenerse actualizado con los desarrollos emergentes.

**Importancia de la Integración**: La integración de diferentes perspectivas y disciplinas enriquece significativamente la comprensión del tema.

En resumen, ${topic} representa un área de conocimiento vital que merece atención sostenida y desarrollo continuo. Las bases establecidas en "${bookTitle}" proporcionan un punto de partida sólido para futuras exploraciones y contribuciones al campo.`;
}

function generateEnglishMockSummary(topic: string, bookTitle: string): string {
  return `# Summary: ${topic}

## Introduction

This summary addresses the topic "${topic}" based on the content of the book "${bookTitle}". The following presents a detailed analysis of the most important concepts related to this topic.

## Theoretical Framework

The study of ${topic} represents one of the fundamental pillars in the contemporary academic field. According to sources consulted in "${bookTitle}", this concept develops through multiple dimensions that require systematic and comprehensive analysis.

### Fundamental Definitions

**${topic}** is defined as a set of processes, concepts, and methodologies that allow deep understanding of specific phenomena. This definition encompasses both theoretical aspects and practical applications derived from systematic study of the topic.

### Historical Background

The historical evolution of the concept of ${topic} has been marked by important contributions from various authors and schools of thought. From early conceptualizations to current interpretations, there is constant progression in the complexity and depth of analysis.

## Topic Development

### Main Components

The analysis of ${topic} is structured in several essential components:

**1. Conceptual Aspects**
Conceptual foundations provide the theoretical base necessary to understand broader implications of the topic. These include precise definitions, reference frameworks, and explanatory models that facilitate understanding.

**2. Analysis Methodologies**
Various methodologies available for studying ${topic} offer specific tools to address different aspects of the topic. Each methodology presents particular advantages depending on the application context.

**3. Practical Applications**
Practical applications demonstrate the topic's relevance in real contexts, providing concrete examples of how theoretical concepts translate into effective solutions.

### Distinctive Characteristics

Among the most notable characteristics of ${topic} are:

- **Multidisciplinarity**: The topic incorporates elements from multiple disciplines, creating an integrative approach.
- **Dynamism**: Concepts constantly evolve, adapting to new contexts and discoveries.
- **Applicability**: There is a clear connection between theory and practice.
- **Relevance**: The topic maintains its importance in academic and professional spheres.

## Critical Analysis

### Approach Strengths

The treatment of ${topic} in "${bookTitle}" presents several significant strengths:

**Conceptual Clarity**: Concepts are presented clearly and structurally, facilitating progressive understanding of the topic.

**Methodological Rigor**: A rigorous methodological approach is employed that guarantees validity of presented analyses.

**Currency**: Content reflects recent developments in the field, maintaining contemporary relevance.

### Development Areas

However, there are areas that could benefit from greater development:

**Interdisciplinary Integration**: Although multidisciplinarity is addressed, integration between different knowledge fields could be deepened.

**Case Studies**: Including more practical case studies would strengthen the connection between theory and application.

**Future Perspectives**: Greater exploration of future trends would enrich the topic's projection.

## Implications and Applications

### Academic Context

In the academic sphere, ${topic} represents an opportunity to develop new research lines and deepen specific aspects requiring further exploration. Educational institutions can benefit significantly from systematic incorporation of these concepts in their study programs.

### Professional Context

From a professional perspective, understanding ${topic} provides valuable tools for decision-making and solving complex problems. Professionals who master these concepts will be better prepared to face contemporary challenges.

### Social Impact

The social impact of ${topic} manifests through multiple channels, contributing to developing innovative solutions for complex social problems. This social dimension reinforces the topic's relevance beyond the purely academic sphere.

## Research Methodologies

### Quantitative Approaches

Quantitative approaches provide statistical and mathematical tools for analyzing ${topic}. These methods allow objective measurement of variables and identification of significant patterns.

### Qualitative Approaches

Qualitative approaches complement quantitative analysis through deep exploration of meanings, contexts, and subjective perspectives related to ${topic}.

### Mixed Methodologies

Combining quantitative and qualitative approaches offers a more complete and robust perspective for studying ${topic}, leveraging the strengths of both methodological traditions.

## Future Perspectives

### Emerging Trends

Emerging trends in the study of ${topic} suggest promising directions for future research. These include new technologies, interdisciplinary approaches, and innovative methodologies.

### Anticipated Challenges

Anticipated challenges require constant preparation and adaptation. Early identification of these challenges allows development of proactive strategies.

### Development Opportunities

Development opportunities present themselves in both theoretical and practical spheres, offering multiple pathways for contributing to knowledge and application.

## Conclusions

The analysis of ${topic} based on "${bookTitle}" reveals the complexity and richness of this fundamental topic. Deep understanding of its multiple dimensions provides a solid foundation for future explorations and applications.

Main conclusions include:

**Contemporary Relevance**: ${topic} maintains significant relevance in the current context, requiring continuous attention and systematic development.

**Application Potential**: There is considerable potential for practical application of theoretical concepts, especially in professional and social contexts.

**Need for Continuous Research**: The dynamic nature of the topic requires continuous research to stay current with emerging developments.

**Importance of Integration**: Integration of different perspectives and disciplines significantly enriches understanding of the topic.

In summary, ${topic} represents a vital area of knowledge that deserves sustained attention and continuous development. The foundations established in "${bookTitle}" provide a solid starting point for future explorations and contributions to the field.`;
}

function generateSpanishKeyPoints(topic: string): string[] {
  return [
    `**Definición fundamental**: ${topic} se conceptualiza como un conjunto integral de procesos y metodologías esenciales para la comprensión profunda.`,
    `**Marco histórico**: La evolución del concepto ha sido influenciada por múltiples corrientes de pensamiento a lo largo del tiempo.`,
    `**Multidisciplinariedad**: El tema incorpora elementos de diversas disciplinas, creando un enfoque comprehensivo e integrador.`,
    `**Metodologías de análisis**: Existen diferentes enfoques metodológicos, cada uno con ventajas específicas según el contexto de aplicación.`,
    `**Aplicaciones prácticas**: Los conceptos teóricos se traducen efectivamente en soluciones concretas para problemas reales.`,
    `**Relevancia contemporánea**: El tema mantiene una importancia significativa en los ámbitos académico y profesional actuales.`,
    `**Dinamismo conceptual**: Los conceptos evolucionan constantemente, adaptándose a nuevos contextos y descubrimientos emergentes.`,
    `**Rigor metodológico**: Se emplea un enfoque sistemático que garantiza la validez y confiabilidad de los análisis realizados.`,
    `**Impacto social**: El tema contribuye al desarrollo de soluciones innovadoras para desafíos sociales complejos.`,
    `**Perspectivas futuras**: Existen múltiples oportunidades de desarrollo tanto en el ámbito teórico como en el práctico.`
  ];
}

function generateEnglishKeyPoints(topic: string): string[] {
  return [
    `**Fundamental definition**: ${topic} is conceptualized as an integral set of processes and methodologies essential for deep understanding.`,
    `**Historical framework**: The concept's evolution has been influenced by multiple schools of thought throughout time.`,
    `**Multidisciplinarity**: The topic incorporates elements from various disciplines, creating a comprehensive and integrative approach.`,
    `**Analysis methodologies**: Different methodological approaches exist, each with specific advantages depending on the application context.`,
    `**Practical applications**: Theoretical concepts effectively translate into concrete solutions for real problems.`,
    `**Contemporary relevance**: The topic maintains significant importance in current academic and professional spheres.`,
    `**Conceptual dynamism**: Concepts constantly evolve, adapting to new contexts and emerging discoveries.`,
    `**Methodological rigor**: A systematic approach is employed that guarantees validity and reliability of conducted analyses.`,
    `**Social impact**: The topic contributes to developing innovative solutions for complex social challenges.`,
    `**Future perspectives**: Multiple development opportunities exist in both theoretical and practical spheres.`
  ];
}

const generateSummaryPrompt = ai.definePrompt({
  name: 'generateSummaryPrompt',
  input: {
    schema: GenerateSummaryInputSchema,
  },
  output: {
    schema: GenerateSummaryOutputSchema,
  },
  prompt: `Eres un experto educador y creador de contenido pedagógico especializado en el currículo escolar chileno. Tu tarea es crear resúmenes educativos completos y de alta calidad.

INFORMACIÓN DEL RESUMEN A GENERAR:
- Tema: {{{topic}}}
- Asignatura: {{{bookTitle}}}
{{#if course}}- Nivel: {{{course}}}{{/if}}
- Idioma de salida: {{{language}}}

{{#if pdfContent}}
=== CONTENIDO DEL LIBRO DE TEXTO ===
El siguiente es contenido REAL del libro de texto. Basa tu resumen en esta información:

{{{pdfContent}}}

=== FIN DEL CONTENIDO ===

INSTRUCCIONES CUANDO HAY CONTENIDO DEL LIBRO:
- Usa la información específica, definiciones y conceptos del contenido proporcionado
- Incluye los datos, cifras y explicaciones del material fuente
- Estructura el resumen siguiendo las secciones del libro
- Incluye ejemplos específicos mencionados en el texto
{{else}}
NO HAY CONTENIDO ESPECÍFICO DEL LIBRO DISPONIBLE.

INSTRUCCIONES CRÍTICAS CUANDO NO HAY CONTENIDO DEL LIBRO:
⚠️ DEBES generar contenido educativo REAL Y ESPECÍFICO basado en tus conocimientos sobre "{{{topic}}}".

Para "{{{topic}}}", DEBES explicar:
- ¿Qué es exactamente {{{topic}}}? (definición real, no genérica)
- ¿Cuáles son sus componentes o etapas específicas?
- ¿Cómo funciona o cómo se aplica?
- Ejemplos concretos y reales del tema
- Datos y hechos específicos

PROHIBIDO:
❌ Frases genéricas como "es un tema importante para el desarrollo"
❌ "permite comprender aspectos importantes de la asignatura"
❌ "conjunto de conocimientos y habilidades"
❌ Cualquier contenido que podría aplicarse a CUALQUIER tema

OBLIGATORIO:
✓ Contenido que SOLO aplica a "{{{topic}}}"
✓ Definiciones y explicaciones precisas
✓ Ejemplos específicos del tema
✓ Información educativa verificable
{{/if}}

FORMATO DEL RESUMEN:
El idioma de salida es: {{{language}}}
- Si el idioma es "es": Escribe TODO el resumen en ESPAÑOL.
- Si el idioma es "en": Write the ENTIRE summary in ENGLISH.

Crea un resumen educativo sustancial y detallado. El resumen DEBE incluir:

## Estructura requerida:
1. **Introducción**: Qué es {{{topic}}} y por qué es importante
2. **Conceptos Fundamentales**: Definiciones claras y precisas
3. **Desarrollo del Tema**: Explicación detallada con ejemplos
4. **Características/Componentes**: Elementos principales del tema
5. **Ejemplos Prácticos**: Casos concretos y aplicaciones
6. **Importancia**: Relevancia del tema en la vida real
7. **Conclusión**: Síntesis de los puntos principales

## Formato Markdown:
- Usa ## para títulos principales
- Usa ### para subtítulos
- Usa **negrita** para términos importantes
- Usa listas con viñetas para enumerar elementos
- Incluye espaciado adecuado entre secciones

{{#if includeKeyPoints}}
## Puntos Clave:
Después del resumen, proporciona exactamente 10 puntos clave que representen los conceptos más importantes del tema.
Estos puntos deben ser ESPECÍFICOS y EDUCATIVOS, no frases genéricas.
Cada punto debe enseñar algo concreto sobre {{{topic}}}.
{{/if}}

IMPORTANTE: El resumen debe ser EDUCATIVO y ESPECÍFICO. Si el tema es "El ciclo del agua", explica las etapas (evaporación, condensación, precipitación, etc.). Si es "Sujeto y predicado", explica qué son, cómo identificarlos, y da ejemplos de oraciones.
`,
});

const generateSummaryFlow = ai.defineFlow(
  {
    name: 'generateSummaryFlow',
    inputSchema: GenerateSummaryInputSchema,
    outputSchema: GenerateSummaryOutputSchema,
  },
  async input => {
    const {output} = await generateSummaryPrompt(input);
    if (!output) {
      throw new Error('Failed to generate summary output.');
    }
    const progressMessage = `Generated a detailed summary for topic "${input.topic}" from book "${input.bookTitle}" in ${input.language}.`;
    return {
      summary: output.summary || '',
      keyPoints: output.keyPoints || (input.includeKeyPoints ? [] : undefined),
      progress: progressMessage,
    };
  }
);

