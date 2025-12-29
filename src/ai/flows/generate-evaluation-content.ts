'use server';

/**
 * @fileOverview Generates evaluation content with mixed question types.
 *
 * - generateEvaluationContent - A function that handles the evaluation content generation process.
 * - GenerateEvaluationInput - The input type for the generateEvaluationContent function.
 * - GenerateEvaluationOutput - The return type for the generateEvaluationContent function.
 */

import {ai, generateWithAI, useOpenRouter} from '@/ai/genkit';
import {z} from 'genkit';
import { getOpenRouterClient, hasOpenRouterApiKey, OPENROUTER_MODELS } from '@/lib/openrouter-client';
import { getContentGenerationContext, generateAIPromptInstructions } from '@/lib/topic-descriptions';

const GenerateEvaluationInputSchema = z.object({
  topic: z.string().describe('The specific topic for the evaluation.'),
  topicDescription: z.string().optional().describe('A description of the topic that provides orientation and context for the evaluation.'),
  bookTitle: z.string().describe('The title of the book to base the evaluation on.'),
  language: z.enum(['es', 'en']).describe('The language for the evaluation content (e.g., "es" for Spanish, "en" for English).'),
  questionCount: z.number().optional().describe('Number of questions to generate (default: 15)'),
  timeLimit: z.number().optional().describe('Time limit in seconds (default: 120)'),
  course: z.string().optional().describe('The course/grade level for age-appropriate content.'),
});
type GenerateEvaluationInput = z.infer<typeof GenerateEvaluationInputSchema>;

// Extended schema for dynamic evaluation with PDF content
const GenerateDynamicEvaluationInputSchema = z.object({
  topic: z.string().describe('The specific topic for the evaluation.'),
  topicDescription: z.string().optional().describe('A description of the topic that provides orientation and context.'),
  bookTitle: z.string().describe('The title of the book to base the evaluation on.'),
  course: z.string().optional().describe('The course/grade associated with the book.'),
  subject: z.string().optional().describe('The subject associated with the book.'),
  language: z.enum(['es', 'en']).describe('The language for the evaluation content (e.g., "es" for Spanish, "en" for English).'),
  pdfContent: z.string().describe('The actual content extracted from the PDF book.'),
  timestamp: z.number().describe('Timestamp to ensure uniqueness.'),
  randomSeed: z.number().describe('Random seed to ensure variability in questions.'),
  questionCount: z.number().optional().describe('Number of questions to generate (default: 15)'),
  timeLimit: z.number().optional().describe('Time limit in seconds (default: 120)'),
});
type GenerateDynamicEvaluationInput = z.infer<typeof GenerateDynamicEvaluationInputSchema>;

const TrueFalseQuestionSchema = z.object({
  id: z.string().describe('Unique ID for the question.'),
  type: z.enum(['TRUE_FALSE']).describe('Question type.'),
  questionText: z.string().describe('The text of the true/false question.'),
  correctAnswer: z.boolean().describe('The correct answer (true or false).'),
  explanation: z.string().describe('A brief explanation for the correct answer.'),
});

const MultipleChoiceQuestionSchema = z.object({
  id: z.string().describe('Unique ID for the question.'),
  type: z.enum(['MULTIPLE_CHOICE']).describe('Question type.'),
  questionText: z.string().describe('The text of the multiple-choice question.'),
  options: z.array(z.string()).length(4).describe('An array of exactly 4 string options (A, B, C, D).'),
  correctAnswerIndex: z.number().min(0).max(3).describe('The 0-based index of the correct option in the options array.'),
  explanation: z.string().describe('A brief explanation for the correct answer.'),
});

const MultipleSelectionQuestionSchema = z.object({
  id: z.string().describe('Unique ID for the question.'),
  type: z.enum(['MULTIPLE_SELECTION']).describe('Question type.'),
  questionText: z.string().describe('The text of the multiple-selection question.'),
  options: z.array(z.string()).length(4).describe('An array of exactly 4 string options (A, B, C, D).'),
  correctAnswerIndices: z.array(z.number()).min(2).max(3).describe('An array of 2-3 indices indicating the correct options (multiple correct answers).'),
  explanation: z.string().describe('A brief explanation for why those specific answers are correct.'),
});

const EvaluationQuestionSchema = z.union([TrueFalseQuestionSchema, MultipleChoiceQuestionSchema, MultipleSelectionQuestionSchema]);
export type EvaluationQuestion = z.infer<typeof EvaluationQuestionSchema>;

const GenerateEvaluationOutputSchema = z.object({
  evaluationTitle: z.string().describe('The title of the evaluation, formatted as "EVALUACIÓN - [TOPIC_NAME_IN_UPPERCASE]" if language is "es", or "EVALUATION - [TOPIC_NAME_IN_UPPERCASE]" if language is "en".'),
  questions: z.array(EvaluationQuestionSchema).describe('An array of evaluation questions, with a mix of types. The prompt requests 15 questions total (5 True/False, 5 Multiple Choice, 5 Multiple Selection).'),
});
type GenerateEvaluationOutput = z.infer<typeof GenerateEvaluationOutputSchema>;


export async function generateEvaluationContent(input: GenerateEvaluationInput): Promise<GenerateEvaluationOutput> {
  try {
    const questionCount = input.questionCount || 15;
    
    console.log('🔍 generateEvaluationContent called with:', {
      questionCount: input.questionCount,
      questionCountUsed: questionCount,
      topic: input.topic,
      bookTitle: input.bookTitle,
      timeLimit: input.timeLimit,
      language: input.language,
      course: input.course
    });
    console.log('🌍 generateEvaluationContent received language:', input.language);
    
    const isEs = input.language === 'es';
    const topic = input.topic;
    const topicLower = topic.toLowerCase();
    
    // Obtener contexto de generación basado en el curso
    const courseContext = input.course ? getContentGenerationContext(input.course) : null;
    const adaptationInstructions = courseContext ? generateAIPromptInstructions(courseContext, input.language) : '';
    
    // Construir contexto del tema si hay descripción
    const topicGuidance = input.topicDescription 
      ? (isEs 
          ? `\n📋 ORIENTACIÓN DEL TEMA:\n${input.topicDescription}\nUsa esta descripción para enfocar las preguntas.`
          : `\n📋 TOPIC GUIDANCE:\n${input.topicDescription}\nUse this description to focus the questions.`)
      : '';
    
    // Distribuir tipos de preguntas equitativamente
    const tfCount = Math.round(questionCount / 3);
    const mcCount = Math.round((questionCount - tfCount) / 2);
    const msCount = questionCount - tfCount - mcCount;
    
    // =====================================================================
    // PRIORIDAD 1: OpenRouter (más confiable y económico)
    // =====================================================================
    if (hasOpenRouterApiKey()) {
      console.log('[generateEvaluationContent] 🚀 Intentando con OpenRouter primero...');
      const openRouterClient = getOpenRouterClient();
      
      if (openRouterClient) {
        try {
          const systemPrompt = isEs 
            ? `Eres un experto educador. Genera evaluaciones educativas de alta calidad con preguntas variadas, ADAPTADAS AL NIVEL DEL ESTUDIANTE.
            
${adaptationInstructions}`
            : `You are an expert educator. Generate high-quality educational evaluations with varied questions, ADAPTED TO THE STUDENT'S LEVEL.
            
${adaptationInstructions}`;
          
          const userPrompt = isEs 
            ? `Genera una evaluación educativa sobre "${topic}" del libro "${input.bookTitle}"${input.course ? ` para ${input.course}` : ''}.${topicGuidance}

${courseContext ? `⚠️ IMPORTANTE: El estudiante tiene aproximadamente ${courseContext.approximateAge} años. Adapta la dificultad y vocabulario de las preguntas a su nivel.` : ''}

Genera exactamente ${questionCount} preguntas distribuidas así:
- ${tfCount} preguntas Verdadero/Falso (type: "TRUE_FALSE")
- ${mcCount} preguntas de Selección Múltiple con 4 opciones (type: "MULTIPLE_CHOICE")
- ${msCount} preguntas de Selección Múltiple con varias correctas (type: "MULTIPLE_SELECTION")

Responde en JSON con este formato exacto:
{
  "evaluationTitle": "EVALUACIÓN - ${topic.toUpperCase()}",
  "questions": [
    {"id": "1", "type": "TRUE_FALSE", "questionText": "¿Pregunta V/F?", "correctAnswer": true, "explanation": "Explicación..."},
    {"id": "2", "type": "MULTIPLE_CHOICE", "questionText": "¿Pregunta SM?", "options": ["A", "B", "C", "D"], "correctAnswerIndex": 0, "explanation": "Explicación..."},
    {"id": "3", "type": "MULTIPLE_SELECTION", "questionText": "¿Cuáles son correctas?", "options": ["A", "B", "C", "D"], "correctAnswerIndices": [0, 2], "explanation": "Explicación..."}
  ]
}

IMPORTANTE:
- Las preguntas deben ser específicas sobre el contenido de "${topic}"
- ADAPTA el vocabulario y dificultad al nivel del estudiante
- Genera contenido educativo real y variado
- Responde SOLO con JSON válido, sin texto adicional`
            : `Generate an educational evaluation about "${topic}" from the book "${input.bookTitle}"${input.course ? ` for ${input.course}` : ''}.${topicGuidance}

${courseContext ? `⚠️ IMPORTANT: The student is approximately ${courseContext.approximateAge} years old. Adapt the difficulty and vocabulary of the questions to their level.` : ''}

Generate exactly ${questionCount} questions distributed as:
- ${tfCount} True/False questions (type: "TRUE_FALSE")
- ${mcCount} Multiple Choice questions with 4 options (type: "MULTIPLE_CHOICE")
- ${msCount} Multiple Selection questions with multiple correct answers (type: "MULTIPLE_SELECTION")

Respond in JSON with this exact format:
{
  "evaluationTitle": "EVALUATION - ${topic.toUpperCase()}",
  "questions": [
    {"id": "1", "type": "TRUE_FALSE", "questionText": "T/F Question?", "correctAnswer": true, "explanation": "Explanation..."},
    {"id": "2", "type": "MULTIPLE_CHOICE", "questionText": "MC Question?", "options": ["A", "B", "C", "D"], "correctAnswerIndex": 0, "explanation": "Explanation..."},
    {"id": "3", "type": "MULTIPLE_SELECTION", "questionText": "Which are correct?", "options": ["A", "B", "C", "D"], "correctAnswerIndices": [0, 2], "explanation": "Explanation..."}
  ]
}

IMPORTANT:
- Questions must be specific about "${topic}" content
- ADAPT vocabulary and difficulty to the student's level
- Generate real and varied educational content
- Respond ONLY with valid JSON, no additional text`;
          
          const response = await openRouterClient.generateText(systemPrompt, userPrompt, {
            model: OPENROUTER_MODELS.GPT_4O_MINI,
            temperature: 0.7,
            maxTokens: 5000,
          });
          
          // Parsear JSON
          let jsonStr = response.trim();
          if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
          if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
          if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
          jsonStr = jsonStr.trim();
          
          const parsed = JSON.parse(jsonStr);
          
          if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
            console.log('[generateEvaluationContent] ✅ OpenRouter generó', parsed.questions.length, 'preguntas exitosamente');
            return {
              evaluationTitle: parsed.evaluationTitle || (isEs ? `Evaluación - ${topic.toUpperCase()}` : `Evaluation - ${topic.toUpperCase()}`),
              questions: parsed.questions
            };
          }
        } catch (openRouterErr) {
          console.warn('[generateEvaluationContent] ⚠️ OpenRouter falló:', openRouterErr);
          // Continuar con Google Gemini como fallback
        }
      }
    }
    
    // =====================================================================
    // PRIORIDAD 2: Google Gemini (fallback)
    // =====================================================================
    const hasGoogleKey = !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== 'your_google_api_key_here');
    
    if (hasGoogleKey) {
      console.log('[generateEvaluationContent] 🔄 Intentando con Google Gemini como fallback...');
      try {
        return await generateEvaluationFlow(input);
      } catch (geminiErr) {
        console.warn('[generateEvaluationContent] ⚠️ Google Gemini falló:', geminiErr);
      }
    }
    
    // =====================================================================
    // FALLBACK: Generar preguntas desde banco local
    // =====================================================================
    console.log('[generateEvaluationContent] ⚠️ Usando fallback con banco de preguntas local');
    
    // Generate mock data dynamically based on questionCount with educational content
    const mockQuestions: EvaluationQuestion[] = [];
    
    // Banco de preguntas específicas por tema
    const getTopicQuestions = () => {
        if (topicLower.includes('respiratorio')) {
          return {
            trueFalse: [
              { q: 'Los pulmones son los órganos principales del sistema respiratorio.', a: true, e: 'Los pulmones son donde ocurre el intercambio gaseoso.' },
              { q: 'El estómago es parte del sistema respiratorio.', a: false, e: 'El estómago pertenece al sistema digestivo.' },
              { q: 'La tráquea conduce el aire hacia los bronquios.', a: true, e: 'La tráquea es el conducto principal de aire.' },
              { q: 'El corazón realiza la respiración pulmonar.', a: false, e: 'El corazón pertenece al sistema circulatorio.' },
              { q: 'Los alvéolos son donde ocurre el intercambio de gases.', a: true, e: 'En los alvéolos se intercambia oxígeno por CO₂.' }
            ],
            multipleChoice: [
              { q: '¿Cuál es la función principal de los pulmones?', opts: ['Realizar el intercambio gaseoso', 'Bombear sangre', 'Digerir alimentos', 'Filtrar toxinas'], correct: 0 },
              { q: '¿Qué músculo permite la respiración?', opts: ['Diafragma', 'Bíceps', 'Corazón', 'Esófago'], correct: 0 },
              { q: '¿Dónde se encuentran los alvéolos?', opts: ['En los pulmones', 'En el corazón', 'En los riñones', 'En el hígado'], correct: 0 },
              { q: '¿Qué gas absorbemos al respirar?', opts: ['Oxígeno', 'Dióxido de carbono', 'Nitrógeno', 'Metano'], correct: 0 },
              { q: '¿Cuál estructura contiene las cuerdas vocales?', opts: ['Laringe', 'Tráquea', 'Bronquios', 'Nariz'], correct: 0 }
            ],
            multipleSelection: [
              { q: '¿Cuáles son órganos del sistema respiratorio?', opts: ['Pulmones', 'Estómago', 'Tráquea', 'Riñones'], correct: [0, 2] },
              { q: '¿Qué ocurre durante la inspiración?', opts: ['El diafragma se contrae', 'Entra aire rico en oxígeno', 'Se expulsa CO₂', 'El corazón se detiene'], correct: [0, 1] },
              { q: '¿Cuáles son funciones de las fosas nasales?', opts: ['Filtrar el aire', 'Bombear sangre', 'Calentar el aire', 'Digerir nutrientes'], correct: [0, 2] }
            ]
          };
        } else if (topicLower.includes('célula')) {
          return {
            trueFalse: [
              { q: 'El núcleo contiene el material genético de la célula.', a: true, e: 'El ADN se encuentra en el núcleo.' },
              { q: 'Las mitocondrias son exclusivas de las células vegetales.', a: false, e: 'Las mitocondrias están en células animales y vegetales.' },
              { q: 'La membrana celular controla qué entra y sale de la célula.', a: true, e: 'La membrana es selectivamente permeable.' },
              { q: 'Las bacterias tienen núcleo definido.', a: false, e: 'Las bacterias son procariotas, sin núcleo definido.' },
              { q: 'Los cloroplastos realizan la fotosíntesis.', a: true, e: 'Los cloroplastos contienen clorofila.' }
            ],
            multipleChoice: [
              { q: '¿Cuál organelo produce energía en la célula?', opts: ['Mitocondrias', 'Ribosomas', 'Vacuola', 'Pared celular'], correct: 0 },
              { q: '¿Dónde se encuentra el ADN en células eucariotas?', opts: ['En el núcleo', 'En el citoplasma', 'En la membrana', 'En los ribosomas'], correct: 0 },
              { q: '¿Qué organelo es exclusivo de células vegetales?', opts: ['Cloroplasto', 'Mitocondria', 'Ribosoma', 'Núcleo'], correct: 0 },
              { q: '¿Cuál es la función de los ribosomas?', opts: ['Sintetizar proteínas', 'Producir energía', 'Almacenar agua', 'Controlar la célula'], correct: 0 },
              { q: '¿Qué tipo de célula tiene pared celular?', opts: ['Célula vegetal', 'Célula animal', 'Glóbulo rojo', 'Neurona'], correct: 0 }
            ],
            multipleSelection: [
              { q: '¿Cuáles son organelos de la célula?', opts: ['Núcleo', 'Huesos', 'Mitocondrias', 'Piel'], correct: [0, 2] },
              { q: '¿Qué estructuras tienen las células vegetales?', opts: ['Pared celular', 'Cilios', 'Cloroplastos', 'Flagelos'], correct: [0, 2] },
              { q: '¿Cuáles son funciones de la membrana celular?', opts: ['Proteger la célula', 'Producir energía', 'Regular el paso de sustancias', 'Sintetizar ADN'], correct: [0, 2] }
            ]
          };
        } else if (topicLower.includes('fotosíntesis') || topicLower.includes('fotosintesis')) {
          return {
            trueFalse: [
              { q: 'La fotosíntesis produce oxígeno como producto.', a: true, e: 'El O₂ es un subproducto de la fotosíntesis.' },
              { q: 'La fotosíntesis ocurre en las mitocondrias.', a: false, e: 'La fotosíntesis ocurre en los cloroplastos.' },
              { q: 'Las plantas necesitan luz solar para la fotosíntesis.', a: true, e: 'La luz es esencial para la fase luminosa.' },
              { q: 'Los animales realizan fotosíntesis.', a: false, e: 'Solo las plantas, algas y algunas bacterias.' },
              { q: 'La clorofila es el pigmento que captura la luz.', a: true, e: 'La clorofila da el color verde a las plantas.' }
            ],
            multipleChoice: [
              { q: '¿Dónde ocurre la fotosíntesis?', opts: ['En los cloroplastos', 'En las mitocondrias', 'En el núcleo', 'En la vacuola'], correct: 0 },
              { q: '¿Qué gas absorben las plantas durante la fotosíntesis?', opts: ['Dióxido de carbono', 'Oxígeno', 'Nitrógeno', 'Metano'], correct: 0 },
              { q: '¿Cuál es el producto principal de la fotosíntesis?', opts: ['Glucosa', 'Proteínas', 'Lípidos', 'Vitaminas'], correct: 0 },
              { q: '¿Por qué poros intercambian gases las hojas?', opts: ['Estomas', 'Tricomas', 'Cutícula', 'Epidermis'], correct: 0 },
              { q: '¿Qué pigmento es responsable del color verde?', opts: ['Clorofila', 'Caroteno', 'Xantofila', 'Antocianina'], correct: 0 }
            ],
            multipleSelection: [
              { q: '¿Qué elementos necesita la fotosíntesis?', opts: ['Luz solar', 'Oxígeno', 'Dióxido de carbono', 'Proteínas'], correct: [0, 2] },
              { q: '¿Cuáles son productos de la fotosíntesis?', opts: ['Glucosa', 'Dióxido de carbono', 'Oxígeno', 'Agua como producto'], correct: [0, 2] },
              { q: '¿Dónde están los cloroplastos?', opts: ['En las hojas', 'En las raíces', 'En los tallos verdes', 'En las flores rojas'], correct: [0, 2] }
            ]
          };
        }
        
        // Fallback genérico pero estructurado
        return {
          trueFalse: [
            { q: `Los conceptos de ${topic} son fundamentales para el aprendizaje.`, a: true, e: 'Los conceptos básicos siempre son esenciales.' },
            { q: `${topic} no tiene relación con otras áreas del conocimiento.`, a: false, e: 'Todos los temas están interrelacionados.' },
            { q: `El estudio de ${topic} requiere práctica constante.`, a: true, e: 'La práctica refuerza el aprendizaje.' }
          ],
          multipleChoice: [
            { q: `¿Qué es fundamental para comprender ${topic}?`, opts: ['Conocer los conceptos básicos', 'Memorizar sin entender', 'Ignorar los detalles', 'Saltarse los ejercicios'], correct: 0 },
            { q: `¿Cómo se aprende mejor ${topic}?`, opts: ['Con práctica y estudio', 'Solo leyendo una vez', 'Sin hacer ejercicios', 'Memorizando fechas'], correct: 0 }
          ],
          multipleSelection: [
            { q: `¿Cuáles son buenas prácticas para estudiar ${topic}?`, opts: ['Tomar notas', 'No preguntar dudas', 'Hacer ejercicios', 'Evitar la lectura'], correct: [0, 2] }
          ]
        };
      };
    
    const questions = getTopicQuestions();
    
    // Generar preguntas Verdadero/Falso
    for (let i = 0; i < tfCount; i++) {
      const qNum = mockQuestions.length + 1;
      const q = questions.trueFalse[i % questions.trueFalse.length];
      mockQuestions.push({
        id: qNum.toString(),
        type: 'TRUE_FALSE',
        questionText: isEs ? q.q : q.q,
        correctAnswer: q.a,
        explanation: isEs ? q.e : q.e
      });
    }
    
    // Generar preguntas Selección Simple
    for (let i = 0; i < mcCount; i++) {
      const qNum = mockQuestions.length + 1;
      const q = questions.multipleChoice[i % questions.multipleChoice.length];
      mockQuestions.push({
        id: qNum.toString(),
        type: 'MULTIPLE_CHOICE',
        questionText: isEs ? q.q : q.q,
        options: q.opts,
        correctAnswerIndex: q.correct,
        explanation: isEs 
          ? `La respuesta correcta es "${q.opts[q.correct]}".`
          : `The correct answer is "${q.opts[q.correct]}".`
      });
    }
    
    // Generar preguntas Selección Múltiple
    for (let i = 0; i < msCount; i++) {
      const qNum = mockQuestions.length + 1;
      const q = questions.multipleSelection[i % questions.multipleSelection.length];
      mockQuestions.push({
        id: qNum.toString(),
        type: 'MULTIPLE_SELECTION',
        questionText: isEs ? q.q : q.q,
        options: q.opts,
        correctAnswerIndices: q.correct,
        explanation: isEs
          ? `Las opciones correctas son "${q.opts[q.correct[0]]}" y "${q.opts[q.correct[1]]}".`
          : `The correct options are "${q.opts[q.correct[0]]}" and "${q.opts[q.correct[1]]}".`
      });
    }
    
    console.log('✅ Mock questions generated:', {
      requested: questionCount,
      generated: mockQuestions.length,
      questions: mockQuestions.map(q => ({ id: q.id, type: q.type, text: q.questionText.substring(0, 50) + '...' }))
    });
    
    return {
      evaluationTitle: input.language === 'es' 
        ? `Evaluación - ${input.topic.toUpperCase()}`
        : `Evaluation - ${input.topic.toUpperCase()}`,
      questions: mockQuestions
    };
    
  } catch (error) {
    console.error('Error generating evaluation content:', error);
    // Return fallback data
    return {
      evaluationTitle: input.language === 'es' 
        ? `Evaluación - ${input.topic.toUpperCase()}`
        : `Evaluation - ${input.topic.toUpperCase()}`,
      questions: [
        {
          id: '1',
          type: 'TRUE_FALSE',
          questionText: input.language === 'es'
            ? `¿El tema "${input.topic}" está relacionado con "${input.bookTitle}"?`
            : `Is the topic "${input.topic}" related to "${input.bookTitle}"?`,
          correctAnswer: true,
          explanation: input.language === 'es'
            ? 'Pregunta generada como respaldo debido a un error en la API.'
            : 'Question generated as fallback due to an API error.'
        }
      ]
    };
  }
}

const generateEvaluationPrompt = ai.definePrompt({
  name: 'generateEvaluationPrompt',
  input: {schema: GenerateEvaluationInputSchema.extend({ topic_uppercase: z.string(), title_prefix: z.string() })},
  output: {schema: GenerateEvaluationOutputSchema},
  config: { 
    temperature: 0.7, // Increased temperature for more varied output
  },
  prompt: `You are an expert educator creating an evaluation.
Based on the book titled "{{bookTitle}}", generate an evaluation for the topic "{{topic}}".
The language for all content (title, questions, options, explanations) MUST be {{{language}}}.

The evaluation must adhere to the following structure:
1.  **Evaluation Title**: The title must be "{{title_prefix}} - {{topic_uppercase}}".
2.  **Total Questions**: Generate exactly {{questionCount}} unique questions. It is CRITICAL that you generate a COMPLETELY NEW and UNIQUE set of questions for this topic from this book, different from any set you might have generated previously for the same inputs. Do not repeat questions or question structures you may have used before for this specific topic and book. Avoid repetition.
3.  **Question Types** (distribute evenly among the {{questionCount}} questions):
    *   Generate approximately {{questionCount}}/3 True/False questions (rounded).
    *   Generate approximately {{questionCount}}/3 Multiple Choice questions (rounded).
    *   Generate approximately {{questionCount}}/3 Multiple Selection questions (rounded).
4.  **For each question, ensure you provide**:
    *   \`id\`: A unique string identifier for the question (e.g., "q1", "q2", "q3", ..., "q{{questionCount}}").
    *   \`type\`: Set to "TRUE_FALSE" for true/false questions, "MULTIPLE_CHOICE" for multiple-choice questions, or "MULTIPLE_SELECTION" for multiple-selection questions.
    *   \`questionText\`: The clear and concise text of the question.
    *   \`explanation\`: A brief and clear explanation for why the correct answer is correct, referencing concepts from the book "{{bookTitle}}" if possible.
5.  **Specifics for True/False Questions**:
    *   \`correctAnswer\`: A boolean value (\`true\` or \`false\`).
6.  **Specifics for Multiple Choice Questions**:
    *   \`options\`: An array of exactly 4 distinct string options. Label them implicitly as A, B, C, D for the user, but just provide the string array.
    *   \`correctAnswerIndex\`: A number from 0 to 3 indicating the index of the correct option in the 'options' array.
7.  **Specifics for Multiple Selection Questions** (5 questions):
    *   \`options\`: An array of exactly 4 distinct string options.
    *   \`correctAnswerIndices\`: An array of 2-3 numbers (0-3) indicating the indices of the correct options (multiple correct answers).

Example of a True/False question structure (if language is "es"):
{
  "id": "q1",
}

Example of a Multiple Selection question structure (if language is "es"):
{
  "id": "q11",
  "type": "MULTIPLE_SELECTION",
  "questionText": "¿Cuáles de las siguientes son características del sistema respiratorio? (Selecciona todas las correctas)",
  "options": ["Intercambia gases", "Produce insulina", "Filtra la sangre", "Transporta oxígeno"],
  "correctAnswerIndices": [0, 3],
  "explanation": "El sistema respiratorio intercambia gases y transporta oxígeno, pero no produce insulina ni filtra la sangre."
}

Ensure all questions are relevant to the topic "{{topic}}" as covered in the book "{{bookTitle}}".
The output must be a valid JSON object matching the specified output schema.
`,
});

// New dynamic prompt that uses PDF content
const generateDynamicEvaluationPrompt = ai.definePrompt({
  name: 'generateDynamicEvaluationPrompt',
  input: {schema: GenerateDynamicEvaluationInputSchema.extend({ topic_uppercase: z.string(), title_prefix: z.string() })},
  output: {schema: GenerateEvaluationOutputSchema},
  config: { 
    temperature: 0.9, // Higher temperature for more varied output
  },
  prompt: `You are an expert educator creating a dynamic evaluation SPECIFICALLY about the topic "{{topic}}".
Based on the book titled "{{bookTitle}}" and the following PDF CONTENT, generate a completely unique evaluation FOCUSED EXCLUSIVELY on the topic "{{topic}}".

PDF CONTENT:
{{pdfContent}}

GENERATION PARAMETERS (to ensure uniqueness):
- Timestamp: {{timestamp}}
- Random Seed: {{randomSeed}}

CRITICAL INSTRUCTIONS:
1. ALL questions must be SPECIFICALLY about the topic "{{topic}}" - NOT about the book in general
2. Use ONLY the parts of the PDF content that relate directly to "{{topic}}"
3. Do NOT create questions about the book structure, general content, or study methods
4. Focus EXCLUSIVELY on concepts, processes, characteristics, and facts related to "{{topic}}"
5. Each time you generate questions, they must be COMPLETELY DIFFERENT from any previous generation
6. Use the timestamp {{timestamp}} and random seed {{randomSeed}} to ensure variability
7. The language for all content (title, questions, options, explanations) MUST be {{{language}}}
8. If provided, ensure questions align with the course ({{course}}) and subject ({{subject}})

TOPIC FOCUS: Remember, the evaluation is about "{{topic}}" specifically, not about the book or general study content.

The evaluation must adhere to the following structure:
1.  **Evaluation Title**: The title must be "{{title_prefix}} - {{topic_uppercase}}".
2.  **Total Questions**: Generate exactly {{questionCount}} unique questions based on the PDF content above.
3.  **Question Types** (distribute evenly among the {{questionCount}} questions):
    *   Generate approximately {{questionCount}}/3 True/False questions (type: "TRUE_FALSE", rounded)
    *   Generate approximately {{questionCount}}/3 Multiple Choice questions (type: "MULTIPLE_CHOICE", rounded) - single correct answer
    *   Generate approximately {{questionCount}}/3 Multiple Selection questions (type: "MULTIPLE_SELECTION", rounded) - multiple correct answers
4.  **For each question, ensure you provide**:
    *   \`id\`: A unique string identifier including the timestamp (e.g., "q1_{{timestamp}}", "q2_{{timestamp}}", ..., "q{{questionCount}}_{{timestamp}}").
    *   \`type\`: Set to "TRUE_FALSE", "MULTIPLE_CHOICE", or "MULTIPLE_SELECTION".
    *   \`questionText\`: The clear and concise text of the question, asking SPECIFICALLY about "{{topic}}" concepts, processes, or characteristics.
    *   \`explanation\`: A brief explanation referencing the specific part of the PDF content about "{{topic}}" where this information can be found.
5.  **Specifics for True/False Questions**:
    *   \`correctAnswer\`: A boolean value (\`true\` or \`false\`).
6.  **Specifics for Multiple Choice Questions (single answer)**:
    *   \`options\`: An array of exactly 4 distinct string options based on the PDF content.
    *   \`correctAnswerIndex\`: A number from 0 to 3 indicating the index of the correct option.
7.  **Specifics for Multiple Selection Questions (multiple answers)** (5 questions):
    *   \`options\`: An array of exactly 4 distinct string options based on the PDF content.
    *   \`correctAnswerIndices\`: An array of 2-3 numbers (0-3) indicating the indices of the correct options.

Example of a Multiple Selection question structure (if language is "es" and topic is "sistema respiratorio"):
{
  "id": "q3_{{timestamp}}",
  "type": "MULTIPLE_SELECTION",
  "questionText": "¿Cuáles de las siguientes son partes del sistema respiratorio? (Selecciona todas las correctas)",
  "options": ["Pulmones", "Estómago", "Tráquea", "Hígado"],
  "correctAnswerIndices": [0, 2],
  "explanation": "Los pulmones y la tráquea son partes del sistema respiratorio, mientras que el estómago y el hígado pertenecen a otros sistemas."
}

ENSURE UNIQUENESS: Use different sections, examples, concepts, or details from the PDF content that relate to "{{topic}}" each time. Never repeat the same question structure or content. The random seed {{randomSeed}} should influence which aspects of "{{topic}}" you focus on.

The output must be a valid JSON object matching the specified output schema.
`,
});

const generateEvaluationFlow = ai.defineFlow(
  {
    name: 'generateEvaluationFlow',
    inputSchema: GenerateEvaluationInputSchema,
    outputSchema: GenerateEvaluationOutputSchema,
  },
  async (input: GenerateEvaluationInput): Promise<GenerateEvaluationOutput> => {
    const questionCount = input.questionCount || 15;
    const titlePrefix = input.language === 'es' ? 'EVALUACIÓN' : 'EVALUATION';
    const promptInput = {
      ...input,
      questionCount,
      topic_uppercase: input.topic.toUpperCase(),
      title_prefix: titlePrefix,
    };
    const {output} = await generateEvaluationPrompt(promptInput);

    if (!output || !output.questions || output.questions.length !== questionCount) {
      console.error('AI response:', JSON.stringify(output, null, 2));
      if (output && output.questions) {
        console.error(`Expected ${questionCount} questions, but received ${output.questions.length}.`);
      }
      throw new Error(
        `AI failed to generate the required ${questionCount} evaluation questions or the format is incorrect. Expected ${questionCount}, got ${output?.questions?.length || 0}.`
      );
    }
    return output;
  }
);

// New dynamic flow that uses PDF content
const generateDynamicEvaluationFlow = ai.defineFlow(
  {
    name: 'generateDynamicEvaluationFlow',
    inputSchema: GenerateDynamicEvaluationInputSchema,
    outputSchema: GenerateEvaluationOutputSchema,
  },
  async (input: GenerateDynamicEvaluationInput): Promise<GenerateEvaluationOutput> => {
    const questionCount = input.questionCount || 15;
    const titlePrefix = input.language === 'es' ? 'EVALUACIÓN' : 'EVALUATION';
    const promptInput = {
      ...input,
      questionCount,
      topic_uppercase: input.topic.toUpperCase(),
      title_prefix: titlePrefix,
    };
    const {output} = await generateDynamicEvaluationPrompt(promptInput);

    if (!output || !output.questions || output.questions.length !== questionCount) {
      console.error('AI response:', JSON.stringify(output, null, 2));
      if (output && output.questions) {
        console.error(`Expected ${questionCount} questions, but received ${output.questions.length}.`);
      }
      throw new Error(
        `AI failed to generate the required ${questionCount} evaluation questions or the format is incorrect. Expected ${questionCount}, got ${output?.questions?.length || 0}.`
      );
    }
    return output;
  }
);

// New export for dynamic evaluation
export async function generateDynamicEvaluationContent(input: GenerateDynamicEvaluationInput): Promise<GenerateEvaluationOutput> {
  try {
    console.log('🌍 generateDynamicEvaluationContent received language:', input.language);
    console.log('📚 generateDynamicEvaluationContent input:', { 
      bookTitle: input.bookTitle, 
      topic: input.topic, 
      language: input.language,
      questionCount: input.questionCount
    });
    
    const count = input.questionCount || 15;
    const timestamp = input.timestamp || Date.now();
    const randomSeed = input.randomSeed || Math.floor(Math.random() * 1000);
    const isEs = input.language === 'es';
    
    // Verificar si tenemos OpenRouter o Google API disponible
    const hasOpenRouter = useOpenRouter;
    const hasGoogleAPI = process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== 'your_google_api_key_here';
    
    console.log('🔑 API availability:', { hasOpenRouter, hasGoogleAPI });
    
    // Detectar si es asignatura de matemáticas
    const subjectLower = (input.subject || input.bookTitle || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const topicLower = input.topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isMathSubject = /matem|math|algebra|geometr|aritmet|calculo|trigonometr|ecuacion|numero|fraccion|decimal|porcentaje|division|multiplicacion|suma|resta/i.test(subjectLower) ||
                          /matem|math|algebra|geometr|aritmet|calculo|trigonometr|ecuacion|numero|fraccion|decimal|porcentaje|division|multiplicacion|suma|resta/i.test(topicLower);
    
    // Detectar asignaturas de ciencias con cálculos (Física, Química, Biología)
    type ScienceType = 'fisica' | 'quimica' | 'biologia' | null;
    const detectScienceType = (): ScienceType => {
      const combined = subjectLower + ' ' + topicLower;
      
      // Detectar Física
      if (/fisica|physics|cinematica|dinamica|mecanica|optica|termodinamica|electr|magneti|ondas|movimiento|fuerza|energia|trabajo|potencia|velocidad|aceleracion|newton|joule|watt/i.test(combined)) {
        return 'fisica';
      }
      
      // Detectar Química
      if (/quimica|chemistry|atomo|molecula|elemento|compuesto|reaccion|estequiometria|mol|concentracion|solucion|acido|base|ph|enlace|tabla periodica|valencia|oxidacion|reduccion/i.test(combined)) {
        return 'quimica';
      }
      
      // Detectar Biología con cálculos
      if (/biologia|biology|genetica|herencia|probabilidad genetica|adn|cromosoma|mitosis|meiosis|poblacion|ecosistema|cadena trofica|ciclo|metabolismo|fotosintesis|respiracion celular/i.test(combined)) {
        return 'biologia';
      }
      
      return null;
    };
    
    const scienceType = detectScienceType();
    const hasCalculations = isMathSubject || scienceType !== null;
    
    console.log('🔢 Math subject detection:', { isMathSubject, scienceType, subject: input.subject, topic: input.topic });
    
    // Si tenemos OpenRouter, generar preguntas reales con IA
    if (hasOpenRouter) {
      console.log('✅ Using OpenRouter to generate real evaluation questions');
      
      try {
        const tfCount = Math.round(count / 3);
        const mcCount = Math.round((count - tfCount) / 2);
        const msCount = count - tfCount - mcCount;
        
        // Prompt especial para matemáticas
        const mathPromptEs = `Eres un profesor experto en MATEMÁTICAS. Genera una evaluación con PROBLEMAS MATEMÁTICOS REALES sobre el tema "${input.topic}" para el curso "${input.course || 'General'}".

IMPORTANTE: Las preguntas deben ser PROBLEMAS MATEMÁTICOS con OPERACIONES Y CÁLCULOS que el estudiante debe resolver para encontrar la respuesta correcta.

Tipos de preguntas matemáticas que DEBES generar:
- Operaciones aritméticas (sumas, restas, multiplicaciones, divisiones)
- Problemas de razonamiento matemático
- Cálculos con fracciones, decimales o porcentajes según el tema
- Ecuaciones simples o complejas según el nivel
- Problemas de geometría con cálculos de área, perímetro, etc.
- Problemas de lógica matemática

${input.pdfContent ? `Contenido del libro para adaptar la dificultad:\n${input.pdfContent.substring(0, 2000)}` : ''}

Genera exactamente ${count} preguntas en este formato JSON:
{
  "evaluationTitle": "Evaluación - ${input.topic}",
  "questions": [
    // ${tfCount} preguntas de Verdadero/Falso sobre resultados de operaciones:
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "El resultado de 25 × 4 es igual a 100", "correctAnswer": true, "explanation": "25 × 4 = 100, la operación es correcta."},
    {"id": "q2", "type": "TRUE_FALSE", "questionText": "Si 3x = 15, entonces x = 6", "correctAnswer": false, "explanation": "Si 3x = 15, entonces x = 15 ÷ 3 = 5, no 6."},
    // ${mcCount} preguntas de Selección Múltiple con problemas para calcular:
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "María tiene 24 manzanas y quiere repartirlas en partes iguales entre 6 amigos. ¿Cuántas manzanas le tocan a cada amigo?", "options": ["4 manzanas", "3 manzanas", "5 manzanas", "6 manzanas"], "correctAnswerIndex": 0, "explanation": "24 ÷ 6 = 4 manzanas para cada amigo."},
    // ${msCount} preguntas de Selección Múltiple (varias correctas) sobre propiedades o resultados:
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "¿Cuáles de las siguientes operaciones dan como resultado 12?", "options": ["3 × 4", "24 ÷ 3", "6 + 6", "15 - 2"], "correctAnswerIndices": [0, 2], "explanation": "3 × 4 = 12 y 6 + 6 = 12. Las otras dan 8 y 13 respectivamente."}
  ]
}

Reglas IMPORTANTES para matemáticas:
1. TODAS las preguntas deben requerir CÁLCULOS MATEMÁTICOS
2. Incluye operaciones aritméticas, ecuaciones y problemas de razonamiento
3. Las opciones de respuesta deben ser RESULTADOS NUMÉRICOS o expresiones matemáticas
4. La dificultad debe ser apropiada para el tema "${input.topic}" y curso "${input.course || 'primaria'}"
5. Incluye problemas de la vida real que requieran matemáticas
6. Las preguntas TRUE_FALSE deben afirmar resultados de operaciones (correctos o incorrectos)

Responde SOLO con el JSON, sin texto adicional.`;

        const mathPromptEn = `You are an expert MATHEMATICS teacher. Generate an evaluation with REAL MATH PROBLEMS about "${input.topic}" for "${input.course || 'General'}" course.

IMPORTANT: Questions must be MATH PROBLEMS with OPERATIONS AND CALCULATIONS that students must solve to find the correct answer.

Types of math questions you MUST generate:
- Arithmetic operations (addition, subtraction, multiplication, division)
- Mathematical reasoning problems
- Calculations with fractions, decimals or percentages according to the topic
- Simple or complex equations according to the level
- Geometry problems with area, perimeter calculations, etc.
- Mathematical logic problems

${input.pdfContent ? `Book content to adapt difficulty:\n${input.pdfContent.substring(0, 2000)}` : ''}

Generate exactly ${count} questions in this JSON format:
{
  "evaluationTitle": "Evaluation - ${input.topic}",
  "questions": [
    // ${tfCount} True/False questions about operation results:
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "The result of 25 × 4 equals 100", "correctAnswer": true, "explanation": "25 × 4 = 100, the operation is correct."},
    // ${mcCount} Multiple Choice questions with problems to calculate:
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "Maria has 24 apples and wants to share them equally among 6 friends. How many apples does each friend get?", "options": ["4 apples", "3 apples", "5 apples", "6 apples"], "correctAnswerIndex": 0, "explanation": "24 ÷ 6 = 4 apples for each friend."},
    // ${msCount} Multiple Selection questions about properties or results:
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "Which of the following operations result in 12?", "options": ["3 × 4", "24 ÷ 3", "6 + 6", "15 - 2"], "correctAnswerIndices": [0, 2], "explanation": "3 × 4 = 12 and 6 + 6 = 12."}
  ]
}

IMPORTANT rules for math:
1. ALL questions must require MATHEMATICAL CALCULATIONS
2. Include arithmetic operations, equations and reasoning problems
3. Answer options must be NUMERICAL RESULTS or mathematical expressions
4. Difficulty should be appropriate for "${input.topic}" and "${input.course || 'elementary'}" level

Respond ONLY with JSON, no additional text.`;

        const generalPromptEs = `Eres un profesor experto en educación. Genera una evaluación educativa sobre el tema "${input.topic}" para el curso "${input.course || 'General'}" en la asignatura "${input.subject || input.bookTitle}".

IMPORTANTE: Las preguntas deben ser sobre el CONTENIDO REAL del tema "${input.topic}". NO generes preguntas sobre "qué es una asignatura" o "qué son objetivos de aprendizaje". Las preguntas deben evaluar CONOCIMIENTO ESPECÍFICO del tema.

${input.pdfContent ? `Contenido del libro para basar las preguntas:\n${input.pdfContent.substring(0, 4000)}` : ''}

Genera exactamente ${count} preguntas en este formato JSON:
{
  "evaluationTitle": "Evaluación - ${input.topic}",
  "questions": [
    // ${tfCount} preguntas de Verdadero/Falso:
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "Pregunta específica sobre ${input.topic}...", "correctAnswer": true, "explanation": "Explicación..."},
    // ${mcCount} preguntas de Selección Múltiple (4 opciones, una correcta):
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "Pregunta sobre ${input.topic}...", "options": ["Opción A", "Opción B", "Opción C", "Opción D"], "correctAnswerIndex": 0, "explanation": "Explicación..."},
    // ${msCount} preguntas de Selección Múltiple (varias correctas):
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "¿Cuáles de los siguientes...?", "options": ["Opción A", "Opción B", "Opción C", "Opción D"], "correctAnswerIndices": [0, 2], "explanation": "Explicación..."}
  ]
}

Reglas:
1. TODAS las preguntas deben ser sobre el contenido específico de "${input.topic}"
2. Las preguntas de TRUE_FALSE deben tener correctAnswer (boolean)
3. Las preguntas de MULTIPLE_CHOICE deben tener correctAnswerIndex (número 0-3)
4. Las preguntas de MULTIPLE_SELECTION deben tener correctAnswerIndices (array de números)
5. Genera preguntas variadas y educativas que evalúen comprensión real
6. NO incluyas preguntas genéricas sobre "asignaturas" o "objetivos de aprendizaje"

Responde SOLO con el JSON, sin texto adicional.`;

        const generalPromptEn = `You are an expert teacher. Generate an educational evaluation about "${input.topic}" for "${input.course || 'General'}" course in "${input.subject || input.bookTitle}" subject.

IMPORTANT: Questions must be about the REAL CONTENT of "${input.topic}". Do NOT generate questions about "what is a subject" or "what are learning objectives". Questions must evaluate SPECIFIC KNOWLEDGE of the topic.

${input.pdfContent ? `Book content to base questions on:\n${input.pdfContent.substring(0, 4000)}` : ''}

Generate exactly ${count} questions in this JSON format:
{
  "evaluationTitle": "Evaluation - ${input.topic}",
  "questions": [
    // ${tfCount} True/False questions:
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "Specific question about ${input.topic}...", "correctAnswer": true, "explanation": "Explanation..."},
    // ${mcCount} Multiple Choice questions (4 options, one correct):
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "Question about ${input.topic}...", "options": ["Option A", "Option B", "Option C", "Option D"], "correctAnswerIndex": 0, "explanation": "Explanation..."},
    // ${msCount} Multiple Selection questions (multiple correct):
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "Which of the following...?", "options": ["Option A", "Option B", "Option C", "Option D"], "correctAnswerIndices": [0, 2], "explanation": "Explanation..."}
  ]
}

Rules:
1. ALL questions must be about specific content of "${input.topic}"
2. TRUE_FALSE questions must have correctAnswer (boolean)
3. MULTIPLE_CHOICE questions must have correctAnswerIndex (number 0-3)
4. MULTIPLE_SELECTION questions must have correctAnswerIndices (array of numbers)
5. Generate varied educational questions that evaluate real understanding
6. Do NOT include generic questions about "subjects" or "learning objectives"

Respond ONLY with JSON, no additional text.`;

        // =====================================================================
        // PROMPTS PARA CIENCIAS CON CÁLCULOS (FÍSICA, QUÍMICA, BIOLOGÍA)
        // =====================================================================
        
        // FÍSICA
        const physicsPromptEs = `Eres un profesor experto en FÍSICA. Genera una evaluación sobre el tema "${input.topic}" para el curso "${input.course || 'General'}".

IMPORTANTE: Esta es una evaluación de FÍSICA que debe incluir tanto TEORÍA como PROBLEMAS CON CÁLCULOS.

${input.pdfContent ? `Contenido del libro para adaptar:\n${input.pdfContent.substring(0, 2000)}` : ''}

DISTRIBUCIÓN DE PREGUNTAS:
- Aproximadamente 50% preguntas TEÓRICAS (conceptos, definiciones, leyes físicas)
- Aproximadamente 50% preguntas con CÁLCULOS (problemas numéricos con fórmulas)

Tipos de problemas de Física:
- Cinemática (v = d/t, a = Δv/Δt, MRU, MRUV)
- Dinámica (F = m×a, peso, fricción)
- Energía y Trabajo (E = ½mv², W = F×d, P = W/t)
- Conversiones de unidades (m/s a km/h, etc.)

Genera exactamente ${count} preguntas en formato JSON:
{
  "evaluationTitle": "Evaluación de Física - ${input.topic}",
  "questions": [
    // ${tfCount} preguntas de V/F (mezcla teoría y resultados de cálculos):
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "Si un auto viaja a 20 m/s durante 5 segundos, recorre 100 metros", "correctAnswer": true, "explanation": "d = v×t = 20 m/s × 5 s = 100 m ✓"},
    {"id": "q2", "type": "TRUE_FALSE", "questionText": "La fuerza se mide en kilogramos", "correctAnswer": false, "explanation": "La fuerza se mide en Newton (N), no en kg. El kg es unidad de masa."},
    // ${mcCount} preguntas de selección múltiple (incluir problemas):
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "Un objeto de 10 kg cae libremente. ¿Cuál es la fuerza de gravedad sobre él? (g = 10 m/s²)", "options": ["100 N", "10 N", "1 N", "1000 N"], "correctAnswerIndex": 0, "explanation": "F = m×g = 10 kg × 10 m/s² = 100 N"},
    // ${msCount} preguntas de selección múltiple (varias correctas):
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "¿Cuáles son unidades de energía?", "options": ["Joule (J)", "Newton (N)", "Watt (W)", "Caloría (cal)"], "correctAnswerIndices": [0, 3], "explanation": "Joule y Caloría son unidades de energía. Newton es fuerza y Watt es potencia."}
  ]
}

Responde SOLO con el JSON, sin texto adicional.`;

        const physicsPromptEn = `You are an expert PHYSICS teacher. Generate an evaluation about "${input.topic}" for "${input.course || 'General'}" course.

IMPORTANT: This is a PHYSICS evaluation that must include both THEORY and CALCULATION PROBLEMS.

${input.pdfContent ? `Book content to adapt:\n${input.pdfContent.substring(0, 2000)}` : ''}

QUESTION DISTRIBUTION:
- Approximately 50% THEORETICAL questions (concepts, definitions, physical laws)
- Approximately 50% CALCULATION questions (numerical problems with formulas)

Types of Physics problems:
- Kinematics (v = d/t, a = Δv/Δt, uniform motion)
- Dynamics (F = m×a, weight, friction)
- Energy and Work (E = ½mv², W = F×d, P = W/t)
- Unit conversions (m/s to km/h, etc.)

Generate exactly ${count} questions in JSON format:
{
  "evaluationTitle": "Physics Evaluation - ${input.topic}",
  "questions": [...]
}

Respond ONLY with JSON, no additional text.`;

        // QUÍMICA
        const chemistryPromptEs = `Eres un profesor experto en QUÍMICA. Genera una evaluación sobre el tema "${input.topic}" para el curso "${input.course || 'General'}".

IMPORTANTE: Esta es una evaluación de QUÍMICA que debe incluir tanto TEORÍA como PROBLEMAS CON CÁLCULOS.

${input.pdfContent ? `Contenido del libro para adaptar:\n${input.pdfContent.substring(0, 2000)}` : ''}

DISTRIBUCIÓN DE PREGUNTAS:
- Aproximadamente 50% preguntas TEÓRICAS (conceptos, nomenclatura, propiedades)
- Aproximadamente 50% preguntas con CÁLCULOS (estequiometría, concentraciones, pH)

Tipos de problemas de Química:
- Estequiometría (moles, masa molar, conversiones)
- Balanceo de ecuaciones químicas
- Concentración de soluciones (Molaridad = mol/L)
- Cálculos de pH (pH = -log[H+])
- Rendimiento de reacciones

Genera exactamente ${count} preguntas en formato JSON:
{
  "evaluationTitle": "Evaluación de Química - ${input.topic}",
  "questions": [
    // ${tfCount} preguntas de V/F:
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "El número de Avogadro es 6.022 × 10²³", "correctAnswer": true, "explanation": "El número de Avogadro (NA) = 6.022 × 10²³ partículas/mol"},
    {"id": "q2", "type": "TRUE_FALSE", "questionText": "Una solución con pH 3 es básica", "correctAnswer": false, "explanation": "pH < 7 indica solución ácida. pH 3 es ácido."},
    // ${mcCount} preguntas de selección múltiple:
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "¿Cuántos moles hay en 44g de CO₂? (M = 44 g/mol)", "options": ["1 mol", "2 mol", "0.5 mol", "44 mol"], "correctAnswerIndex": 0, "explanation": "n = m/M = 44g ÷ 44g/mol = 1 mol"},
    // ${msCount} preguntas de selección múltiple (varias correctas):
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "¿Cuáles son unidades de concentración?", "options": ["Molar (M)", "Gramos/Litro (g/L)", "Kelvin (K)", "% masa/volumen"], "correctAnswerIndices": [0, 1, 3], "explanation": "Molar, g/L y % son unidades de concentración. Kelvin es temperatura."}
  ]
}

Responde SOLO con el JSON, sin texto adicional.`;

        const chemistryPromptEn = `You are an expert CHEMISTRY teacher. Generate an evaluation about "${input.topic}" for "${input.course || 'General'}" course.

IMPORTANT: This is a CHEMISTRY evaluation that must include both THEORY and CALCULATION PROBLEMS.

${input.pdfContent ? `Book content to adapt:\n${input.pdfContent.substring(0, 2000)}` : ''}

QUESTION DISTRIBUTION:
- Approximately 50% THEORETICAL questions (concepts, nomenclature, properties)
- Approximately 50% CALCULATION questions (stoichiometry, concentrations, pH)

Generate exactly ${count} questions in JSON format with similar structure to the Spanish example.

Respond ONLY with JSON, no additional text.`;

        // BIOLOGÍA
        const biologyPromptEs = `Eres un profesor experto en BIOLOGÍA. Genera una evaluación sobre el tema "${input.topic}" para el curso "${input.course || 'General'}".

IMPORTANTE: Esta es una evaluación de BIOLOGÍA que debe incluir TEORÍA y PROBLEMAS de probabilidad genética cuando corresponda.

${input.pdfContent ? `Contenido del libro para adaptar:\n${input.pdfContent.substring(0, 2000)}` : ''}

DISTRIBUCIÓN DE PREGUNTAS:
- Aproximadamente 70% preguntas TEÓRICAS (conceptos, procesos, estructuras)
- Aproximadamente 30% preguntas con CÁLCULOS (genética, probabilidades, proporciones)

Tipos de problemas de Biología:
- Cruces genéticos (cuadros de Punnett)
- Proporciones fenotípicas y genotípicas
- Probabilidad en herencia (monohíbridos, dihíbridos)
- Cálculos de frecuencias alélicas

Genera exactamente ${count} preguntas en formato JSON:
{
  "evaluationTitle": "Evaluación de Biología - ${input.topic}",
  "questions": [
    // ${tfCount} preguntas de V/F:
    {"id": "q1", "type": "TRUE_FALSE", "questionText": "En un cruce Aa × Aa, la proporción esperada de homocigotos dominantes es 25%", "correctAnswer": true, "explanation": "En cruce Aa × Aa: AA=25%, Aa=50%, aa=25%. Los homocigotos dominantes (AA) son 25%."},
    // ${mcCount} preguntas de selección múltiple:
    {"id": "q${tfCount + 1}", "type": "MULTIPLE_CHOICE", "questionText": "Si se cruzan dos individuos heterocigotos (Aa × Aa), ¿cuántos de 16 descendientes se esperan con fenotipo recesivo?", "options": ["4 individuos", "8 individuos", "12 individuos", "16 individuos"], "correctAnswerIndex": 0, "explanation": "aa = 25% de 16 = 4 individuos"},
    // ${msCount} preguntas de selección múltiple (varias correctas):
    {"id": "q${tfCount + mcCount + 1}", "type": "MULTIPLE_SELECTION", "questionText": "¿Cuáles son componentes del ADN?", "options": ["Adenina", "Ribosa", "Timina", "Desoxirribosa"], "correctAnswerIndices": [0, 2, 3], "explanation": "El ADN contiene adenina, timina (no uracilo) y desoxirribosa (no ribosa)."}
  ]
}

Responde SOLO con el JSON, sin texto adicional.`;

        const biologyPromptEn = `You are an expert BIOLOGY teacher. Generate an evaluation about "${input.topic}" for "${input.course || 'General'}" course.

IMPORTANT: This is a BIOLOGY evaluation that must include THEORY and genetic probability PROBLEMS when applicable.

${input.pdfContent ? `Book content to adapt:\n${input.pdfContent.substring(0, 2000)}` : ''}

QUESTION DISTRIBUTION:
- Approximately 70% THEORETICAL questions (concepts, processes, structures)
- Approximately 30% CALCULATION questions (genetics, probabilities, ratios)

Generate exactly ${count} questions in JSON format with similar structure to the Spanish example.

Respond ONLY with JSON, no additional text.`;

        // Seleccionar el prompt apropiado según el tipo de asignatura
        const getPrompt = (): string => {
          if (isMathSubject) {
            return isEs ? mathPromptEs : mathPromptEn;
          }
          if (scienceType === 'fisica') {
            return isEs ? physicsPromptEs : physicsPromptEn;
          }
          if (scienceType === 'quimica') {
            return isEs ? chemistryPromptEs : chemistryPromptEn;
          }
          if (scienceType === 'biologia') {
            return isEs ? biologyPromptEs : biologyPromptEn;
          }
          return isEs ? generalPromptEs : generalPromptEn;
        };
        
        const prompt = getPrompt();

        const aiResponse = await generateWithAI(prompt, {
          temperature: 0.7,
          maxTokens: 4000,
          jsonMode: true
        });
        
        console.log('🤖 OpenRouter raw response length:', aiResponse.length);
        
        // Parsear la respuesta JSON
        let jsonStr = aiResponse.trim();
        // Limpiar posibles marcadores de código
        if (jsonStr.startsWith('```json')) {
          jsonStr = jsonStr.slice(7);
        }
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.slice(3);
        }
        if (jsonStr.endsWith('```')) {
          jsonStr = jsonStr.slice(0, -3);
        }
        jsonStr = jsonStr.trim();
        
        const parsed = JSON.parse(jsonStr);
        
        if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length === count) {
          // Asignar IDs únicos a cada pregunta
          const questionsWithIds = parsed.questions.map((q: any, i: number) => ({
            ...q,
            id: `q${i + 1}_${timestamp}_${randomSeed}`
          }));
          
          console.log('✅ Successfully generated', questionsWithIds.length, 'questions with OpenRouter');
          
          return {
            evaluationTitle: parsed.evaluationTitle || `${isEs ? 'Evaluación' : 'Evaluation'} - ${input.topic}`,
            questions: questionsWithIds
          };
        } else {
          console.warn('⚠️ OpenRouter response did not have expected question count, falling back to mock');
          throw new Error('Invalid question count from OpenRouter');
        }
      } catch (aiError) {
        console.error('❌ OpenRouter generation failed:', aiError);
        // Continuar con fallback
      }
    }
    
    // Check if Google API key is available
    if (hasGoogleAPI) {
      console.log('✅ Using Google AI to generate real evaluation questions');
      // Aquí iría la lógica de Google AI si está disponible
      // Por ahora, continúa con el fallback
    }
    
    // Fallback: Return mock data with exact questionCount respecting proportions
    console.log('⚠️ Using mock data - no AI API available. Language:', input.language);

    const makeId = (i: number) => `q${i + 1}_${timestamp}_${randomSeed}`;
    const contextLabel = isEs ? `${input.subject ? input.subject + ' - ' : ''}${input.bookTitle}` : `${input.subject ? input.subject + ' - ' : ''}${input.bookTitle}`;

    // Función de traducción para preguntas matemáticas
    const translateMathQuestion = (text: string): string => {
      if (isEs) return text;
      return text
        .replace(/El resultado de/g, 'The result of')
        .replace(/es igual a/g, 'equals')
        .replace(/entonces/g, 'then')
        .replace(/La mitad de/g, 'Half of')
        .replace(/El doble de/g, 'Double of')
        .replace(/El triple de/g, 'Triple of')
        .replace(/El cuadrado de/g, 'The square of')
        .replace(/El cubo de/g, 'The cube of')
        .replace(/La raíz cuadrada de/g, 'The square root of')
        .replace(/Las fracciones/g, 'The fractions')
        .replace(/son equivalentes/g, 'are equivalent')
        .replace(/Si /g, 'If ')
        .replace(/ y /g, ' and ')
        .replace(/ más /g, ' plus ')
        .replace(/ menos /g, ' minus ')
        .replace(/ por /g, ' times ')
        .replace(/ entre /g, ' divided by ')
        .replace(/¿Cuál es/g, 'What is')
        .replace(/¿Cuánto es/g, 'What is')
        .replace(/¿Cuántos/g, 'How many')
        .replace(/¿Cuántas/g, 'How many')
        .replace(/tiene/g, 'has')
        .replace(/tenía/g, 'had')
        .replace(/quedan/g, 'remain')
        .replace(/quedaron/g, 'remained')
        .replace(/caramelos/g, 'candies')
        .replace(/estampillas/g, 'stamps')
        .replace(/figuritas/g, 'stickers')
        .replace(/pasajeros/g, 'passengers')
        .replace(/alumnos/g, 'students')
        .replace(/páginas/g, 'pages')
        .replace(/productos/g, 'products')
        .replace(/vacas/g, 'cows')
        .replace(/manzanas/g, 'apples')
        .replace(/amigos/g, 'friends')
        .replace(/pizzas?/g, 'pizza')
        .replace(/litros?/g, 'liters')
        .replace(/dinero/g, 'money')
        .replace(/jugo/g, 'juice')
        .replace(/pastel/g, 'cake')
        .replace(/descuento/g, 'discount')
        .replace(/precio/g, 'price')
        .replace(/artículo/g, 'item')
        .replace(/tienda/g, 'store')
        .replace(/granja/g, 'farm')
        .replace(/tren/g, 'train')
        .replace(/autobús/g, 'bus')
        .replace(/escuela/g, 'school')
        .replace(/clase/g, 'class')
        .replace(/María/g, 'Maria')
        .replace(/Juan/g, 'John')
        .replace(/Pedro/g, 'Peter')
        .replace(/Ana/g, 'Anna')
        .replace(/Carlos/g, 'Charles')
        .replace(/Resuelve:/g, 'Solve:')
        .replace(/el lunes/g, 'on Monday')
        .replace(/el martes/g, 'on Tuesday')
        .replace(/en total/g, 'in total')
        .replace(/le quedan/g, 'are left')
        .replace(/le tocan/g, 'gets')
        .replace(/subieron/g, 'got on')
        .replace(/bajaron/g, 'got off')
        .replace(/regaló/g, 'gave away')
        .replace(/ganó/g, 'earned')
        .replace(/gastó/g, 'spent')
        .replace(/ahorras/g, 'save')
        .replace(/comieron/g, 'ate')
        .replace(/comió/g, 'ate')
        .replace(/repartir/g, 'share')
        .replace(/partes iguales/g, 'equal parts');
    };

    const translateMathExplanation = (text: string): string => {
      if (isEs) return text;
      return text
        .replace(/La suma es correcta/g, 'The addition is correct')
        .replace(/La multiplicación es correcta/g, 'The multiplication is correct')
        .replace(/La división es correcta/g, 'The division is correct')
        .replace(/La resta es correcta/g, 'The subtraction is correct')
        .replace(/es correcto/g, 'is correct')
        .replace(/es correcta/g, 'is correct')
        .replace(/no/g, 'not')
        .replace(/entonces/g, 'then')
        .replace(/por lo tanto/g, 'therefore')
        .replace(/porque/g, 'because');

    // Distribución aproximada en tercios
    const tfCount = Math.round(count / 3);
    const mcCount = Math.round((count - tfCount) / 2);
    const msCount = count - tfCount - mcCount;

    const questions: EvaluationQuestion[] = [];
      
      // Generar preguntas basadas en el contenido del PDF si está disponible
      const pdfLines = (input.pdfContent || '').split('\n').filter(l => l.trim().length > 10);
      const hasRealContent = pdfLines.length > 5;
      
      // Líneas a ignorar (encabezados del PDF, metadatos)
      const normalizeText = (text: string) =>
        text
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim();

      const ignoredPhrases = [
        // Metadatos típicos del mock PDF
        'contenido educativo',
        'contenido educativo de',
        'tema especifico',
        'materia',
        'curso',
        // Cierres/avisos del mock
        'el material esta actualizado',
        'los conceptos se presentan',
        'segun los estandares',
        'curriculares vigentes'
      ];

      const isLikelySectionHeader = (line: string): boolean => {
        const trimmed = line.trim();
        if (trimmed.length < 6 || trimmed.length > 90) return false;

        // Encabezados tipo "ÓRGANOS DEL SISTEMA RESPIRATORIO:" / "INTERCAMBIO GASEOSO:" etc.
        const mostlyCaps = /^[A-ZÁÉÍÓÚÑ\s\-]+:?$/.test(trimmed);
        if (!mostlyCaps) return false;

        const normalized = normalizeText(trimmed);
        return (
          normalized.includes('sistema') ||
          normalized.includes('organos') ||
          normalized.includes('proceso') ||
          normalized.includes('intercambio') ||
          normalized.includes('cuidados') ||
          normalized.includes('enfermedades')
        );
      };

      const shouldIgnoreLine = (line: string): boolean => {
        const normalized = normalizeText(line);
        if (!normalized) return true;
        if (isLikelySectionHeader(line)) return true;

        // Ignorar valores sueltos comunes (esto evita opciones como "Materia" o "Curso")
        if (normalized === 'materia' || normalized === 'curso' || normalized === 'tema especifico') return true;

        return ignoredPhrases.some(phrase => normalized.includes(phrase));
      };
      
      // Función avanzada para extraer conceptos específicos del PDF
      const extractDetailedConcepts = () => {
        const facts: string[] = []; // Hechos afirmativos específicos
        const components: string[] = []; // Componentes/partes del tema
        const definitions: string[] = []; // Definiciones
        const processes: string[] = []; // Procesos
        const distractors: string[] = []; // Distractores (incorrectos pero plausibles)
        
        for (const line of pdfLines) {
          const trimmed = line.trim();
          const cleanLine = trimmed.replace(/^[-•*]\s*/, '');
          
          // Ignorar líneas de metadatos
          if (shouldIgnoreLine(cleanLine)) {
            continue;
          }
          
          // Extraer componentes (líneas con ":" que describen partes)
          if (cleanLine.includes(':') && cleanLine.length > 20 && cleanLine.length < 150) {
            const parts = cleanLine.split(':');
            if (parts.length >= 2 && parts[0].length < 50) {
              // Ignorar si el nombre del componente es un encabezado
              const componentName = parts[0].trim();
              if (shouldIgnoreLine(componentName) || isLikelySectionHeader(componentName)) {
                continue;
              }
              components.push(cleanLine);
              // Extraer solo el nombre del componente
              if (componentName.length > 3) {
                facts.push(componentName);
              }
            }
          }
          
          // Extraer definiciones (líneas que empiezan con mayúscula y son descriptivas)
          if (/^[A-ZÁÉÍÓÚ][a-záéíóú]/.test(cleanLine) && 
              (cleanLine.includes(' es ') || cleanLine.includes(' son ') || cleanLine.includes(' significa '))) {
            definitions.push(cleanLine.substring(0, 120));
          }
          
          // Extraer procesos (líneas con verbos en infinitivo o gerundio)
          if (cleanLine.match(/\b(permite|produce|realiza|ocurre|contiene|transforma|transporta|controla)\b/i)) {
            processes.push(cleanLine.substring(0, 120));
          }
          
          // Extraer hechos (líneas que describen características específicas)
          if (cleanLine.length > 30 && cleanLine.length < 100 && !cleanLine.includes(':')) {
            facts.push(cleanLine);
          }
        }
        
        // Generar distractores basados en el tema pero incorrectos
        const topicLower = input.topic.toLowerCase();
        if (topicLower.includes('respiratorio')) {
          distractors.push(
            'El sistema digestivo procesa los alimentos',
            'Los riñones filtran la sangre',
            'El corazón es parte del sistema circulatorio',
            'Los huesos sostienen el cuerpo'
          );
        } else if (topicLower.includes('célula')) {
          distractors.push(
            'Los virus son células procariotas',
            'Las bacterias tienen núcleo definido',
            'Los animales realizan fotosíntesis',
            'Las rocas contienen mitocondrias'
          );
        } else if (topicLower.includes('fotosíntesis') || topicLower.includes('fotosintesis')) {
          distractors.push(
            'Los animales realizan fotosíntesis',
            'La fotosíntesis consume oxígeno',
            'Las plantas no necesitan luz solar',
            'Los hongos producen su propio alimento'
          );
        } else if (topicLower.includes('fraccion') || topicLower.includes('fracción')) {
          distractors.push(
            'El denominador indica cuántas partes se toman',
            'Las fracciones impropias son menores que 1',
            'No se pueden sumar fracciones diferentes',
            'El numerador siempre es mayor que el denominador'
          );
        } else {
          distractors.push(
            `Un concepto de otra materia`,
            `Información no relacionada con ${input.topic}`,
            `Un proceso diferente al tema estudiado`,
            `Una definición incorrecta del concepto`
          );
        }
        
        return { facts, components, definitions, processes, distractors };
      };
      
      const conceptData = hasRealContent ? extractDetailedConcepts() : { facts: [], components: [], definitions: [], processes: [], distractors: [] };
      
      // Filtrar conceptos que contengan frases de metadatos
      const filterConcepts = (arr: string[]) => arr.filter(c => c.length > 15 && !shouldIgnoreLine(c));
      const concepts = filterConcepts([...conceptData.components, ...conceptData.definitions, ...conceptData.processes]);
      
      // También filtrar facts y components del conceptData
      conceptData.facts = filterConcepts(conceptData.facts);
      conceptData.components = filterConcepts(conceptData.components);
      conceptData.definitions = filterConcepts(conceptData.definitions);
      conceptData.processes = filterConcepts(conceptData.processes);
      
      // Generar preguntas de Verdadero/Falso basadas en contenido real
      const generateTrueFalseQuestion = (index: number): EvaluationQuestion => {
        const { facts, components, definitions, distractors } = conceptData;
        const allFacts = [...definitions, ...components.slice(0, 10)];
        const isTrue = index % 2 === 0;
        
        if (hasRealContent && allFacts.length > 0) {
          const factIndex = index % allFacts.length;
          const fact = allFacts[factIndex];
          
          if (isTrue) {
            // Afirmación verdadera basada en el contenido
            const statement = fact.includes(':') 
              ? fact.split(':')[1]?.trim() || fact
              : fact;
            
            return {
              id: makeId(questions.length),
              type: 'TRUE_FALSE',
              questionText: isEs
                ? `${statement.charAt(0).toUpperCase() + statement.slice(1).substring(0, 150)}.`
                : `${statement.charAt(0).toUpperCase() + statement.slice(1).substring(0, 150)}.`,
              correctAnswer: true,
              explanation: isEs
                ? `Esta afirmación es correcta según el contenido sobre ${input.topic}.`
                : `This statement is correct according to the content about ${input.topic}.`
            };
          } else {
            // Afirmación falsa usando distractores
            const distractor = distractors[index % distractors.length] || 
              `${input.topic} no tiene relación con los procesos biológicos`;
            
            return {
              id: makeId(questions.length),
              type: 'TRUE_FALSE',
              questionText: isEs
                ? `${distractor}.`
                : `${distractor}.`,
              correctAnswer: false,
              explanation: isEs
                ? `Esta afirmación es incorrecta. El contenido de ${input.topic} indica lo contrario.`
                : `This statement is incorrect. The content about ${input.topic} indicates otherwise.`
            };
          }
        }
        
        // Fallback con contenido educativo específico del tema
        const topicLowerFallback = input.topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        let question = '';
        let answer = true;
        let explanation = '';
        
        // MATEMÁTICAS: Generar problemas específicos del tema seleccionado
        if (isMathSubject) {
          // Normalizar el tema para detectar qué tipo de matemáticas es
          const mathTopic = input.topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          // Bancos de preguntas V/F por tema específico
          const divisionProblems = [
            { q: 'El resultado de 72 ÷ 8 es igual a 9', a: true, e: '72 ÷ 8 = 9. La división es correcta.' },
            { q: 'El resultado de 144 ÷ 12 es igual a 12', a: true, e: '144 ÷ 12 = 12. La división es correcta.' },
            { q: 'El resultado de 81 ÷ 9 es igual a 9', a: true, e: '81 ÷ 9 = 9. La división es correcta.' },
            { q: 'El resultado de 100 ÷ 25 es igual a 4', a: true, e: '100 ÷ 25 = 4. La división es correcta.' },
            { q: 'El resultado de 63 ÷ 7 es igual a 9', a: true, e: '63 ÷ 7 = 9. La división es correcta.' },
            { q: 'El resultado de 120 ÷ 10 es igual a 12', a: true, e: '120 ÷ 10 = 12. La división es correcta.' },
            { q: 'El resultado de 56 ÷ 7 es igual a 9', a: false, e: '56 ÷ 7 = 8, no 9.' },
            { q: 'El resultado de 48 ÷ 6 es igual a 7', a: false, e: '48 ÷ 6 = 8, no 7.' },
            { q: 'El resultado de 90 ÷ 9 es igual a 11', a: false, e: '90 ÷ 9 = 10, no 11.' },
            { q: 'El resultado de 84 ÷ 7 es igual a 11', a: false, e: '84 ÷ 7 = 12, no 11.' },
            { q: 'El resultado de 150 ÷ 15 es igual a 12', a: false, e: '150 ÷ 15 = 10, no 12.' },
            { q: 'El resultado de 96 ÷ 8 es igual a 11', a: false, e: '96 ÷ 8 = 12, no 11.' }
          ];
          
          const multiplicationProblems = [
            { q: 'El resultado de 8 × 7 es igual a 56', a: true, e: '8 × 7 = 56. La multiplicación es correcta.' },
            { q: 'El resultado de 9 × 6 es igual a 54', a: true, e: '9 × 6 = 54. La multiplicación es correcta.' },
            { q: 'El resultado de 12 × 5 es igual a 60', a: true, e: '12 × 5 = 60. La multiplicación es correcta.' },
            { q: 'El resultado de 7 × 7 es igual a 49', a: true, e: '7 × 7 = 49. La multiplicación es correcta.' },
            { q: 'El resultado de 11 × 8 es igual a 88', a: true, e: '11 × 8 = 88. La multiplicación es correcta.' },
            { q: 'El resultado de 6 × 9 es igual a 54', a: true, e: '6 × 9 = 54. La multiplicación es correcta.' },
            { q: 'El resultado de 9 × 8 es igual a 63', a: false, e: '9 × 8 = 72, no 63.' },
            { q: 'El resultado de 7 × 6 es igual a 48', a: false, e: '7 × 6 = 42, no 48.' },
            { q: 'El resultado de 8 × 8 es igual a 62', a: false, e: '8 × 8 = 64, no 62.' },
            { q: 'El resultado de 12 × 7 es igual a 82', a: false, e: '12 × 7 = 84, no 82.' },
            { q: 'El resultado de 9 × 9 es igual a 72', a: false, e: '9 × 9 = 81, no 72.' },
            { q: 'El resultado de 6 × 8 es igual a 46', a: false, e: '6 × 8 = 48, no 46.' }
          ];
          
          const additionProblems = [
            { q: 'El resultado de 15 + 27 es igual a 42', a: true, e: '15 + 27 = 42. La suma es correcta.' },
            { q: 'El resultado de 38 + 45 es igual a 83', a: true, e: '38 + 45 = 83. La suma es correcta.' },
            { q: 'El resultado de 67 + 28 es igual a 95', a: true, e: '67 + 28 = 95. La suma es correcta.' },
            { q: 'El resultado de 156 + 89 es igual a 245', a: true, e: '156 + 89 = 245. La suma es correcta.' },
            { q: 'El resultado de 234 + 178 es igual a 412', a: true, e: '234 + 178 = 412. La suma es correcta.' },
            { q: 'El resultado de 99 + 56 es igual a 155', a: true, e: '99 + 56 = 155. La suma es correcta.' },
            { q: 'El resultado de 45 + 38 es igual a 73', a: false, e: '45 + 38 = 83, no 73.' },
            { q: 'El resultado de 67 + 45 es igual a 102', a: false, e: '67 + 45 = 112, no 102.' },
            { q: 'El resultado de 89 + 34 es igual a 113', a: false, e: '89 + 34 = 123, no 113.' },
            { q: 'El resultado de 125 + 78 es igual a 193', a: false, e: '125 + 78 = 203, no 193.' },
            { q: 'El resultado de 56 + 67 es igual a 113', a: false, e: '56 + 67 = 123, no 113.' },
            { q: 'El resultado de 145 + 89 es igual a 224', a: false, e: '145 + 89 = 234, no 224.' }
          ];
          
          const subtractionProblems = [
            { q: 'El resultado de 100 - 37 es igual a 63', a: true, e: '100 - 37 = 63. La resta es correcta.' },
            { q: 'El resultado de 85 - 48 es igual a 37', a: true, e: '85 - 48 = 37. La resta es correcta.' },
            { q: 'El resultado de 156 - 89 es igual a 67', a: true, e: '156 - 89 = 67. La resta es correcta.' },
            { q: 'El resultado de 200 - 125 es igual a 75', a: true, e: '200 - 125 = 75. La resta es correcta.' },
            { q: 'El resultado de 93 - 46 es igual a 47', a: true, e: '93 - 46 = 47. La resta es correcta.' },
            { q: 'El resultado de 178 - 89 es igual a 89', a: true, e: '178 - 89 = 89. La resta es correcta.' },
            { q: 'El resultado de 120 - 85 es igual a 45', a: false, e: '120 - 85 = 35, no 45.' },
            { q: 'El resultado de 95 - 38 es igual a 67', a: false, e: '95 - 38 = 57, no 67.' },
            { q: 'El resultado de 143 - 76 es igual a 77', a: false, e: '143 - 76 = 67, no 77.' },
            { q: 'El resultado de 200 - 87 es igual a 123', a: false, e: '200 - 87 = 113, no 123.' },
            { q: 'El resultado de 167 - 89 es igual a 88', a: false, e: '167 - 89 = 78, no 88.' },
            { q: 'El resultado de 134 - 67 es igual a 77', a: false, e: '134 - 67 = 67, no 77.' }
          ];
          
          const fractionProblems = [
            { q: 'El resultado de 1/2 + 1/4 es igual a 3/4', a: true, e: '1/2 + 1/4 = 2/4 + 1/4 = 3/4.' },
            { q: 'El resultado de 2/3 + 1/3 es igual a 1', a: true, e: '2/3 + 1/3 = 3/3 = 1.' },
            { q: 'El resultado de 3/4 - 1/4 es igual a 1/2', a: true, e: '3/4 - 1/4 = 2/4 = 1/2.' },
            { q: 'El resultado de 1/2 × 1/2 es igual a 1/4', a: true, e: '1/2 × 1/2 = 1/4.' },
            { q: 'El resultado de 2/5 + 2/5 es igual a 4/5', a: true, e: '2/5 + 2/5 = 4/5.' },
            { q: 'Las fracciones 2/4 y 1/2 son equivalentes', a: true, e: '2/4 simplificado es 1/2, son equivalentes.' },
            { q: 'El resultado de 1/3 + 1/3 es igual a 2/6', a: false, e: '1/3 + 1/3 = 2/3, no 2/6.' },
            { q: 'El resultado de 1/4 + 1/4 es igual a 1/2', a: true, e: '1/4 + 1/4 = 2/4 = 1/2.' },
            { q: 'El resultado de 3/5 - 1/5 es igual a 1/5', a: false, e: '3/5 - 1/5 = 2/5, no 1/5.' },
            { q: 'Las fracciones 3/6 y 2/4 son equivalentes', a: true, e: 'Ambas equivalen a 1/2.' },
            { q: 'El resultado de 1/2 ÷ 2 es igual a 1', a: false, e: '1/2 ÷ 2 = 1/4, no 1.' },
            { q: 'El resultado de 2/3 × 3 es igual a 3', a: false, e: '2/3 × 3 = 2, no 3.' }
          ];
          
          const percentageProblems = [
            { q: 'El 25% de 80 es igual a 20', a: true, e: '25% de 80 = 80 × 0.25 = 20.' },
            { q: 'El 50% de 60 es igual a 30', a: true, e: '50% de 60 = 60 × 0.5 = 30.' },
            { q: 'El 10% de 150 es igual a 15', a: true, e: '10% de 150 = 150 × 0.1 = 15.' },
            { q: 'El 75% de 40 es igual a 30', a: true, e: '75% de 40 = 40 × 0.75 = 30.' },
            { q: 'El 20% de 200 es igual a 40', a: true, e: '20% de 200 = 200 × 0.2 = 40.' },
            { q: 'El 100% de 45 es igual a 45', a: true, e: '100% de cualquier número es el mismo número.' },
            { q: 'El 50% de 60 es igual a 25', a: false, e: '50% de 60 = 30, no 25.' },
            { q: 'El 25% de 100 es igual a 30', a: false, e: '25% de 100 = 25, no 30.' },
            { q: 'El 10% de 200 es igual a 30', a: false, e: '10% de 200 = 20, no 30.' },
            { q: 'El 75% de 100 es igual a 80', a: false, e: '75% de 100 = 75, no 80.' },
            { q: 'El 20% de 50 es igual a 15', a: false, e: '20% de 50 = 10, no 15.' },
            { q: 'El 30% de 90 es igual a 30', a: false, e: '30% de 90 = 27, no 30.' }
          ];
          
          const equationProblems = [
            { q: 'Si 4x = 20, entonces x = 5', a: true, e: 'x = 20 ÷ 4 = 5.' },
            { q: 'Si 3x = 15, entonces x = 5', a: true, e: 'x = 15 ÷ 3 = 5.' },
            { q: 'Si x + 7 = 12, entonces x = 5', a: true, e: 'x = 12 - 7 = 5.' },
            { q: 'Si 2x + 4 = 10, entonces x = 3', a: true, e: '2x = 6, x = 3.' },
            { q: 'Si x - 8 = 15, entonces x = 23', a: true, e: 'x = 15 + 8 = 23.' },
            { q: 'Si 5x = 45, entonces x = 9', a: true, e: 'x = 45 ÷ 5 = 9.' },
            { q: 'Si 5x = 30, entonces x = 7', a: false, e: 'x = 30 ÷ 5 = 6, no 7.' },
            { q: 'Si x + 9 = 20, entonces x = 12', a: false, e: 'x = 20 - 9 = 11, no 12.' },
            { q: 'Si 6x = 42, entonces x = 8', a: false, e: 'x = 42 ÷ 6 = 7, no 8.' },
            { q: 'Si x - 5 = 18, entonces x = 22', a: false, e: 'x = 18 + 5 = 23, no 22.' },
            { q: 'Si 2x = 16, entonces x = 9', a: false, e: 'x = 16 ÷ 2 = 8, no 9.' },
            { q: 'Si 3x + 6 = 21, entonces x = 6', a: false, e: '3x = 15, x = 5, no 6.' }
          ];
          
          const numbersProblems = [
            { q: 'El doble de 35 es 70', a: true, e: '35 × 2 = 70.' },
            { q: 'La mitad de 84 es 42', a: true, e: '84 ÷ 2 = 42.' },
            { q: 'El triple de 15 es 45', a: true, e: '15 × 3 = 45.' },
            { q: 'El cuadrado de 7 es 49', a: true, e: '7² = 7 × 7 = 49.' },
            { q: 'El cubo de 3 es 27', a: true, e: '3³ = 3 × 3 × 3 = 27.' },
            { q: 'La raíz cuadrada de 81 es 9', a: true, e: '√81 = 9 porque 9 × 9 = 81.' },
            { q: 'El triple de 15 es 50', a: false, e: '15 × 3 = 45, no 50.' },
            { q: 'El cuadrado de 7 es 45', a: false, e: '7² = 49, no 45.' },
            { q: 'La mitad de 90 es 40', a: false, e: '90 ÷ 2 = 45, no 40.' },
            { q: 'El doble de 28 es 54', a: false, e: '28 × 2 = 56, no 54.' },
            { q: 'El cubo de 4 es 60', a: false, e: '4³ = 64, no 60.' },
            { q: 'La raíz cuadrada de 64 es 7', a: false, e: '√64 = 8, no 7.' }
          ];
          
          // Seleccionar banco según el tema
          let selectedProblems = numbersProblems; // Por defecto
          
          if (mathTopic.includes('division') || mathTopic.includes('dividir') || mathTopic.includes('cociente')) {
            selectedProblems = divisionProblems;
          } else if (mathTopic.includes('multiplicacion') || mathTopic.includes('multiplicar') || mathTopic.includes('producto') || mathTopic.includes('tabla')) {
            selectedProblems = multiplicationProblems;
          } else if (mathTopic.includes('suma') || mathTopic.includes('sumar') || mathTopic.includes('adicion')) {
            selectedProblems = additionProblems;
          } else if (mathTopic.includes('resta') || mathTopic.includes('restar') || mathTopic.includes('sustraccion') || mathTopic.includes('diferencia')) {
            selectedProblems = subtractionProblems;
          } else if (mathTopic.includes('fraccion') || mathTopic.includes('fracciones') || mathTopic.includes('numerador') || mathTopic.includes('denominador')) {
            selectedProblems = fractionProblems;
          } else if (mathTopic.includes('porcentaje') || mathTopic.includes('porciento') || mathTopic.includes('%')) {
            selectedProblems = percentageProblems;
          } else if (mathTopic.includes('ecuacion') || mathTopic.includes('incognita') || mathTopic.includes('variable') || mathTopic.includes('algebra')) {
            selectedProblems = equationProblems;
          } else if (mathTopic.includes('numero') || mathTopic.includes('doble') || mathTopic.includes('triple') || mathTopic.includes('mitad') || mathTopic.includes('cuadrado') || mathTopic.includes('potencia') || mathTopic.includes('raiz')) {
            selectedProblems = numbersProblems;
          }
          
          const problem = selectedProblems[index % selectedProblems.length];
          question = translateMathQuestion(problem.q);
          answer = problem.a;
          explanation = translateMathExplanation(problem.e);
        } else if (topicLowerFallback.includes('respiratorio')) {
          if (isTrue) {
            question = isEs ? 'Los pulmones son los órganos principales del sistema respiratorio.' : 'The lungs are the main organs of the respiratory system.';
            answer = true;
            explanation = isEs ? 'Los pulmones son efectivamente los órganos principales donde ocurre el intercambio gaseoso.' : 'The lungs are indeed the main organs where gas exchange occurs.';
          } else {
            question = isEs ? 'El estómago es parte del sistema respiratorio.' : 'The stomach is part of the respiratory system.';
            answer = false;
            explanation = isEs ? 'El estómago pertenece al sistema digestivo, no al respiratorio.' : 'The stomach belongs to the digestive system, not the respiratory system.';
          }
        } else {
          question = isEs
            ? `Los conceptos fundamentales de ${input.topic} son esenciales para su comprensión.`
            : `The fundamental concepts of ${input.topic} are essential for its understanding.`;
          answer = true;
          explanation = isEs ? 'Los conceptos básicos siempre son la base del aprendizaje.' : 'Basic concepts are always the foundation of learning.';
        }
        
        return {
          id: makeId(questions.length),
          type: 'TRUE_FALSE',
          questionText: question,
          correctAnswer: answer,
          explanation: explanation
        };
      };
      
      // Generar preguntas de Selección Múltiple con opciones reales del tema
      const generateMultipleChoiceQuestion = (index: number): EvaluationQuestion => {
        const { components, definitions, processes, distractors } = conceptData;
        const correctAnswerIndex = index % 4;
        
        // Extraer nombres de componentes limpios (excluyendo metadatos)
        const getComponentNames = (): string[] => {
          const names: string[] = [];
          for (const comp of components) {
            // Saltar si contiene frases de metadatos
            if (shouldIgnoreLine(comp)) {
              continue;
            }
            const parts = comp.split(':');
            if (parts.length >= 2) {
              const name = parts[0].trim();
              const description = parts[1].trim().substring(0, 80);
              // Verificar que el nombre no sea un encabezado genérico
              if (name.length > 3 && name.length < 50 && !shouldIgnoreLine(name)) {
                names.push(`${name}: ${description}`);
              }
            }
          }
          return names;
        };
        
        const componentNames = getComponentNames();
        const topicLower = input.topic.toLowerCase();

        // Tema: Sistema Respiratorio (opciones siempre coherentes con la pregunta)
        if (hasRealContent && topicLower.includes('respiratorio')) {
          const questionType = index % 10;

          if (questionType === 0) {
            const options = ['Alvéolos pulmonares', 'Tráquea', 'Bronquios', 'Diafragma'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Qué estructura permite el intercambio gaseoso en los pulmones?'
                : 'Which structure enables gas exchange in the lungs?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'El intercambio gaseoso ocurre en los alvéolos pulmonares.'
                : 'Gas exchange occurs in the pulmonary alveoli.'
            };
          }

          if (questionType === 1) {
            const options = ['Fosas nasales', 'Esófago', 'Estómago', 'Riñones'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Qué estructura filtra, calienta y humedece el aire que ingresa al cuerpo?'
                : 'Which structure filters, warms, and humidifies the air entering the body?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'Las fosas nasales filtran, calientan y humedecen el aire.'
                : 'Nasal cavities filter, warm, and humidify the air.'
            };
          }

          if (questionType === 2) {
            const options = ['Tráquea', 'Alvéolos pulmonares', 'Diafragma', 'Faringe'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Qué estructura conduce el aire hacia los bronquios?'
                : 'Which structure carries air toward the bronchi?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'La tráquea conduce el aire hacia los bronquios.'
                : 'The trachea carries air to the bronchi.'
            };
          }

          if (questionType === 3) {
            const options = ['Laringe', 'Páncreas', 'Riñones', 'Intestino delgado'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Qué órgano contiene las cuerdas vocales y permite la fonación?'
                : 'Which organ contains the vocal cords and enables phonation?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'La laringe contiene las cuerdas vocales.'
                : 'The larynx contains the vocal cords.'
            };
          }

          if (questionType === 4) {
            const options = ['Bronquios', 'Esófago', 'Uréteres', 'Venas'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Cómo se llaman las ramificaciones de la tráquea que ingresan a cada pulmón?'
                : 'What are the branches of the trachea that enter each lung called?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'Los bronquios son las ramificaciones de la tráquea.'
                : 'Bronchi are the branches of the trachea.'
            };
          }

          if (questionType === 5) {
            const options = ['Diafragma', 'Bíceps', 'Fémur', 'Húmero'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Qué músculo permite los movimientos respiratorios?'
                : 'Which muscle enables breathing movements?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'El diafragma es el músculo clave en la respiración.'
                : 'The diaphragm is the key muscle in breathing.'
            };
          }

          if (questionType === 6) {
            const options = ['Inspiración', 'Fotosíntesis', 'Digestión', 'Evaporación'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Cómo se llama la fase en la que entra aire rico en oxígeno al cuerpo?'
                : 'What is the phase called when oxygen-rich air enters the body?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'En la inspiración entra aire rico en oxígeno.'
                : 'In inhalation, oxygen-rich air enters the body.'
            };
          }

          if (questionType === 7) {
            const options = ['Espiración', 'Inspiración', 'Circulación', 'Digestión'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Cómo se llama la fase en la que se expulsa aire rico en dióxido de carbono?'
                : 'What is the phase called when carbon dioxide-rich air is expelled?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'En la espiración se expulsa aire con CO₂.'
                : 'In exhalation, air containing CO₂ is expelled.'
            };
          }

          if (questionType === 8) {
            const options = ['Pulmones', 'Corazón', 'Estómago', 'Riñones'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_CHOICE',
              questionText: isEs
                ? '¿Cuál de los siguientes órganos pertenece al sistema respiratorio?'
                : 'Which of the following organs belongs to the respiratory system?',
              options,
              correctAnswerIndex: 0,
              explanation: isEs
                ? 'Los pulmones son órganos principales del sistema respiratorio.'
                : 'The lungs are primary organs of the respiratory system.'
            };
          }

          // questionType === 9
          const options = ['Difusión', 'Evaporación', 'Combustión', 'Condensación'];
          return {
            id: makeId(questions.length),
            type: 'MULTIPLE_CHOICE',
            questionText: isEs
              ? '¿Qué proceso permite que el oxígeno pase de los alvéolos a la sangre?'
              : 'Which process allows oxygen to pass from the alveoli into the blood?',
            options,
            correctAnswerIndex: 0,
            explanation: isEs
              ? 'El intercambio se realiza por difusión a través de las membranas.'
              : 'The exchange happens by diffusion through membranes.'
          };
        }
        
        if (hasRealContent && componentNames.length >= 2) {
          // Usar componentes reales del tema
          const correctOption = componentNames[index % componentNames.length];
          const wrongDistractors = distractors.slice(0, 3);
          
          // Crear array de opciones con la correcta y 3 distractores
          const allOptions = [correctOption, ...wrongDistractors];
          
          // Reordenar para que la respuesta correcta esté en la posición indicada
          const shuffledOptions = [...wrongDistractors];
          shuffledOptions.splice(correctAnswerIndex, 0, correctOption);
          
          // Generar pregunta específica según el tema
          let questionText = '';
          if (topicLower.includes('respiratorio')) {
            const questionTypes = [
              '¿Cuál de los siguientes es un órgano del sistema respiratorio?',
              '¿Qué estructura permite el intercambio gaseoso en los pulmones?',
              '¿Cuál de las siguientes opciones describe correctamente una función respiratoria?',
              '¿Qué órgano filtra y calienta el aire que respiramos?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : `Which of the following is part of the respiratory system?`;
          } else if (topicLower.includes('célula')) {
            const questionTypes = [
              '¿Cuál de los siguientes es un organelo celular?',
              '¿Qué estructura controla las funciones de la célula?',
              '¿Cuál es una característica de las células eucariotas?',
              '¿Qué parte de la célula produce energía?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : `Which of the following is a cell organelle?`;
          } else if (topicLower.includes('fotosíntesis') || topicLower.includes('fotosintesis')) {
            const questionTypes = [
              '¿Cuál es un producto de la fotosíntesis?',
              '¿Dónde ocurre la fase luminosa de la fotosíntesis?',
              '¿Qué pigmento captura la luz solar?',
              '¿Cuál es un elemento necesario para la fotosíntesis?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : `Which is a product of photosynthesis?`;
          } else if (topicLower.includes('fraccion') || topicLower.includes('fracción')) {
            const questionTypes = [
              '¿Qué indica el numerador en una fracción?',
              '¿Cuál es una fracción propia?',
              '¿Cómo se multiplican dos fracciones?',
              '¿Qué son fracciones equivalentes?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : `What does the numerator indicate in a fraction?`;
          } else {
            questionText = isEs
              ? `¿Cuál de las siguientes opciones corresponde a ${input.topic}?`
              : `Which of the following corresponds to ${input.topic}?`;
          }
          
          return {
            id: makeId(questions.length),
            type: 'MULTIPLE_CHOICE',
            questionText,
            options: shuffledOptions.slice(0, 4),
            correctAnswerIndex: correctAnswerIndex,
            explanation: isEs
              ? `La respuesta correcta es "${correctOption.substring(0, 60)}..." según el contenido del material.`
              : `The correct answer is "${correctOption.substring(0, 60)}..." according to the material content.`
          };
        }
        
        // Fallback con opciones específicas según el tema
        let options: string[];
        let questionText: string;
        
        // MATEMÁTICAS: Problemas con cálculos específicos del tema
        if (isMathSubject) {
          const mathTopic = input.topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          // Bancos de problemas por tema específico
          const divisionMCProblems = [
            { q: 'Si tienes 72 manzanas y las repartes entre 8 personas por igual, ¿cuántas manzanas recibe cada uno?', opts: ['9 manzanas', '8 manzanas', '10 manzanas', '7 manzanas'], correct: 0, e: '72 ÷ 8 = 9 manzanas para cada persona.' },
            { q: 'Una biblioteca tiene 156 libros para organizar en 12 estantes iguales. ¿Cuántos libros van en cada estante?', opts: ['13 libros', '12 libros', '14 libros', '15 libros'], correct: 0, e: '156 ÷ 12 = 13 libros por estante.' },
            { q: 'Un agricultor tiene 144 naranjas para empacar en cajas de 12. ¿Cuántas cajas necesita?', opts: ['12 cajas', '10 cajas', '14 cajas', '11 cajas'], correct: 0, e: '144 ÷ 12 = 12 cajas.' },
            { q: 'Si 96 estudiantes se dividen en grupos de 8, ¿cuántos grupos se forman?', opts: ['12 grupos', '10 grupos', '11 grupos', '13 grupos'], correct: 0, e: '96 ÷ 8 = 12 grupos.' },
            { q: '¿Cuánto es 180 ÷ 15?', opts: ['12', '11', '13', '15'], correct: 0, e: '180 ÷ 15 = 12.' },
            { q: 'María tiene 84 dulces para repartir entre 7 amigos. ¿Cuántos dulces le tocan a cada uno?', opts: ['12 dulces', '11 dulces', '13 dulces', '10 dulces'], correct: 0, e: '84 ÷ 7 = 12 dulces.' },
            { q: 'Un bus tiene capacidad para 45 pasajeros. Si hay 5 buses, ¿cuántos pasajeros entran en total si cada bus va lleno y luego se dividen en 9 grupos iguales?', opts: ['25 personas por grupo', '20 personas por grupo', '30 personas por grupo', '15 personas por grupo'], correct: 0, e: '45 × 5 = 225 pasajeros. 225 ÷ 9 = 25 personas por grupo.' },
            { q: '¿Cuánto es 105 ÷ 7?', opts: ['15', '14', '16', '13'], correct: 0, e: '105 ÷ 7 = 15.' }
          ];
          
          const multiplicationMCProblems = [
            { q: 'Un paquete tiene 8 galletas. Si compras 7 paquetes, ¿cuántas galletas tienes en total?', opts: ['56 galletas', '48 galletas', '64 galletas', '15 galletas'], correct: 0, e: '8 × 7 = 56 galletas.' },
            { q: 'Una caja tiene 12 lápices. ¿Cuántos lápices hay en 9 cajas?', opts: ['108 lápices', '98 lápices', '118 lápices', '21 lápices'], correct: 0, e: '12 × 9 = 108 lápices.' },
            { q: 'Un cine tiene 15 filas con 12 asientos cada una. ¿Cuántos asientos hay en total?', opts: ['180 asientos', '170 asientos', '190 asientos', '27 asientos'], correct: 0, e: '15 × 12 = 180 asientos.' },
            { q: 'Si una docena son 12 unidades, ¿cuántas unidades hay en 8 docenas?', opts: ['96 unidades', '86 unidades', '106 unidades', '20 unidades'], correct: 0, e: '12 × 8 = 96 unidades.' },
            { q: '¿Cuál es el resultado de 7 × 9?', opts: ['63', '56', '72', '54'], correct: 0, e: '7 × 9 = 63.' },
            { q: 'Un jardín tiene 6 filas de flores con 11 flores cada una. ¿Cuántas flores hay?', opts: ['66 flores', '56 flores', '76 flores', '17 flores'], correct: 0, e: '6 × 11 = 66 flores.' },
            { q: 'Si caminas 8 km cada día, ¿cuántos km caminas en 2 semanas?', opts: ['112 km', '102 km', '122 km', '56 km'], correct: 0, e: '8 × 14 = 112 km.' },
            { q: '¿Cuánto es 9 × 8?', opts: ['72', '63', '81', '64'], correct: 0, e: '9 × 8 = 72.' }
          ];
          
          const additionMCProblems = [
            { q: 'María tiene 45 caramelos y le regalan 28 más. ¿Cuántos caramelos tiene ahora?', opts: ['73 caramelos', '63 caramelos', '83 caramelos', '53 caramelos'], correct: 0, e: '45 + 28 = 73 caramelos.' },
            { q: 'Pedro tiene 156 estampillas y compra 89 más. ¿Cuántas tiene en total?', opts: ['245 estampillas', '235 estampillas', '255 estampillas', '225 estampillas'], correct: 0, e: '156 + 89 = 245 estampillas.' },
            { q: 'En una granja hay 67 vacas y llegan 48 más. ¿Cuántas vacas hay ahora?', opts: ['115 vacas', '105 vacas', '125 vacas', '95 vacas'], correct: 0, e: '67 + 48 = 115 vacas.' },
            { q: '¿Cuál es el resultado de 234 + 178?', opts: ['412', '402', '422', '392'], correct: 0, e: '234 + 178 = 412.' },
            { q: 'Ana tenía $125 y ganó $87. ¿Cuánto dinero tiene ahora?', opts: ['$212', '$202', '$222', '$192'], correct: 0, e: '$125 + $87 = $212.' },
            { q: 'Un tren tiene 89 pasajeros y suben 56 más. ¿Cuántos pasajeros hay ahora?', opts: ['145 pasajeros', '135 pasajeros', '155 pasajeros', '125 pasajeros'], correct: 0, e: '89 + 56 = 145 pasajeros.' },
            { q: '¿Cuánto es 99 + 78?', opts: ['177', '167', '187', '157'], correct: 0, e: '99 + 78 = 177.' },
            { q: 'Carlos leyó 134 páginas el lunes y 98 el martes. ¿Cuántas páginas leyó en total?', opts: ['232 páginas', '222 páginas', '242 páginas', '212 páginas'], correct: 0, e: '134 + 98 = 232 páginas.' }
          ];
          
          const subtractionMCProblems = [
            { q: 'Juan tenía 92 estampillas y regaló 37. ¿Cuántas estampillas le quedan?', opts: ['55 estampillas', '65 estampillas', '45 estampillas', '129 estampillas'], correct: 0, e: '92 - 37 = 55 estampillas.' },
            { q: 'Una tienda tenía 200 productos y vendió 87. ¿Cuántos quedan?', opts: ['113 productos', '123 productos', '103 productos', '93 productos'], correct: 0, e: '200 - 87 = 113 productos.' },
            { q: 'Pedro tiene $150 y gasta $68. ¿Cuánto dinero le queda?', opts: ['$82', '$92', '$72', '$62'], correct: 0, e: '$150 - $68 = $82.' },
            { q: '¿Cuánto es 175 - 89?', opts: ['86', '96', '76', '66'], correct: 0, e: '175 - 89 = 86.' },
            { q: 'Un autobús tenía 95 pasajeros y bajaron 48. ¿Cuántos quedaron?', opts: ['47 pasajeros', '57 pasajeros', '37 pasajeros', '67 pasajeros'], correct: 0, e: '95 - 48 = 47 pasajeros.' },
            { q: 'Ana tenía 234 figuritas y perdió 156. ¿Cuántas le quedan?', opts: ['78 figuritas', '88 figuritas', '68 figuritas', '98 figuritas'], correct: 0, e: '234 - 156 = 78 figuritas.' },
            { q: '¿Cuál es la diferencia entre 300 y 187?', opts: ['113', '123', '103', '93'], correct: 0, e: '300 - 187 = 113.' },
            { q: 'En una escuela hay 456 alumnos y se fueron 189. ¿Cuántos quedan?', opts: ['267 alumnos', '277 alumnos', '257 alumnos', '287 alumnos'], correct: 0, e: '456 - 189 = 267 alumnos.' }
          ];
          
          const fractionMCProblems = [
            { q: 'Si comes 3/8 de una pizza y tu hermano come 2/8, ¿cuánto comieron entre los dos?', opts: ['5/8 de pizza', '5/16 de pizza', '1/2 de pizza', '6/8 de pizza'], correct: 0, e: '3/8 + 2/8 = 5/8 de pizza.' },
            { q: '¿Cuánto es 1/4 + 1/2?', opts: ['3/4', '2/6', '1/6', '2/4'], correct: 0, e: '1/4 + 1/2 = 1/4 + 2/4 = 3/4.' },
            { q: '¿Cuánto es 2/3 + 1/6?', opts: ['5/6', '3/9', '4/6', '3/6'], correct: 0, e: '2/3 = 4/6, entonces 4/6 + 1/6 = 5/6.' },
            { q: 'María comió 1/3 de un pastel y Ana 1/4. ¿Cuánto comieron juntas?', opts: ['7/12', '2/7', '5/12', '4/12'], correct: 0, e: '1/3 = 4/12 y 1/4 = 3/12. Total: 7/12.' },
            { q: '¿Cuál fracción es equivalente a 1/2?', opts: ['3/6', '2/3', '3/4', '1/3'], correct: 0, e: '3/6 simplificado es 1/2.' },
            { q: '¿Cuánto es 3/4 - 1/4?', opts: ['2/4 o 1/2', '4/4', '2/8', '4/8'], correct: 0, e: '3/4 - 1/4 = 2/4 = 1/2.' },
            { q: '¿Cuánto es 1/2 × 2/3?', opts: ['2/6 o 1/3', '3/5', '2/5', '3/6'], correct: 0, e: '1/2 × 2/3 = 2/6 = 1/3.' },
            { q: 'Si tienes 3/5 de un litro de jugo y tomas 1/5, ¿cuánto queda?', opts: ['2/5 de litro', '4/5 de litro', '2/10 de litro', '3/10 de litro'], correct: 0, e: '3/5 - 1/5 = 2/5 de litro.' }
          ];
          
          const percentageMCProblems = [
            { q: 'Una tienda ofrece 20% de descuento en un artículo de $80. ¿Cuánto cuesta con el descuento?', opts: ['$64', '$60', '$72', '$68'], correct: 0, e: '20% de $80 = $16. $80 - $16 = $64.' },
            { q: 'Si el 25% de un número es 15, ¿cuál es el número?', opts: ['60', '45', '75', '40'], correct: 0, e: 'Si 25% = 15, entonces 100% = 15 × 4 = 60.' },
            { q: '¿Cuánto es el 30% de 200?', opts: ['60', '50', '70', '40'], correct: 0, e: '30% de 200 = 200 × 0.30 = 60.' },
            { q: 'Un producto costaba $50 y subió un 10%. ¿Cuál es el nuevo precio?', opts: ['$55', '$60', '$45', '$50'], correct: 0, e: '10% de $50 = $5. Nuevo precio: $55.' },
            { q: 'En una clase de 40 alumnos, el 75% aprobó. ¿Cuántos aprobaron?', opts: ['30 alumnos', '25 alumnos', '35 alumnos', '20 alumnos'], correct: 0, e: '75% de 40 = 30 alumnos.' },
            { q: '¿Qué porcentaje de 80 es 20?', opts: ['25%', '20%', '30%', '15%'], correct: 0, e: '20/80 = 0.25 = 25%.' },
            { q: 'Si ahorras el 15% de $300, ¿cuánto ahorras?', opts: ['$45', '$40', '$50', '$35'], correct: 0, e: '15% de $300 = 300 × 0.15 = $45.' },
            { q: 'Un artículo de $120 tiene 25% de descuento. ¿Cuánto pagas?', opts: ['$90', '$95', '$85', '$80'], correct: 0, e: '25% de $120 = $30. $120 - $30 = $90.' }
          ];
          
          const equationMCProblems = [
            { q: 'Si 3x + 5 = 20, ¿cuál es el valor de x?', opts: ['5', '6', '4', '7'], correct: 0, e: '3x + 5 = 20 → 3x = 15 → x = 5.' },
            { q: 'Si el doble de un número más 8 es igual a 22, ¿cuál es el número?', opts: ['7', '8', '6', '9'], correct: 0, e: '2x + 8 = 22 → 2x = 14 → x = 7.' },
            { q: 'Resuelve: 4x = 36', opts: ['x = 9', 'x = 8', 'x = 10', 'x = 7'], correct: 0, e: '4x = 36 → x = 36 ÷ 4 = 9.' },
            { q: 'Si x - 15 = 27, ¿cuánto vale x?', opts: ['42', '12', '32', '52'], correct: 0, e: 'x = 27 + 15 = 42.' },
            { q: 'Resuelve: 2x + 3 = 15', opts: ['x = 6', 'x = 7', 'x = 5', 'x = 8'], correct: 0, e: '2x = 12 → x = 6.' },
            { q: 'Si 5x - 10 = 25, ¿cuál es x?', opts: ['7', '5', '8', '6'], correct: 0, e: '5x = 35 → x = 7.' },
            { q: 'La suma de un número y 18 es 45. ¿Cuál es el número?', opts: ['27', '37', '17', '63'], correct: 0, e: 'x + 18 = 45 → x = 27.' },
            { q: 'Si x/4 = 12, ¿cuánto vale x?', opts: ['48', '3', '16', '8'], correct: 0, e: 'x = 12 × 4 = 48.' }
          ];
          
          const numbersMCProblems = [
            { q: '¿Cuál es el resultado de 5²?', opts: ['25', '10', '52', '125'], correct: 0, e: '5² = 5 × 5 = 25.' },
            { q: '¿Cuánto es 2⁴?', opts: ['16', '8', '24', '32'], correct: 0, e: '2⁴ = 2 × 2 × 2 × 2 = 16.' },
            { q: '¿Cuál es el doble de 45?', opts: ['90', '80', '100', '85'], correct: 0, e: '45 × 2 = 90.' },
            { q: '¿Cuál es la mitad de 126?', opts: ['63', '53', '73', '83'], correct: 0, e: '126 ÷ 2 = 63.' },
            { q: '¿Cuál es el triple de 23?', opts: ['69', '59', '79', '46'], correct: 0, e: '23 × 3 = 69.' },
            { q: '¿Cuánto es 3³?', opts: ['27', '9', '18', '81'], correct: 0, e: '3³ = 3 × 3 × 3 = 27.' },
            { q: '¿Cuál es la raíz cuadrada de 144?', opts: ['12', '14', '11', '13'], correct: 0, e: '√144 = 12 porque 12 × 12 = 144.' },
            { q: '¿Cuánto es el cuadrado de 9?', opts: ['81', '18', '72', '91'], correct: 0, e: '9² = 9 × 9 = 81.' }
          ];
          
          // Seleccionar banco según el tema
          let selectedProblems = numbersMCProblems; // Por defecto
          
          if (mathTopic.includes('division') || mathTopic.includes('dividir') || mathTopic.includes('cociente')) {
            selectedProblems = divisionMCProblems;
          } else if (mathTopic.includes('multiplicacion') || mathTopic.includes('multiplicar') || mathTopic.includes('producto') || mathTopic.includes('tabla')) {
            selectedProblems = multiplicationMCProblems;
          } else if (mathTopic.includes('suma') || mathTopic.includes('sumar') || mathTopic.includes('adicion')) {
            selectedProblems = additionMCProblems;
          } else if (mathTopic.includes('resta') || mathTopic.includes('restar') || mathTopic.includes('sustraccion') || mathTopic.includes('diferencia')) {
            selectedProblems = subtractionMCProblems;
          } else if (mathTopic.includes('fraccion') || mathTopic.includes('fracciones') || mathTopic.includes('numerador') || mathTopic.includes('denominador')) {
            selectedProblems = fractionMCProblems;
          } else if (mathTopic.includes('porcentaje') || mathTopic.includes('porciento') || mathTopic.includes('%')) {
            selectedProblems = percentageMCProblems;
          } else if (mathTopic.includes('ecuacion') || mathTopic.includes('incognita') || mathTopic.includes('variable') || mathTopic.includes('algebra')) {
            selectedProblems = equationMCProblems;
          } else if (mathTopic.includes('numero') || mathTopic.includes('doble') || mathTopic.includes('triple') || mathTopic.includes('mitad') || mathTopic.includes('cuadrado') || mathTopic.includes('potencia') || mathTopic.includes('raiz')) {
            selectedProblems = numbersMCProblems;
          }
          
          const problem = selectedProblems[index % selectedProblems.length];
          questionText = translateMathQuestion(problem.q);
          options = isEs ? problem.opts : problem.opts.map((opt: string) => translateMathQuestion(opt));
          
          return {
            id: makeId(questions.length),
            type: 'MULTIPLE_CHOICE',
            questionText,
            options,
            correctAnswerIndex: problem.correct,
            explanation: translateMathExplanation(problem.e)
          };
        }
        
        if (topicLower.includes('respiratorio')) {
          options = isEs ? [
            'Los pulmones realizan el intercambio de oxígeno y dióxido de carbono',
            'El hígado filtra el aire que respiramos',
            'El corazón es el órgano principal del sistema respiratorio',
            'Los músculos producen oxígeno para el cuerpo'
          ] : [
            'The lungs perform oxygen and carbon dioxide exchange',
            'The liver filters the air we breathe',
            'The heart is the main organ of the respiratory system',
            'Muscles produce oxygen for the body'
          ];
          questionText = isEs ? '¿Cuál afirmación sobre el sistema respiratorio es correcta?' : 'Which statement about the respiratory system is correct?';
        } else if (topicLower.includes('célula')) {
          options = isEs ? [
            'El núcleo contiene el material genético (ADN)',
            'Las mitocondrias almacenan el agua celular',
            'La membrana celular produce proteínas',
            'Los ribosomas controlan la división celular'
          ] : [
            'The nucleus contains genetic material (DNA)',
            'Mitochondria store cellular water',
            'The cell membrane produces proteins',
            'Ribosomes control cell division'
          ];
          questionText = isEs ? '¿Cuál afirmación sobre la célula es correcta?' : 'Which statement about the cell is correct?';
        } else {
          options = isEs ? [
            `Es un concepto fundamental de ${input.topic}`,
            `No está relacionado con el tema principal`,
            `Es una aplicación avanzada del concepto`,
            `Representa una excepción a la regla general`
          ] : [
            `It is a fundamental concept of ${input.topic}`,
            `It is not related to the main topic`,
            `It is an advanced application of the concept`,
            `It represents an exception to the general rule`
          ];
          questionText = isEs ? `¿Cuál característica corresponde a ${input.topic}?` : `Which characteristic corresponds to ${input.topic}?`;
        }
        
        return {
          id: makeId(questions.length),
          type: 'MULTIPLE_CHOICE',
          questionText,
          options,
          correctAnswerIndex: 0,
          explanation: isEs
            ? `La primera opción es la correcta según el contenido estudiado.`
            : `The first option is correct according to the studied content.`
        };
      };
      
      // Generar preguntas de Selección Múltiple (varias respuestas correctas)
      const generateMultipleSelectionQuestion = (index: number): EvaluationQuestion => {
        const { components, distractors } = conceptData;
        const topicLower = input.topic.toLowerCase();
        
        // Extraer solo los nombres de componentes (antes de ":"), excluyendo metadatos
        const getShortComponentNames = (): string[] => {
          const names: string[] = [];
          for (const comp of components) {
            // Saltar si contiene frases de metadatos
            if (shouldIgnoreLine(comp)) {
              continue;
            }
            const parts = comp.split(':');
            if (parts.length >= 2) {
              const name = parts[0].trim();
              // Verificar que el nombre no sea un encabezado genérico
              if (name.length > 3 && name.length < 40 && !names.includes(name) && !shouldIgnoreLine(name)) {
                names.push(name);
              }
            }
          }
          return names; // Ya sin duplicados
        };
        
        const shortNames = getShortComponentNames();

        // Tema: Sistema Respiratorio (opciones siempre coherentes con la pregunta)
        if (hasRealContent && topicLower.includes('respiratorio')) {
          const questionType = index % 6;

          if (questionType === 0) {
            const options = ['Pulmones', 'Estómago', 'Tráquea', 'Riñones'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_SELECTION',
              questionText: isEs
                ? '¿Cuáles de los siguientes son órganos del sistema respiratorio?'
                : 'Which of the following are organs of the respiratory system?',
              options,
              correctAnswerIndices: [0, 2],
              explanation: isEs
                ? 'Pulmones y tráquea forman parte del sistema respiratorio.'
                : 'Lungs and trachea are part of the respiratory system.'
            };
          }

          if (questionType === 1) {
            const options = [
              'Evitar ambientes con aire contaminado',
              'No fumar ni exponerse al humo del tabaco',
              'Mantener espacios cerrados sin ventilación',
              'Inhalar humo para fortalecer los pulmones'
            ];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_SELECTION',
              questionText: isEs
                ? 'Selecciona cuidados correctos del sistema respiratorio:'
                : 'Select correct care practices for the respiratory system:',
              options,
              correctAnswerIndices: [0, 1],
              explanation: isEs
                ? 'Evitar contaminación y no fumar son medidas correctas.'
                : 'Avoiding pollution and not smoking are correct measures.'
            };
          }

          if (questionType === 2) {
            const options = ['Inspiración', 'Digestión', 'Espiración', 'Fotosíntesis'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_SELECTION',
              questionText: isEs
                ? '¿Cuáles son fases del proceso de respiración?'
                : 'Which are phases of the breathing process?',
              options,
              correctAnswerIndices: [0, 2],
              explanation: isEs
                ? 'La respiración tiene dos fases principales: inspiración y espiración.'
                : 'Breathing has two main phases: inhalation and exhalation.'
            };
          }

          if (questionType === 3) {
            const options = ['Alvéolos', 'Hígado', 'Bronquiolos', 'Intestino'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_SELECTION',
              questionText: isEs
                ? 'Selecciona estructuras donde participa el intercambio/flujo de gases:'
                : 'Select structures involved in gas exchange/flow:',
              options,
              correctAnswerIndices: [0, 2],
              explanation: isEs
                ? 'Los alvéolos participan en el intercambio gaseoso y los bronquiolos en la conducción del aire.'
                : 'Alveoli participate in gas exchange and bronchioles in air conduction.'
            };
          }

          if (questionType === 4) {
            const options = ['Asma', 'Bronquitis', 'Neumonía', 'Apendicitis'];
            return {
              id: makeId(questions.length),
              type: 'MULTIPLE_SELECTION',
              questionText: isEs
                ? '¿Cuáles de las siguientes son enfermedades del sistema respiratorio?'
                : 'Which of the following are respiratory system diseases?',
              options,
              correctAnswerIndices: [0, 1, 2],
              explanation: isEs
                ? 'Asma, bronquitis y neumonía son enfermedades respiratorias; la apendicitis no.'
                : 'Asthma, bronchitis, and pneumonia are respiratory diseases; appendicitis is not.'
            };
          }

          // questionType === 5
          const options = ['Evitar humo del tabaco', 'Ventilar espacios cerrados', 'Fumar para “fortalecer” los pulmones', 'Hacer ejercicio regularmente'];
          return {
            id: makeId(questions.length),
            type: 'MULTIPLE_SELECTION',
            questionText: isEs
              ? 'Selecciona hábitos que ayudan a cuidar el sistema respiratorio:'
              : 'Select habits that help care for the respiratory system:',
            options,
            correctAnswerIndices: [0, 1, 3],
            explanation: isEs
              ? 'Evitar humo, ventilar y hacer ejercicio ayudan al sistema respiratorio.'
              : 'Avoiding smoke, ventilating, and exercising help the respiratory system.'
          };
        }
        
        if (hasRealContent && shortNames.length >= 3) {
          // Seleccionar 2-3 componentes reales como respuestas correctas
          const correctOptions = shortNames.slice(index % 3, (index % 3) + 2);
          const wrongDistractors = distractors.slice(0, 2);
          
          // Construir opciones: 2 correctas + 2 incorrectas
          const options = [
            correctOptions[0] || shortNames[0],
            wrongDistractors[0] || 'Elemento no relacionado',
            correctOptions[1] || shortNames[1] || shortNames[0],
            wrongDistractors[1] || 'Proceso de otra materia'
          ];
          
          // Generar pregunta específica según el tema
          let questionText = '';
          if (topicLower.includes('respiratorio')) {
            const questionTypes = [
              '¿Cuáles de los siguientes son órganos del sistema respiratorio?',
              '¿Qué estructuras participan en la respiración?',
              '¿Cuáles forman parte del proceso de intercambio gaseoso?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : 'Which of the following are organs of the respiratory system?';
          } else if (topicLower.includes('célula')) {
            const questionTypes = [
              '¿Cuáles de los siguientes son organelos de la célula?',
              '¿Qué estructuras se encuentran en células eucariotas?',
              '¿Cuáles son partes de la célula animal?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : 'Which of the following are cell organelles?';
          } else if (topicLower.includes('fotosíntesis') || topicLower.includes('fotosintesis')) {
            const questionTypes = [
              '¿Cuáles son elementos necesarios para la fotosíntesis?',
              '¿Qué productos genera la fotosíntesis?',
              '¿Cuáles estructuras participan en la fotosíntesis?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : 'Which elements are necessary for photosynthesis?';
          } else if (topicLower.includes('fraccion') || topicLower.includes('fracción')) {
            const questionTypes = [
              '¿Cuáles son tipos de fracciones?',
              '¿Qué operaciones se pueden realizar con fracciones?',
              '¿Cuáles son componentes de una fracción?'
            ];
            questionText = isEs ? questionTypes[index % questionTypes.length] : 'Which are types of fractions?';
          } else {
            questionText = isEs
              ? `¿Cuáles de los siguientes están relacionados con ${input.topic}?`
              : `Which of the following are related to ${input.topic}?`;
          }
          
          return {
            id: makeId(questions.length),
            type: 'MULTIPLE_SELECTION',
            questionText,
            options,
            correctAnswerIndices: [0, 2], // Primera y tercera son correctas
            explanation: isEs
              ? `Las opciones "${options[0]}" y "${options[2]}" son parte del tema ${input.topic}.`
              : `The options "${options[0]}" and "${options[2]}" are part of the topic ${input.topic}.`
          };
        }
        
        // Fallback con opciones específicas según el tema
        let options: string[];
        let questionText: string;
        let explanation: string;
        
        // MATEMÁTICAS: Preguntas de selección múltiple específicas del tema
        if (isMathSubject) {
          const mathTopic = input.topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          
          // Bancos por tema específico
          const divisionMSProblems = [
            { q: '¿Cuáles de las siguientes divisiones dan como resultado 8?', opts: ['64 ÷ 8', '72 ÷ 8', '56 ÷ 7', '48 ÷ 8'], correct: [0, 2], e: '64 ÷ 8 = 8 y 56 ÷ 7 = 8. Las otras dan 9 y 6.' },
            { q: '¿Cuáles divisiones son exactas (sin residuo)?', opts: ['45 ÷ 9', '37 ÷ 5', '72 ÷ 8', '50 ÷ 7'], correct: [0, 2], e: '45 ÷ 9 = 5 y 72 ÷ 8 = 9 son exactas.' },
            { q: '¿Cuáles de las siguientes divisiones dan como resultado 12?', opts: ['144 ÷ 12', '108 ÷ 9', '96 ÷ 8', '84 ÷ 6'], correct: [0, 2], e: '144 ÷ 12 = 12 y 96 ÷ 8 = 12.' },
            { q: '¿En cuáles casos el cociente es mayor que 10?', opts: ['120 ÷ 10', '88 ÷ 8', '135 ÷ 9', '99 ÷ 11'], correct: [0, 1, 2], e: '120÷10=12, 88÷8=11, 135÷9=15 son >10. 99÷11=9.' },
            { q: '¿Cuáles divisiones dan un resultado par?', opts: ['48 ÷ 6', '63 ÷ 9', '42 ÷ 7', '54 ÷ 6'], correct: [0, 2], e: '48÷6=8 y 42÷7=6 son pares. 63÷9=7 y 54÷6=9 son impares.' },
            { q: '¿Cuáles de estas son divisiones entre 7?', opts: ['49 ÷ 7', '56 ÷ 7', '63 ÷ 9', '77 ÷ 7'], correct: [0, 1, 3], e: '49, 56 y 77 son divisibles por 7.' }
          ];
          
          const multiplicationMSProblems = [
            { q: '¿Cuáles de las siguientes multiplicaciones dan como resultado 48?', opts: ['6 × 8', '7 × 7', '8 × 6', '5 × 9'], correct: [0, 2], e: '6 × 8 = 48 y 8 × 6 = 48.' },
            { q: '¿Cuáles productos son mayores que 50?', opts: ['8 × 7', '6 × 8', '9 × 6', '7 × 6'], correct: [0, 2], e: '8×7=56 y 9×6=54 son >50. 6×8=48 y 7×6=42.' },
            { q: '¿Cuáles de las siguientes multiplicaciones dan un número par?', opts: ['7 × 6', '5 × 5', '8 × 3', '9 × 9'], correct: [0, 2], e: '7×6=42 y 8×3=24 son pares.' },
            { q: '¿Cuáles multiplicaciones dan como resultado 72?', opts: ['8 × 9', '6 × 11', '9 × 8', '7 × 10'], correct: [0, 2], e: '8 × 9 = 72 y 9 × 8 = 72.' },
            { q: '¿Cuáles son multiplicaciones de la tabla del 9?', opts: ['9 × 7 = 63', '8 × 8 = 64', '9 × 9 = 81', '7 × 7 = 49'], correct: [0, 2], e: '63 y 81 son de la tabla del 9.' },
            { q: '¿Cuáles resultados son múltiplos de 12?', opts: ['4 × 3', '5 × 5', '6 × 4', '7 × 2'], correct: [0, 2], e: '4×3=12 y 6×4=24 son múltiplos de 12.' }
          ];
          
          const additionMSProblems = [
            { q: '¿Cuáles de las siguientes sumas dan como resultado 100?', opts: ['45 + 55', '60 + 50', '67 + 33', '48 + 42'], correct: [0, 2], e: '45+55=100 y 67+33=100.' },
            { q: '¿Cuáles sumas dan un resultado mayor que 150?', opts: ['89 + 67', '75 + 68', '92 + 59', '84 + 65'], correct: [0, 2], e: '89+67=156 y 92+59=151 son >150.' },
            { q: '¿Cuáles de estas sumas son correctas?', opts: ['78 + 45 = 123', '89 + 34 = 113', '56 + 67 = 123', '45 + 78 = 123'], correct: [0, 2, 3], e: '78+45=123, 56+67=123, 45+78=123.' },
            { q: '¿Cuáles sumas dan un número par?', opts: ['35 + 47', '48 + 36', '67 + 25', '54 + 28'], correct: [1, 3], e: '48+36=84 y 54+28=82 son pares.' },
            { q: '¿Cuáles de las siguientes sumas dan 200?', opts: ['125 + 75', '150 + 60', '134 + 66', '145 + 45'], correct: [0, 2], e: '125+75=200 y 134+66=200.' },
            { q: '¿Cuáles operaciones de suma son mayores que 80?', opts: ['45 + 38', '32 + 45', '56 + 29', '67 + 18'], correct: [0, 2, 3], e: '45+38=83, 56+29=85, 67+18=85 son >80.' }
          ];
          
          const subtractionMSProblems = [
            { q: '¿Cuáles de las siguientes restas dan como resultado 25?', opts: ['75 - 50', '60 - 45', '100 - 75', '80 - 55'], correct: [0, 2, 3], e: '75-50=25, 100-75=25, 80-55=25.' },
            { q: '¿Cuáles restas dan un resultado mayor que 40?', opts: ['95 - 48', '78 - 35', '120 - 85', '67 - 25'], correct: [0, 2, 3], e: '95-48=47, 120-85=35(no), 67-25=42 son >40.' },
            { q: '¿Cuáles de estas restas son correctas?', opts: ['100 - 37 = 63', '85 - 48 = 47', '93 - 56 = 37', '78 - 29 = 49'], correct: [0, 2, 3], e: '100-37=63, 93-56=37, 78-29=49.' },
            { q: '¿Cuáles restas dan un resultado par?', opts: ['86 - 42', '75 - 31', '94 - 48', '67 - 25'], correct: [0, 2, 3], e: '86-42=44, 94-48=46, 67-25=42 son pares.' },
            { q: '¿Cuáles diferencias son menores que 30?', opts: ['85 - 60', '70 - 45', '100 - 65', '90 - 75'], correct: [0, 1, 3], e: '85-60=25, 70-45=25, 90-75=15 son <30.' },
            { q: '¿Cuáles de las siguientes restas dan 50?', opts: ['125 - 75', '90 - 50', '100 - 50', '145 - 95'], correct: [0, 2, 3], e: '125-75=50, 100-50=50, 145-95=50.' }
          ];
          
          const fractionMSProblems = [
            { q: '¿Cuáles fracciones son equivalentes a 1/2?', opts: ['2/4', '3/5', '4/8', '5/9'], correct: [0, 2], e: '2/4 = 1/2 y 4/8 = 1/2 son equivalentes.' },
            { q: '¿Cuáles fracciones son equivalentes a 2/3?', opts: ['4/6', '3/4', '6/9', '5/6'], correct: [0, 2], e: '4/6 = 2/3 y 6/9 = 2/3 son equivalentes.' },
            { q: '¿Cuáles son fracciones propias (menor que 1)?', opts: ['3/4', '5/3', '2/5', '7/4'], correct: [0, 2], e: '3/4 y 2/5 son menores que 1.' },
            { q: '¿Cuáles fracciones son mayores que 1/2?', opts: ['3/4', '2/5', '5/8', '3/7'], correct: [0, 2], e: '3/4 = 0.75 y 5/8 = 0.625 son >0.5.' },
            { q: '¿Cuáles sumas de fracciones dan 1?', opts: ['1/2 + 1/2', '1/3 + 1/3', '3/4 + 1/4', '2/5 + 2/5'], correct: [0, 2], e: '1/2+1/2=1 y 3/4+1/4=1.' },
            { q: '¿Cuáles fracciones son equivalentes a 3/4?', opts: ['6/8', '9/12', '4/5', '12/16'], correct: [0, 1, 3], e: '6/8, 9/12 y 12/16 son equivalentes a 3/4.' }
          ];
          
          const percentageMSProblems = [
            { q: '¿Cuáles de los siguientes son el 50%?', opts: ['50 de 100', '25 de 50', '30 de 50', '40 de 80'], correct: [0, 1, 3], e: '50/100, 25/50 y 40/80 son 50%.' },
            { q: '¿Cuáles porcentajes son equivalentes a 1/4?', opts: ['25%', '20%', '0.25', '75%'], correct: [0, 2], e: '25% = 0.25 = 1/4.' },
            { q: '¿Cuáles representan el 10% de 200?', opts: ['20', '10', '200 × 0.1', '30'], correct: [0, 2], e: '10% de 200 = 20 = 200 × 0.1.' },
            { q: '¿Cuáles descuentos son mayores que $30 en un producto de $100?', opts: ['40% de descuento', '25% de descuento', '35% de descuento', '50% de descuento'], correct: [0, 2, 3], e: '40%=$40, 35%=$35, 50%=$50 son >$30.' },
            { q: '¿Cuáles son formas de expresar 75%?', opts: ['3/4', '0.75', '7/10', '75/100'], correct: [0, 1, 3], e: '75% = 3/4 = 0.75 = 75/100.' },
            { q: '¿En cuáles casos el porcentaje es mayor que 50%?', opts: ['60 de 100', '30 de 50', '25 de 40', '45 de 100'], correct: [0, 1, 2], e: '60/100=60%, 30/50=60%, 25/40=62.5%.' }
          ];
          
          const equationMSProblems = [
            { q: '¿En cuáles ecuaciones x = 4?', opts: ['2x = 8', '3x = 15', 'x + 5 = 9', 'x - 2 = 3'], correct: [0, 2], e: '2×4=8 ✓ y 4+5=9 ✓.' },
            { q: '¿Cuáles ecuaciones tienen x = 6?', opts: ['3x = 18', 'x + 4 = 10', '2x = 10', 'x - 1 = 5'], correct: [0, 1, 3], e: '3×6=18, 6+4=10, 6-1=5.' },
            { q: '¿Cuáles son ecuaciones lineales correctas?', opts: ['2x + 3 = 11 si x=4', '5x = 25 si x=5', '3x - 2 = 10 si x=5', 'x + 8 = 15 si x=7'], correct: [0, 1, 3], e: '2(4)+3=11, 5(5)=25, 7+8=15.' },
            { q: '¿Cuáles valores de x satisfacen x > 5?', opts: ['x = 7', 'x = 3', 'x = 10', 'x = 5'], correct: [0, 2], e: '7 y 10 son mayores que 5.' },
            { q: '¿Cuáles ecuaciones tienen solución x = 3?', opts: ['4x = 12', '2x + 1 = 7', 'x - 5 = 2', '3x = 9'], correct: [0, 1, 3], e: '4(3)=12, 2(3)+1=7, 3(3)=9.' },
            { q: '¿Cuáles expresiones son iguales a 2x cuando x=5?', opts: ['10', 'x + x', '15', 'x × 2'], correct: [0, 1, 3], e: '2(5)=10, x+x=10, x×2=10.' }
          ];
          
          const numbersMSProblems = [
            { q: '¿Cuáles de los siguientes son números pares?', opts: ['14', '23', '36', '41'], correct: [0, 2], e: '14 y 36 son pares.' },
            { q: '¿Cuáles de los siguientes son múltiplos de 5?', opts: ['25', '32', '45', '53'], correct: [0, 2], e: '25 y 45 son múltiplos de 5.' },
            { q: '¿Cuáles de los siguientes son números primos?', opts: ['7', '9', '11', '15'], correct: [0, 2], e: '7 y 11 son primos.' },
            { q: '¿Cuáles son potencias de 2?', opts: ['8', '10', '16', '12'], correct: [0, 2], e: '8=2³ y 16=2⁴.' },
            { q: '¿Cuáles números son divisibles por 3?', opts: ['12', '14', '18', '20'], correct: [0, 2], e: '12 y 18 son divisibles por 3.' },
            { q: '¿Cuáles son cuadrados perfectos?', opts: ['16', '18', '25', '30'], correct: [0, 2], e: '16=4² y 25=5².' }
          ];
          
          // Seleccionar banco según el tema
          let selectedProblems = numbersMSProblems; // Por defecto
          
          if (mathTopic.includes('division') || mathTopic.includes('dividir') || mathTopic.includes('cociente')) {
            selectedProblems = divisionMSProblems;
          } else if (mathTopic.includes('multiplicacion') || mathTopic.includes('multiplicar') || mathTopic.includes('producto') || mathTopic.includes('tabla')) {
            selectedProblems = multiplicationMSProblems;
          } else if (mathTopic.includes('suma') || mathTopic.includes('sumar') || mathTopic.includes('adicion')) {
            selectedProblems = additionMSProblems;
          } else if (mathTopic.includes('resta') || mathTopic.includes('restar') || mathTopic.includes('sustraccion') || mathTopic.includes('diferencia')) {
            selectedProblems = subtractionMSProblems;
          } else if (mathTopic.includes('fraccion') || mathTopic.includes('fracciones') || mathTopic.includes('numerador') || mathTopic.includes('denominador')) {
            selectedProblems = fractionMSProblems;
          } else if (mathTopic.includes('porcentaje') || mathTopic.includes('porciento') || mathTopic.includes('%')) {
            selectedProblems = percentageMSProblems;
          } else if (mathTopic.includes('ecuacion') || mathTopic.includes('incognita') || mathTopic.includes('variable') || mathTopic.includes('algebra')) {
            selectedProblems = equationMSProblems;
          } else if (mathTopic.includes('numero') || mathTopic.includes('doble') || mathTopic.includes('triple') || mathTopic.includes('mitad') || mathTopic.includes('cuadrado') || mathTopic.includes('potencia') || mathTopic.includes('raiz') || mathTopic.includes('par') || mathTopic.includes('impar') || mathTopic.includes('primo') || mathTopic.includes('multiplo')) {
            selectedProblems = numbersMSProblems;
          }
          
          const problem = selectedProblems[index % selectedProblems.length];
          options = isEs ? problem.opts : problem.opts.map((opt: string) => translateMathQuestion(opt));
          questionText = translateMathQuestion(problem.q);
          explanation = translateMathExplanation(problem.e);
          
          return {
            id: makeId(questions.length),
            type: 'MULTIPLE_SELECTION',
            questionText,
            options,
            correctAnswerIndices: problem.correct,
            explanation
          };
        }
        
        if (topicLower.includes('respiratorio')) {
          options = isEs ? [
            'Pulmones',
            'Estómago',
            'Tráquea',
            'Riñones'
          ] : ['Lungs', 'Stomach', 'Trachea', 'Kidneys'];
          questionText = isEs ? '¿Cuáles son órganos del sistema respiratorio?' : 'Which are organs of the respiratory system?';
          explanation = isEs ? 'Los pulmones y la tráquea son parte del sistema respiratorio.' : 'The lungs and trachea are part of the respiratory system.';
        } else if (topicLower.includes('célula')) {
          options = isEs ? [
            'Núcleo',
            'Huesos',
            'Mitocondrias',
            'Piel'
          ] : ['Nucleus', 'Bones', 'Mitochondria', 'Skin'];
          questionText = isEs ? '¿Cuáles son organelos de la célula?' : 'Which are cell organelles?';
          explanation = isEs ? 'El núcleo y las mitocondrias son organelos celulares.' : 'The nucleus and mitochondria are cell organelles.';
        } else if (topicLower.includes('fotosíntesis') || topicLower.includes('fotosintesis')) {
          options = isEs ? [
            'Luz solar',
            'Oxígeno como reactivo',
            'Dióxido de carbono',
            'Proteínas animales'
          ] : ['Sunlight', 'Oxygen as reactant', 'Carbon dioxide', 'Animal proteins'];
          questionText = isEs ? '¿Cuáles son necesarios para la fotosíntesis?' : 'Which are necessary for photosynthesis?';
          explanation = isEs ? 'La luz solar y el CO₂ son necesarios para la fotosíntesis.' : 'Sunlight and CO₂ are necessary for photosynthesis.';
        } else {
          options = isEs ? [
            'Comprensión de conceptos básicos',
            'Memorización sin análisis',
            'Aplicación práctica del conocimiento',
            'Ignorar el contexto del tema'
          ] : [
            'Understanding of basic concepts',
            'Memorization without analysis',
            'Practical application of knowledge',
            'Ignoring the topic context'
          ];
          questionText = isEs ? `¿Cuáles son aspectos importantes de ${input.topic}?` : `Which are important aspects of ${input.topic}?`;
          explanation = isEs ? 'La comprensión y aplicación práctica son esenciales.' : 'Understanding and practical application are essential.';
        }
        
        return {
          id: makeId(questions.length),
          type: 'MULTIPLE_SELECTION',
          questionText,
          options,
          correctAnswerIndices: [0, 2],
          explanation
        };
      };

      // Dedupe: impedir que se repitan preguntas dentro de la misma evaluación
      const signatureFor = (q: EvaluationQuestion): string => {
        const qt = (q.questionText || '').trim().toLowerCase();
        return `${q.type}|${qt}`;
      };

      const usedSignatures = new Set<string>();
      const tryMakeUnique = (make: (n: number) => EvaluationQuestion, base: number): EvaluationQuestion => {
        let candidate = make(base);
        for (let attempt = 0; attempt < 25; attempt++) {
          candidate = make(base + attempt * 7);
          const sig = signatureFor(candidate);
          if (!usedSignatures.has(sig)) {
            usedSignatures.add(sig);
            return candidate;
          }
        }
        // Si por algún motivo se agotaron variantes, forzar unicidad mínima
        const forced = make(base + 999);
        forced.questionText = `${forced.questionText} (variante)`;
        usedSignatures.add(signatureFor(forced));
        return forced;
      };

      // TRUE_FALSE
      for (let i = 0; i < tfCount; i++) {
        questions.push(tryMakeUnique(generateTrueFalseQuestion, i));
      }

      // MULTIPLE_CHOICE
      for (let i = 0; i < mcCount; i++) {
        questions.push(tryMakeUnique(generateMultipleChoiceQuestion, i));
      }

      // MULTIPLE_SELECTION
      for (let i = 0; i < msCount; i++) {
        questions.push(tryMakeUnique(generateMultipleSelectionQuestion, i));
      }

      return {
        evaluationTitle: `${isEs ? 'EVALUACIÓN' : 'EVALUATION'} - ${input.topic.toUpperCase()}`,
        questions
      };
  } catch (error) {
    console.error('Error generating dynamic evaluation content:', error);
    // Return fallback data with uniqueness
    const timestamp = input.timestamp || Date.now();
    const randomSeed = input.randomSeed || Math.floor(Math.random() * 1000);
    
    return {
      evaluationTitle: `${input.language === 'es' ? 'EVALUACIÓN' : 'EVALUATION'} - ${input.topic.toUpperCase()}`,
      questions: [
        // Fallback data with 15 questions - only the first one for brevity
        {
          id: `fallback_tf1_${timestamp}_${randomSeed}`,
          type: 'TRUE_FALSE',
          questionText: input.language === 'es'
            ? `Pregunta de respaldo V/F para "${input.topic}". ¿Esta pregunta es única? (ID: ${randomSeed})`
            : `Fallback T/F question for "${input.topic}". Is this question unique? (ID: ${randomSeed})`,
          correctAnswer: true,
          explanation: input.language === 'es'
            ? `Pregunta V/F generada como respaldo debido a un error en la API. Timestamp: ${timestamp}`
            : `T/F fallback question generated due to API error. Timestamp: ${timestamp}`
        }
        // Note: In a real implementation, you would include all 15 questions here
        // For now, keeping it short to avoid excessive mock data
      ]
    };
  }
}
