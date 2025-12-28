/**
 * @fileOverview Generates a mind map image from a central theme and book content.
 * This involves two steps:
 * 1. Generating a structured representation of the mind map (nodes and sub-nodes).
 * 2. Rendering this structured data as a mind map image, allowing for horizontal or vertical orientation.
 *
 * - createMindMap - A function that generates a mind map image.
 * - CreateMindMapInput - The input type for the createMindMap function.
 * - CreateMindMapOutput - The return type for the createMindMap function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import { getContentGenerationContext, generateAIPromptInstructions } from '@/lib/topic-descriptions';

// Input for the entire flow
const CreateMindMapInputSchema = z.object({
  centralTheme: z.string().describe('The central theme of the mind map.'),
  themeDescription: z.string().optional().describe('A description of the theme that provides orientation and context.'),
  bookTitle: z.string().describe('The title of the book to provide context for the mind map content.'),
  courseName: z.string().optional().describe('The course/grade level for age-appropriate content.'),
  language: z.enum(['es', 'en']).describe('The language for the node labels (e.g., "es" for Spanish, "en" for English).'),
  isHorizontal: z.boolean().optional().describe('Whether the mind map should be rendered horizontally. Defaults to vertical.')
});
export type CreateMindMapInput = z.infer<typeof CreateMindMapInputSchema>;

// Output for the entire flow
const CreateMindMapOutputSchema = z.object({
  imageDataUri: z.string().describe('The generated mind map image as a data URI.'),
});
export type CreateMindMapOutput = z.infer<typeof CreateMindMapOutputSchema>;


// Schema for the structured mind map data
const MindMapNodeSchema: z.ZodType<any> = z.object({
  label: z.string().describe('The text label for this node.'),
  children: z.array(z.lazy(() => MindMapNodeSchema)).optional().describe('Optional child nodes, forming sub-topics.'),
});
export type MindMapNode = z.infer<typeof MindMapNodeSchema>;

const MindMapStructureSchema = z.object({
  centralThemeLabel: z.string().describe('The label for the central theme, confirmed or refined by the AI.'),
  mainBranches: z.array(MindMapNodeSchema).describe('An array of main ideas branching from the central theme. Aim for 3-5 main branches for clarity. Each main branch can have 2-3 sub-topics.'),
});
export type MindMapStructure = z.infer<typeof MindMapStructureSchema>;

// Schema for rendering the image (combines structure with orientation preference)
const RenderImageInputSchema = MindMapStructureSchema.extend({
  isHorizontal: z.boolean().optional(),
});
export type RenderImageInput = z.infer<typeof RenderImageInputSchema>;


// =============================================================================
// FUNCIÓN PARA DETECTAR SI ES ASIGNATURA DE MATEMÁTICAS
// =============================================================================
function isMathSubject(bookTitle: string, centralTheme?: string): boolean {
  const lowerTitle = bookTitle.toLowerCase();
  const lowerTheme = (centralTheme || '').toLowerCase();
  
  // Lista de palabras clave que indican matemáticas
  const mathKeywords = [
    'matemática', 'matematica', 'matemáticas', 'matematicas', 'math',
    'álgebra', 'algebra', 'geometría', 'geometria', 
    'cálculo', 'calculo', 'aritmética', 'aritmetica',
    'trigonometría', 'trigonometria',
    // Temas matemáticos específicos
    'suma', 'sumas', 'resta', 'restas', 'adición', 'sustracción',
    'multiplicación', 'multiplicacion', 'división', 'division',
    'fracción', 'fracciones', 'fraccion',
    'ecuación', 'ecuacion', 'ecuaciones',
    'porcentaje', 'porcentajes',
    'potencia', 'potencias', 'raíz', 'raiz', 'raíces',
    'área', 'area', 'perímetro', 'perimetro',
    'pitágoras', 'pitagoras',
    'números', 'numeros', 'decimales',
    'proporción', 'proporcion', 'razón', 'razon'
  ];
  
  // Verificar si el título o el tema contienen palabras clave de matemáticas
  for (const keyword of mathKeywords) {
    if (lowerTitle.includes(keyword) || lowerTheme.includes(keyword)) {
      return true;
    }
  }
  
  return false;
}

// =============================================================================
// FUNCIÓN PARA DETECTAR ASIGNATURAS DE CIENCIAS CON CÁLCULOS
// =============================================================================
type ScienceSubjectType = 'fisica' | 'quimica' | 'biologia' | null;

function detectScienceSubject(bookTitle: string, centralTheme?: string): ScienceSubjectType {
  const lowerTitle = bookTitle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lowerTheme = (centralTheme || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const combined = lowerTitle + ' ' + lowerTheme;
  
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

// =============================================================================
// PROMPT ESPECIALIZADO PARA MATEMÁTICAS
// =============================================================================
const generateMathMindMapStructurePrompt = ai.definePrompt({
  name: 'generateMathMindMapStructurePrompt',
  input: { schema: CreateMindMapInputSchema },
  output: { schema: MindMapStructureSchema },
  prompt: `Eres un experto en didáctica de matemáticas y diseño instruccional.
Genera una estructura jerárquica para un MAPA MENTAL ESPECIALIZADO EN MATEMÁTICAS.
El tema central es: "{{centralTheme}}" de la asignatura "{{bookTitle}}".
El idioma para todos los nodos debe ser: {{language}}.

IMPORTANTE - Este es un mapa mental de MATEMÁTICAS, por lo tanto debe incluir:

1. **FÓRMULAS Y NOTACIÓN MATEMÁTICA**: Incluye fórmulas clave usando notación simple (por ejemplo: "a² + b² = c²", "A = π·r²", "x = (-b±√Δ)/2a")

2. **PROCEDIMIENTOS Y PASOS**: Para resolver problemas, incluye los pasos numerados o secuenciales

3. **EJEMPLOS CON EJERCICIOS**: Incluye ejemplos numéricos concretos que ilustren el concepto (ej: "Ej: 3² + 4² = 5²")

4. **PROPIEDADES Y TEOREMAS**: Menciona propiedades, axiomas o teoremas relevantes

5. **CASOS ESPECIALES**: Si aplica, incluye casos particulares o excepciones

Tu estructura debe tener:
- 1 nodo central con el tema principal
- 4-5 ramas principales que pueden ser: Definición, Fórmulas, Procedimiento, Ejemplos, Aplicaciones
- 2-3 subnodos por rama con contenido específico matemático

Ejemplo de estructura para "Ecuación Cuadrática":
{
  "centralThemeLabel": "ECUACIÓN CUADRÁTICA ax²+bx+c=0",
  "mainBranches": [
    { 
      "label": "📐 Fórmula General", 
      "children": [
        { "label": "x = (-b±√Δ)/2a" }, 
        { "label": "Δ = b² - 4ac" }
      ] 
    },
    { 
      "label": "🔢 Procedimiento", 
      "children": [
        { "label": "1. Identificar a,b,c" }, 
        { "label": "2. Calcular Δ" },
        { "label": "3. Aplicar fórmula" }
      ] 
    },
    { 
      "label": "✏️ Ejemplo Resuelto", 
      "children": [
        { "label": "x²-5x+6=0" }, 
        { "label": "x₁=2, x₂=3" }
      ] 
    },
    { 
      "label": "📊 Tipo de Raíces", 
      "children": [
        { "label": "Δ>0: 2 reales" }, 
        { "label": "Δ=0: 1 real doble" },
        { "label": "Δ<0: complejas" }
      ] 
    }
  ]
}

NOTA: Usa emojis apropiados para las ramas principales (📐🔢✏️📊📏🧮) pero NO en los subnodos.
Mantén las fórmulas y notación matemática claras y legibles.
El contenido debe ser PRÁCTICO y orientado a EJERCICIOS, no solo teórico.
`,
});

// Prompt to generate the mind map's textual structure (for non-math subjects)
const generateMindMapStructurePrompt = ai.definePrompt({
  name: 'generateMindMapStructurePrompt',
  // Input uses CreateMindMapInputSchema to get language, theme, book
  input: { schema: CreateMindMapInputSchema }, 
  output: { schema: MindMapStructureSchema }, 
  prompt: `You are an expert in instructional design and content organization.
Based on the book titled "{{bookTitle}}", generate a hierarchical structure for a conceptual map.
The central theme is: "{{centralTheme}}".
The language for all node labels must be: {{language}}.

Your task is to:
1.  Confirm or slightly refine the central theme label if necessary for clarity, ensuring it's concise.
2.  Identify 3 to 5 main concepts or topics directly related to this central theme, as found in the book. These will be the main branches.
3.  For each main branch, identify 2 to 3 key sub-topics or supporting details from the book. These sub-topics form a connected hierarchy under their parent main branch.
4.  Ensure all labels (central theme, main branches, sub-topics) are concise, clear, and in the specified language ({{language}}).
5.  Structure the output according to the MindMapStructureSchema. All generated nodes must be part of this connected hierarchy.

Example of desired output structure (conceptual):
{
  "centralThemeLabel": "Photosynthesis (FOTOSÍNTESIS)",
  "mainBranches": [
    { "label": "Inputs (Entradas)", "children": [{ "label": "Light (Luz)" }, { "label": "Water (Agua)" }, { "label": "CO2" }] },
    { "label": "Process (Proceso)", "children": [{ "label": "Light Reactions (Reacciones Luminosas)" }, { "label": "Calvin Cycle (Ciclo de Calvin)" }] },
    { "label": "Outputs (Salidas)", "children": [{ "label": "Glucose (Glucosa)" }, { "label": "Oxygen (Oxígeno)" }] }
  ]
}
Focus on accuracy and relevance to the book content. Ensure a clear hierarchical structure suitable for a conceptual map where all nodes are interconnected.
`,
});

// This internal prompt definition is used to render the structured data into a string for the image model.
const renderMindMapImageHandlebarsPrompt = ai.definePrompt({
  name: 'renderMindMapImageHandlebarsPrompt',
  input: { schema: RenderImageInputSchema }, // Uses the combined schema
  prompt: `You are an expert at creating clear, visually appealing, and informative conceptual map IMAGES in a diagrammatic style.
Generate a conceptual map IMAGE based on the EXACT structure, text, and styling cues provided below.
Do NOT generate text output, only the IMAGE. The image should be a clean, diagrammatic conceptual map. Avoid artistic or overly stylized renderings. The background should be simple and not interfere with text legibility.

The absolute MOST IMPORTANT requirement is that ALL TEXT in EVERY NODE must be perfectly clear, easily readable, and large enough to be distinguished. Use a simple, legible sans-serif font. Ensure good contrast between the text and its node background. Each text label you are given MUST be rendered as a distinct, clearly readable text element within its own node in the image.

The textual content for each node is GIVEN to you below. You MUST use this exact text.

Central Theme (Main Node): "{{centralThemeLabel}}"

Main Ideas branching from the Central Theme:
{{#each mainBranches}}
- Main Idea Node: "{{label}}"
  {{#if children.length}}
  Sub-topics/concepts branching from "{{label}}":
    {{#each children}}
    - Sub-topic Node: "{{this.label}}"
      {{#if this.children.length}}
      Further sub-topics for "{{this.label}}":
        {{#each this.children}}
        - Sub-sub-topic Node: "{{this.label}}"
        {{/each}}
      {{/if}}
    {{/each}}
  {{/if}}
{{/each}}

Strict Requirements for the IMAGE:
1.  **RENDER PROVIDED TEXT EXACTLY AND CLEARLY**: This is the most critical instruction. The textual content for every node is GIVEN to you in the structure above (e.g., "{{centralThemeLabel}}", "{{label}}", "{{this.label}}"). You MUST render this text precisely as it is written, inside its respective node. The text must be:
    *   PERFECTLY LEGIBLE.
    *   LARGE ENOUGH to be easily read without zooming.
    *   Use a SIMPLE, SANS-SERIF FONT.
    *   Have EXCELLENT CONTRAST against the node's background.
    *   DO NOT ABBREVIATE, CHANGE, OMIT, OR ADD ANY TEXT to the labels provided.
    *   If you cannot render text clearly and accurately for every single node given, the image is a failure.

{{#if isHorizontal}}
2.  **CLEAR HIERARCHY AND NODE STYLES (HORIZONTAL Layout)**:
    *   **Layout**: The map MUST follow a **left-to-right horizontal structure**. The central theme ("{{centralThemeLabel}}") must be the most prominent node, positioned on the **far left**. Main ideas (labels from \`mainBranches\`) must clearly branch horizontally to the right from it. Sub-topics (labels from \`children\` of main ideas) must clearly branch horizontally to the right from their respective parent main idea nodes, reflecting the provided hierarchy. Use clear visual connectors (lines or simple arrows). DO NOT write text on the connector lines themselves; they should be purely visual.
    *   **Node Shapes**: For horizontal maps, **ALL nodes (Central Theme, Main Ideas, Sub-topics, and any further levels) MUST be RECTANGLES**.
{{else}}
2.  **CLEAR HIERARCHY AND NODE STYLES (Vertical/Default Layout)**:
    *   **Layout**: The map MUST follow a **top-down hierarchical structure**. The central theme ("{{centralThemeLabel}}") must be the most prominent node, positioned at the **top**. Main ideas (labels from \`mainBranches\`) must clearly branch downwards or outwards from it. Sub-topics (labels from \`children\` of main ideas) must clearly branch from their respective parent main idea nodes, reflecting the provided hierarchy. Use clear visual connectors (lines or simple arrows). DO NOT write text on the connector lines themselves; they should be purely visual.
    *   **Node Shapes**:
        *   The Central Theme node containing "{{centralThemeLabel}}" must be a **rectangle**.
        *   Nodes representing Main Ideas (the direct children of the central theme, i.e., items in \`mainBranches\`) must be **rectangles**.
        *   Nodes representing Sub-topics (children of Main Ideas) must be **circles**.
        *   If there are further levels of sub-topics (children of children), they should also be **circles**.
{{/if}}

3.  **PROFESSIONAL APPEARANCE**: The map should be visually organized, uncluttered, and professional. Use distinct shapes as specified. A simple, consistent color scheme (e.g., light-colored nodes like pale yellow or light blue with dark text, or a scheme that ensures high contrast and readability) is preferred. Text legibility, correct shapes, accurate content, and faithful representation of the provided hierarchy are more important than complex aesthetics.
4.  **ABSOLUTE STRUCTURAL FIDELITY AND NO HALLUCINATIONS**:
    *   You are GIVEN a precise textual structure. Your ONLY task is to visually represent THIS EXACT STRUCTURE.
    *   **DO NOT ADD ANY NODES, TEXT, or SHAPES** that are not explicitly defined by the input structure.
    *   **EVERY NODE MUST BE CONNECTED**: Every Main Idea node MUST be visually connected to the Central Theme. Every Sub-topic node MUST be visually connected to its parent Main Idea. If there are sub-sub-topics, they MUST be connected to their parent sub-topic.
    *   **NO DISCONNECTED OR FLOATING NODES ARE ALLOWED**, except for the Central Theme node *before* its first branches.
    *   All visual connections (lines/arrows) in the image MUST accurately reflect the parent-child relationships defined in the provided textual hierarchy.
    *   The final image must be a direct, faithful, and complete visual translation of the provided data structure.

If any text is distorted, unreadable, or omitted, or if any text is added that was not in the provided structure, or if the node shapes are incorrect (based on the {{#if isHorizontal}}horizontal{{else}}vertical{{/if}} layout requirement), or if the connections do not accurately represent the provided hierarchy (e.g., a node is disconnected), the image is considered a failure. Prioritize text clarity, faithfulness to the provided content and structure, and correct node styling above all other considerations.
`,
});

import { getOpenRouterClient, hasOpenRouterApiKey, OPENROUTER_MODELS } from '@/lib/openrouter-client';

// Función para generar estructura del mapa mental usando OpenRouter
async function generateStructureWithOpenRouter(input: CreateMindMapInput): Promise<MindMapStructure | null> {
  const client = getOpenRouterClient();
  if (!client) {
    console.log('[MindMap] OpenRouter client not available');
    return null;
  }

  const isSpanish = input.language === 'es';
  
  // Detectar tipo de asignatura de ciencias
  const scienceType = detectScienceSubject(input.bookTitle, input.centralTheme);
  console.log('[MindMap] Science subject type detected:', scienceType || 'general');
  
  // Obtener contexto de generación basado en el curso
  const courseContext = input.courseName ? getContentGenerationContext(input.courseName) : null;
  const adaptationInstructions = courseContext ? generateAIPromptInstructions(courseContext, input.language) : '';
  
  // Instrucciones especiales para ciencias con cálculos
  const getScienceInstructions = (): string => {
    if (!scienceType) return '';
    
    const scienceInstr: Record<ScienceSubjectType, { es: string; en: string }> = {
      fisica: {
        es: `\nINSTRUCCIONES ESPECIALES PARA FÍSICA:
- Incluye FÓRMULAS relevantes como subnodos (v=d/t, F=ma, E=mc²)
- Agrega ramas para "Fórmulas Clave" y "Unidades de Medida"
- Incluye ejemplos con valores numéricos`,
        en: `\nSPECIAL INSTRUCTIONS FOR PHYSICS:
- Include relevant FORMULAS as subnodes (v=d/t, F=ma, E=mc²)
- Add branches for "Key Formulas" and "Units of Measurement"
- Include examples with numerical values`
      },
      quimica: {
        es: `\nINSTRUCCIONES ESPECIALES PARA QUÍMICA:
- Incluye FÓRMULAS químicas y ecuaciones como subnodos
- Agrega ramas para "Fórmulas y Ecuaciones" y "Cálculos"
- Incluye ejemplos de estequiometría cuando corresponda`,
        en: `\nSPECIAL INSTRUCTIONS FOR CHEMISTRY:
- Include CHEMICAL FORMULAS and equations as subnodes
- Add branches for "Formulas and Equations" and "Calculations"
- Include stoichiometry examples when applicable`
      },
      biologia: {
        es: `\nINSTRUCCIONES ESPECIALES PARA BIOLOGÍA:
- Para genética, incluye una rama para "Cruces y Proporciones"
- Incluye subnodos con proporciones (3:1, 9:3:3:1)
- Para otros temas, enfócate en procesos y ciclos`,
        en: `\nSPECIAL INSTRUCTIONS FOR BIOLOGY:
- For genetics, include a branch for "Crosses and Ratios"
- Include subnodes with ratios (3:1, 9:3:3:1)
- For other topics, focus on processes and cycles`
      }
    };
    
    return scienceInstr[scienceType]?.[isSpanish ? 'es' : 'en'] || '';
  };
  
  const scienceInstructions = getScienceInstructions();
  
  // Construir orientación del tema si existe
  const themeGuidance = input.themeDescription 
    ? (isSpanish 
        ? `\nOrientación del tema: ${input.themeDescription}`
        : `\nTopic guidance: ${input.themeDescription}`)
    : '';
  
  const systemPrompt = isSpanish 
    ? `Eres un experto en diseño instruccional. Genera estructuras jerárquicas para mapas mentales educativos ADAPTADOS AL NIVEL DEL ESTUDIANTE.
IMPORTANTE: Responde SOLO con JSON válido, sin texto adicional ni markdown.${scienceInstructions}
${adaptationInstructions}`
    : `You are an expert in instructional design. Generate hierarchical structures for educational mind maps ADAPTED TO THE STUDENT'S LEVEL.
IMPORTANT: Respond ONLY with valid JSON, no additional text or markdown.${scienceInstructions}
${adaptationInstructions}`;

  const userPrompt = isSpanish
    ? `Genera la estructura de un mapa mental sobre "${input.centralTheme}" para la asignatura "${input.bookTitle}"${input.courseName ? ` (${input.courseName})` : ''}.${themeGuidance}

${courseContext ? `⚠️ IMPORTANTE: El estudiante tiene aproximadamente ${courseContext.approximateAge} años. Adapta el vocabulario y complejidad al nivel del estudiante.` : ''}

Responde ÚNICAMENTE con este formato JSON exacto (sin markdown, sin \`\`\`):
{
  "centralThemeLabel": "TÍTULO DEL TEMA EN MAYÚSCULAS",
  "mainBranches": [
    {
      "label": "🔹 Rama Principal 1",
      "children": [
        {"label": "Subtema 1.1"},
        {"label": "Subtema 1.2"},
        {"label": "Subtema 1.3"}
      ]
    },
    {
      "label": "🔹 Rama Principal 2",
      "children": [
        {"label": "Subtema 2.1"},
        {"label": "Subtema 2.2"}
      ]
    },
    {
      "label": "🔹 Rama Principal 3",
      "children": [
        {"label": "Subtema 3.1"},
        {"label": "Subtema 3.2"}
      ]
    },
    {
      "label": "🔹 Rama Principal 4",
      "children": [
        {"label": "Subtema 4.1"},
        {"label": "Subtema 4.2"}
      ]
    }
  ]
}

REGLAS:
- Genera exactamente 4 ramas principales con 2-3 subtemas cada una
- Usa emojis apropiados (🔬🌿🔢📚💡🌍⚡🎯) en las ramas principales
- El contenido debe ser ESPECÍFICO y EDUCATIVO sobre "${input.centralTheme}"
- ADAPTA el vocabulario y complejidad al nivel del estudiante
- NO uses contenido genérico como "Elemento 1" o "Componente"
- Responde SOLO el JSON, nada más`
    : `Generate the structure of a mind map about "${input.centralTheme}" for the subject "${input.bookTitle}"${input.courseName ? ` (${input.courseName})` : ''}.${themeGuidance}

${courseContext ? `⚠️ IMPORTANT: The student is approximately ${courseContext.approximateAge} years old. Adapt vocabulary and complexity to the student's level.` : ''}

Respond ONLY with this exact JSON format (no markdown, no \`\`\`):
{
  "centralThemeLabel": "TOPIC TITLE IN UPPERCASE",
  "mainBranches": [
    {
      "label": "🔹 Main Branch 1",
      "children": [
        {"label": "Subtopic 1.1"},
        {"label": "Subtopic 1.2"},
        {"label": "Subtopic 1.3"}
      ]
    },
    {
      "label": "🔹 Main Branch 2",
      "children": [
        {"label": "Subtopic 2.1"},
        {"label": "Subtopic 2.2"}
      ]
    },
    {
      "label": "🔹 Main Branch 3",
      "children": [
        {"label": "Subtopic 3.1"},
        {"label": "Subtopic 3.2"}
      ]
    },
    {
      "label": "🔹 Main Branch 4",
      "children": [
        {"label": "Subtopic 4.1"},
        {"label": "Subtopic 4.2"}
      ]
    }
  ]
}

RULES:
- Generate exactly 4 main branches with 2-3 subtopics each
- Use appropriate emojis (🔬🌿🔢📚💡🌍⚡🎯) in main branches
- Content must be SPECIFIC and EDUCATIONAL about "${input.centralTheme}"
- ADAPT vocabulary and complexity to the student's level
- DO NOT use generic content like "Element 1" or "Component"
- Respond ONLY with JSON, nothing else`;

  try {
    console.log('[MindMap] Calling OpenRouter for structure generation...');
    const response = await client.generateText(systemPrompt, userPrompt, {
      model: OPENROUTER_MODELS.GPT_4O_MINI,
      temperature: 0.7,
      maxTokens: 2048,
    });
    
    console.log('[MindMap] OpenRouter response received');
    
    // Limpiar la respuesta de posibles marcadores markdown
    let cleanResponse = response.trim();
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.slice(7);
    }
    if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.slice(3);
    }
    if (cleanResponse.endsWith('```')) {
      cleanResponse = cleanResponse.slice(0, -3);
    }
    cleanResponse = cleanResponse.trim();
    
    const parsed = JSON.parse(cleanResponse) as MindMapStructure;
    
    if (parsed.centralThemeLabel && parsed.mainBranches && parsed.mainBranches.length > 0) {
      console.log('[MindMap] Structure parsed successfully from OpenRouter');
      return parsed;
    }
    
    return null;
  } catch (error) {
    console.error('[MindMap] OpenRouter error:', error);
    return null;
  }
}

export async function createMindMap(input: CreateMindMapInput): Promise<CreateMindMapOutput> {
  // Detectar si es asignatura de matemáticas (verifica tanto bookTitle como centralTheme)
  const isMatematicas = isMathSubject(input.bookTitle, input.centralTheme);
  
  console.log('🧠 createMindMap - HÍBRIDO: IA para contenido + SVG para imagen');
  console.log('📋 Input recibido:', {
    centralTheme: input.centralTheme,
    bookTitle: input.bookTitle,
    language: input.language,
    isHorizontal: input.isHorizontal,
    isMathSubject: isMatematicas
  });
  
  // Para MATEMÁTICAS: Usar estructura predefinida con ejercicios reales
  // Esto garantiza contenido específico y útil para el estudio
  if (isMatematicas) {
    console.log('📐 Detectada asignatura de MATEMÁTICAS - Usando estructura especializada con ejercicios');
    
    // Usar estructura predefinida de matemáticas (con ejercicios reales)
    const mathStructure = generateMathMockStructure(input);
    console.log('📊 Estructura matemática generada:', mathStructure);
    
    // Generar SVG especializado para matemáticas
    const mathSvg = generateMathSvg(mathStructure, input.isHorizontal);
    console.log('🎨 SVG matemático generado - Longitud:', mathSvg.length);
    
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(mathSvg).toString('base64')}`;
    console.log('✅ Mapa mental de matemáticas generado exitosamente');
    return { imageDataUri: dataUri };
  }
  
  // Primero intentar con OpenRouter (más confiable)
  if (hasOpenRouterApiKey()) {
    console.log('🚀 Intentando generar estructura con OpenRouter...');
    const openRouterStructure = await generateStructureWithOpenRouter(input);
    
    if (openRouterStructure) {
      console.log('✅ Estructura generada exitosamente con OpenRouter');
      const enhancedSvg = generateEnhancedSvg(openRouterStructure, input.isHorizontal);
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(enhancedSvg).toString('base64')}`;
      return { imageDataUri: dataUri };
    }
    console.log('⚠️ OpenRouter falló, intentando con Google Gemini...');
  }
  
  // Para otras asignaturas: Usar IA de Google para generar contenido
  try {
    console.log('🤖 Generando contenido con Google Gemini para asignatura no-matemática...');
    const structureResponse = await generateMindMapStructurePrompt(input);
    const aiGeneratedStructure = structureResponse.output;

    if (!aiGeneratedStructure) {
      throw new Error('Failed to generate mind map structure with AI.');
    }

    console.log('📊 Estructura generada por IA:', aiGeneratedStructure);
    
    console.log('🎨 Generando SVG mejorado...');
    const enhancedSvg = generateEnhancedSvg(aiGeneratedStructure, input.isHorizontal);
    console.log('🎨 SVG mejorado generado exitosamente - Longitud:', enhancedSvg.length);
    
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(enhancedSvg).toString('base64')}`;
    
    console.log('✅ Mapa mental híbrido generado exitosamente');
    return { imageDataUri: dataUri };
    
  } catch (error) {
    console.error('❌ Error en generación híbrida, usando fallback:', error);
    
    // Fallback con estructura genérica
    const fallbackStructure = generateMockMindMapStructure(input);
    const fallbackSvg = generateEnhancedSvg(fallbackStructure, input.isHorizontal);
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`;
    
    return { imageDataUri: dataUri };
  }
}

const createMindMapFlow = ai.defineFlow(
  {
    name: 'createMindMapFlow',
    inputSchema: CreateMindMapInputSchema,
    outputSchema: CreateMindMapOutputSchema,
  },
  async (input: CreateMindMapInput): Promise<CreateMindMapOutput> => {
    // Step 1: Generate the structured mind map data
    // Pass the full input, as generateMindMapStructurePrompt expects centralTheme, bookTitle, and language
    const structureResponse = await generateMindMapStructurePrompt(input); 
    const mindMapStructure = structureResponse.output;

    if (!mindMapStructure) {
      throw new Error('Failed to generate mind map structure.');
    }

    // Step 2: Render the structured data as an image
    // Prepare the input for the image rendering prompt
    const renderImageInput: RenderImageInput = {
      ...mindMapStructure,
      isHorizontal: input.isHorizontal, // Pass the isHorizontal flag
    };

    const renderOutput = await renderMindMapImageHandlebarsPrompt.render(renderImageInput);
    const actualPromptText = renderOutput.messages?.[0]?.content?.[0]?.text;

    if (!actualPromptText) {
      throw new Error('Failed to render the image generation prompt text from RenderResponse.');
    }
    
    const {media} = await ai.generate({
      model: 'googleai/gemini-2.0-flash-exp', 
      prompt: actualPromptText, 
      config: {
        responseModalities: ['TEXT', 'IMAGE'], 
      },
    });

    if (!media?.url) {
      throw new Error('Image generation failed or no image was returned by the model.');
    }
    return { imageDataUri: media.url };
  }
);

// Helper functions for mock mode
function generateMockMindMapStructure(input: CreateMindMapInput): MindMapStructure {
  const centralTheme = input.centralTheme.toLowerCase();
  const language = input.language;
  
  // Define topic-specific branches based on common educational themes
  const topicMappings: Record<string, {centralLabel: string, branches: Array<{label: string, children: string[]}>}> = {
    'sistema respiratorio': {
      centralLabel: language === 'es' ? 'Sistema Respiratorio' : 'Respiratory System',
      branches: [
        {
          label: language === 'es' ? 'Órganos Principales' : 'Main Organs',
          children: language === 'es' ? ['Pulmones', 'Tráquea', 'Bronquios'] : ['Lungs', 'Trachea', 'Bronchi']
        },
        {
          label: language === 'es' ? 'Proceso de Respiración' : 'Breathing Process',
          children: language === 'es' ? ['Inspiración', 'Espiración', 'Intercambio de Gases'] : ['Inspiration', 'Expiration', 'Gas Exchange']
        },
        {
          label: language === 'es' ? 'Funciones' : 'Functions',
          children: language === 'es' ? ['Oxigenación', 'Eliminación CO2', 'Regulación pH'] : ['Oxygenation', 'CO2 Removal', 'pH Regulation']
        },
        {
          label: language === 'es' ? 'Enfermedades Comunes' : 'Common Diseases',
          children: language === 'es' ? ['Asma', 'Neumonía', 'Bronquitis'] : ['Asthma', 'Pneumonia', 'Bronchitis']
        }
      ]
    },
    'aparato respiratorio': {
      centralLabel: language === 'es' ? 'Aparato Respiratorio' : 'Respiratory System',
      branches: [
        {
          label: language === 'es' ? 'Órganos Principales' : 'Main Organs',
          children: language === 'es' ? ['Pulmones', 'Tráquea', 'Bronquios'] : ['Lungs', 'Trachea', 'Bronchi']
        },
        {
          label: language === 'es' ? 'Proceso de Respiración' : 'Breathing Process',
          children: language === 'es' ? ['Inspiración', 'Espiración', 'Intercambio de Gases'] : ['Inspiration', 'Expiration', 'Gas Exchange']
        },
        {
          label: language === 'es' ? 'Funciones' : 'Functions',
          children: language === 'es' ? ['Oxigenación', 'Eliminación CO2', 'Regulación pH'] : ['Oxygenation', 'CO2 Removal', 'pH Regulation']
        },
        {
          label: language === 'es' ? 'Enfermedades Comunes' : 'Common Diseases',
          children: language === 'es' ? ['Asma', 'Neumonía', 'Bronquitis'] : ['Asthma', 'Pneumonia', 'Bronchitis']
        }
      ]
    },
    'respiración': {
      centralLabel: language === 'es' ? 'Respiración' : 'Respiration',
      branches: [
        {
          label: language === 'es' ? 'Tipos de Respiración' : 'Types of Respiration',
          children: language === 'es' ? ['Respiración Pulmonar', 'Respiración Celular', 'Respiración Externa'] : ['Pulmonary Respiration', 'Cellular Respiration', 'External Respiration']
        },
        {
          label: language === 'es' ? 'Mecánica Respiratoria' : 'Respiratory Mechanics',
          children: language === 'es' ? ['Inspiración', 'Espiración', 'Ventilación'] : ['Inspiration', 'Expiration', 'Ventilation']
        },
        {
          label: language === 'es' ? 'Transporte de Gases' : 'Gas Transport',
          children: language === 'es' ? ['Hemoglobina', 'Difusión', 'Perfusión'] : ['Hemoglobin', 'Diffusion', 'Perfusion']
        }
      ]
    },
    'fotosíntesis': {
      centralLabel: language === 'es' ? 'Fotosíntesis' : 'Photosynthesis',
      branches: [
        {
          label: language === 'es' ? 'Reactivos' : 'Reactants',
          children: language === 'es' ? ['Dióxido de Carbono', 'Agua', 'Luz Solar'] : ['Carbon Dioxide', 'Water', 'Sunlight']
        },
        {
          label: language === 'es' ? 'Productos' : 'Products',
          children: language === 'es' ? ['Glucosa', 'Oxígeno'] : ['Glucose', 'Oxygen']
        },
        {
          label: language === 'es' ? 'Fases' : 'Phases',
          children: language === 'es' ? ['Fase Luminosa', 'Fase Oscura', 'Ciclo de Calvin'] : ['Light Phase', 'Dark Phase', 'Calvin Cycle']
        },
        {
          label: language === 'es' ? 'Ubicación' : 'Location',
          children: language === 'es' ? ['Cloroplastos', 'Hojas', 'Células Vegetales'] : ['Chloroplasts', 'Leaves', 'Plant Cells']
        }
      ]
    },
    'célula': {
      centralLabel: language === 'es' ? 'La Célula' : 'The Cell',
      branches: [
        {
          label: language === 'es' ? 'Tipos Celulares' : 'Cell Types',
          children: language === 'es' ? ['Célula Procariota', 'Célula Eucariota'] : ['Prokaryotic Cell', 'Eukaryotic Cell']
        },
        {
          label: language === 'es' ? 'Organelos' : 'Organelles',
          children: language === 'es' ? ['Núcleo', 'Mitocondrias', 'Ribosomas'] : ['Nucleus', 'Mitochondria', 'Ribosomes']
        },
        {
          label: language === 'es' ? 'Funciones' : 'Functions',
          children: language === 'es' ? ['Reproducción', 'Metabolismo', 'Homeostasis'] : ['Reproduction', 'Metabolism', 'Homeostasis']
        }
      ]
    },
    'plantas': {
      centralLabel: language === 'es' ? 'Las Plantas' : 'Plants',
      branches: [
        {
          label: language === 'es' ? 'Tipos de Plantas' : 'Plant Types',
          children: language === 'es' ? ['Angiospermas', 'Gimnospermas', 'Helechos'] : ['Angiosperms', 'Gymnosperms', 'Ferns']
        },
        {
          label: language === 'es' ? 'Partes de la Planta' : 'Plant Parts',
          children: language === 'es' ? ['Raíz', 'Tallo', 'Hojas'] : ['Root', 'Stem', 'Leaves']
        },
        {
          label: language === 'es' ? 'Funciones' : 'Functions',
          children: language === 'es' ? ['Fotosíntesis', 'Respiración', 'Reproducción'] : ['Photosynthesis', 'Respiration', 'Reproduction']
        }
      ]
    },
    'agua': {
      centralLabel: language === 'es' ? 'El Agua' : 'Water',
      branches: [
        {
          label: language === 'es' ? 'Estados del Agua' : 'Water States',
          children: language === 'es' ? ['Líquido', 'Sólido', 'Gaseoso'] : ['Liquid', 'Solid', 'Gas']
        },
        {
          label: language === 'es' ? 'Ciclo del Agua' : 'Water Cycle',
          children: language === 'es' ? ['Evaporación', 'Condensación', 'Precipitación'] : ['Evaporation', 'Condensation', 'Precipitation']
        },
        {
          label: language === 'es' ? 'Importancia' : 'Importance',
          children: language === 'es' ? ['Vida', 'Ecosistemas', 'Agricultura'] : ['Life', 'Ecosystems', 'Agriculture']
        }
      ]
    },
    'ecosistema': {
      centralLabel: language === 'es' ? 'Ecosistema' : 'Ecosystem',
      branches: [
        {
          label: language === 'es' ? 'Componentes Vivos' : 'Living Components',
          children: language === 'es' ? ['Productores', 'Consumidores', 'Descomponedores'] : ['Producers', 'Consumers', 'Decomposers']
        },
        {
          label: language === 'es' ? 'Componentes No Vivos' : 'Non-Living Components',
          children: language === 'es' ? ['Agua', 'Suelo', 'Clima'] : ['Water', 'Soil', 'Climate']
        },
        {
          label: language === 'es' ? 'Interacciones' : 'Interactions',
          children: language === 'es' ? ['Cadenas Alimentarias', 'Simbiosis', 'Competencia'] : ['Food Chains', 'Symbiosis', 'Competition']
        }
      ]
    },
    'alimentación saludable': {
      centralLabel: language === 'es' ? 'Alimentación Saludable' : 'Healthy Eating',
      branches: [
        {
          label: language === 'es' ? '🥗 Grupos Alimenticios' : '🥗 Food Groups',
          children: language === 'es' ? ['Frutas y Verduras', 'Proteínas', 'Carbohidratos', 'Lácteos'] : ['Fruits & Vegetables', 'Proteins', 'Carbohydrates', 'Dairy']
        },
        {
          label: language === 'es' ? '💪 Beneficios' : '💪 Benefits',
          children: language === 'es' ? ['Energía', 'Crecimiento', 'Sistema Inmune'] : ['Energy', 'Growth', 'Immune System']
        },
        {
          label: language === 'es' ? '🍽️ Hábitos Saludables' : '🍽️ Healthy Habits',
          children: language === 'es' ? ['Desayuno completo', 'Horarios regulares', 'Beber agua'] : ['Complete breakfast', 'Regular schedule', 'Drink water']
        },
        {
          label: language === 'es' ? '⚠️ Evitar' : '⚠️ Avoid',
          children: language === 'es' ? ['Comida chatarra', 'Exceso de azúcar', 'Grasas saturadas'] : ['Junk food', 'Excess sugar', 'Saturated fats']
        }
      ]
    },
    'alimentacion saludable': {
      centralLabel: language === 'es' ? 'Alimentación Saludable' : 'Healthy Eating',
      branches: [
        {
          label: language === 'es' ? '🥗 Grupos Alimenticios' : '🥗 Food Groups',
          children: language === 'es' ? ['Frutas y Verduras', 'Proteínas', 'Carbohidratos', 'Lácteos'] : ['Fruits & Vegetables', 'Proteins', 'Carbohydrates', 'Dairy']
        },
        {
          label: language === 'es' ? '💪 Beneficios' : '💪 Benefits',
          children: language === 'es' ? ['Energía', 'Crecimiento', 'Sistema Inmune'] : ['Energy', 'Growth', 'Immune System']
        },
        {
          label: language === 'es' ? '🍽️ Hábitos Saludables' : '🍽️ Healthy Habits',
          children: language === 'es' ? ['Desayuno completo', 'Horarios regulares', 'Beber agua'] : ['Complete breakfast', 'Regular schedule', 'Drink water']
        },
        {
          label: language === 'es' ? '⚠️ Evitar' : '⚠️ Avoid',
          children: language === 'es' ? ['Comida chatarra', 'Exceso de azúcar', 'Grasas saturadas'] : ['Junk food', 'Excess sugar', 'Saturated fats']
        }
      ]
    },
    'sistema solar': {
      centralLabel: language === 'es' ? 'Sistema Solar' : 'Solar System',
      branches: [
        {
          label: language === 'es' ? '☀️ El Sol' : '☀️ The Sun',
          children: language === 'es' ? ['Estrella central', 'Fuente de energía', 'Luz y calor'] : ['Central star', 'Energy source', 'Light and heat']
        },
        {
          label: language === 'es' ? '🪐 Planetas' : '🪐 Planets',
          children: language === 'es' ? ['Rocosos (4)', 'Gaseosos (4)', 'Tierra'] : ['Rocky (4)', 'Gas giants (4)', 'Earth']
        },
        {
          label: language === 'es' ? '🌙 Otros Cuerpos' : '🌙 Other Bodies',
          children: language === 'es' ? ['Lunas', 'Asteroides', 'Cometas'] : ['Moons', 'Asteroids', 'Comets']
        },
        {
          label: language === 'es' ? '🚀 Exploración' : '🚀 Exploration',
          children: language === 'es' ? ['Sondas espaciales', 'Telescopios', 'Misiones'] : ['Space probes', 'Telescopes', 'Missions']
        }
      ]
    },
    'cuerpo humano': {
      centralLabel: language === 'es' ? 'Cuerpo Humano' : 'Human Body',
      branches: [
        {
          label: language === 'es' ? '🫀 Sistemas' : '🫀 Systems',
          children: language === 'es' ? ['Circulatorio', 'Respiratorio', 'Digestivo', 'Nervioso'] : ['Circulatory', 'Respiratory', 'Digestive', 'Nervous']
        },
        {
          label: language === 'es' ? '🦴 Estructura' : '🦴 Structure',
          children: language === 'es' ? ['Huesos', 'Músculos', 'Órganos'] : ['Bones', 'Muscles', 'Organs']
        },
        {
          label: language === 'es' ? '🧠 Funciones' : '🧠 Functions',
          children: language === 'es' ? ['Movimiento', 'Nutrición', 'Respiración'] : ['Movement', 'Nutrition', 'Breathing']
        },
        {
          label: language === 'es' ? '❤️ Cuidado' : '❤️ Care',
          children: language === 'es' ? ['Ejercicio', 'Alimentación', 'Descanso'] : ['Exercise', 'Nutrition', 'Rest']
        }
      ]
    },
    'animales': {
      centralLabel: language === 'es' ? 'Los Animales' : 'Animals',
      branches: [
        {
          label: language === 'es' ? '🐕 Vertebrados' : '🐕 Vertebrates',
          children: language === 'es' ? ['Mamíferos', 'Aves', 'Reptiles', 'Peces'] : ['Mammals', 'Birds', 'Reptiles', 'Fish']
        },
        {
          label: language === 'es' ? '🐛 Invertebrados' : '🐛 Invertebrates',
          children: language === 'es' ? ['Insectos', 'Arácnidos', 'Moluscos'] : ['Insects', 'Arachnids', 'Mollusks']
        },
        {
          label: language === 'es' ? '🏠 Hábitats' : '🏠 Habitats',
          children: language === 'es' ? ['Terrestres', 'Acuáticos', 'Aéreos'] : ['Terrestrial', 'Aquatic', 'Aerial']
        },
        {
          label: language === 'es' ? '🍖 Alimentación' : '🍖 Feeding',
          children: language === 'es' ? ['Herbívoros', 'Carnívoros', 'Omnívoros'] : ['Herbivores', 'Carnivores', 'Omnivores']
        }
      ]
    },
    'medio ambiente': {
      centralLabel: language === 'es' ? 'Medio Ambiente' : 'Environment',
      branches: [
        {
          label: language === 'es' ? '🌍 Ecosistemas' : '🌍 Ecosystems',
          children: language === 'es' ? ['Bosques', 'Océanos', 'Desiertos'] : ['Forests', 'Oceans', 'Deserts']
        },
        {
          label: language === 'es' ? '♻️ Reciclaje' : '♻️ Recycling',
          children: language === 'es' ? ['Papel', 'Plástico', 'Vidrio'] : ['Paper', 'Plastic', 'Glass']
        },
        {
          label: language === 'es' ? '⚠️ Problemas' : '⚠️ Problems',
          children: language === 'es' ? ['Contaminación', 'Deforestación', 'Cambio climático'] : ['Pollution', 'Deforestation', 'Climate change']
        },
        {
          label: language === 'es' ? '💚 Soluciones' : '💚 Solutions',
          children: language === 'es' ? ['Reducir', 'Reutilizar', 'Reciclar'] : ['Reduce', 'Reuse', 'Recycle']
        }
      ]
    }
  };
  
  // Find matching topic or create generic structure
  let structure = topicMappings[centralTheme];
  
  if (!structure) {
    // Check for partial matches
    for (const [key, value] of Object.entries(topicMappings)) {
      if (centralTheme.includes(key) || key.includes(centralTheme)) {
        structure = value;
        break;
      }
    }
  }
  
  if (!structure) {
    // Generic fallback structure
    structure = {
      centralLabel: input.centralTheme,
      branches: [
        {
          label: language === 'es' ? 'Concepto Principal' : 'Main Concept',
          children: language === 'es' ? ['Definición', 'Características'] : ['Definition', 'Characteristics']
        },
        {
          label: language === 'es' ? 'Componentes' : 'Components',
          children: language === 'es' ? ['Elemento 1', 'Elemento 2'] : ['Element 1', 'Element 2']
        },
        {
          label: language === 'es' ? 'Aplicaciones' : 'Applications',
          children: language === 'es' ? ['Uso Práctico', 'Importancia'] : ['Practical Use', 'Importance']
        }
      ]
    };
  }
  
  return {
    centralThemeLabel: structure.centralLabel.toUpperCase(),
    mainBranches: structure.branches.map(branch => ({
      label: branch.label,
      children: branch.children.map(child => ({ label: child }))
    }))
  };
}

function generateMockSvg(structure: MindMapStructure, isHorizontal?: boolean): string {
  // GENERACIÓN SVG ULTRA-LIMPIA - MÁXIMA CLARIDAD Y LEGIBILIDAD - AGRANDADO
  const width = isHorizontal ? 1400 : 1000; // Agrandado de 900 a 1000
  const height = isHorizontal ? 900 : 1200;  // Agrandado de 800 a 1200
  const centerX = isHorizontal ? 200 : width / 2;
  const centerY = height / 2;
  
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 ${width} ${height}" style="background: #fafafa;">
    <defs>
      <filter id="cleanShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.15)"/>
      </filter>
      <style>
        .node-text { 
          font-family: 'Segoe UI', 'Arial', sans-serif; 
          text-anchor: middle; 
          dominant-baseline: middle; 
          font-weight: 600;
          letter-spacing: 0.5px;
        }
        .central-text { fill: #ffffff; font-size: 18px; font-weight: 700; }
        .branch-text { fill: #ffffff; font-size: 14px; font-weight: 600; }
        .sub-text { fill: #ffffff; font-size: 12px; font-weight: 500; }
        .connection-line { 
          stroke: #8b9dc3; 
          stroke-width: 3; 
          stroke-linecap: round;
          opacity: 0.7;
        }
      </style>
    </defs>`;

  if (isHorizontal) {
    // DISEÑO HORIZONTAL ULTRA-CLARO
    
    // Configuración de dimensiones
    const centralWidth = 180;
    const centralHeight = 80;
    const centralX = centerX;
    const centralY = centerY;
    const branches = structure.mainBranches;
    const availableHeight = height - 180;
    const branchSpacing = availableHeight / (branches.length + 1);
    
    // PASO 1: DIBUJAR TODAS LAS LÍNEAS PRIMERO (AL FONDO)
    branches.forEach((branch, branchIdx) => {
      const branchY = 90 + (branchIdx + 1) * branchSpacing;
      const branchX = centralX + 300;
      const branchWidth = 150;
      
      // Línea de conexión central a rama
      svg += `<line x1="${centralX + centralWidth/2}" y1="${centralY}" 
        x2="${branchX - branchWidth/2}" y2="${branchY}" class="connection-line"/>`;
      
      // Líneas de conexión de rama a subnodos
      if (branch.children && branch.children.length > 0) {
        const subStartX = branchX + 180;
        const subSpacing = Math.min(140, (width - subStartX - 100) / branch.children.length);
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subX = subStartX + (childIdx * subSpacing);
          const subY = branchY;
          const subRadius = 55; // Agrandado de 38 a 55 para consistencia
          
          // Línea de conexión rama a subnodo
          svg += `<line x1="${branchX + branchWidth/2}" y1="${branchY}" 
            x2="${subX - subRadius - 2}" y2="${subY}" class="connection-line"/>`; // Ajustado para subnodos más grandes
        });
      }
    });
    
    // PASO 2: DIBUJAR NODO CENTRAL
    // Fondo blanco para el nodo central
    svg += `<rect x="${centralX - centralWidth/2 - 2}" y="${centralY - centralHeight/2 - 2}" 
      width="${centralWidth + 4}" height="${centralHeight + 4}" rx="15" 
      fill="#ffffff" stroke="#e1e8ed" stroke-width="2"/>`;
    
    // Nodo central principal
    svg += `<rect x="${centralX - centralWidth/2}" y="${centralY - centralHeight/2}" 
      width="${centralWidth}" height="${centralHeight}" rx="12" 
      fill="#2563eb" stroke="#1e40af" stroke-width="3" filter="url(#cleanShadow)"/>`;
    
    // Texto central - múltiples líneas si es necesario
    const centralLines = cleanTextWrap(structure.centralThemeLabel, 16);
    const lineHeight = 20;
    const startY = centralY - ((centralLines.length - 1) * lineHeight / 2);
    
    centralLines.forEach((line, idx) => {
      svg += `<text x="${centralX}" y="${startY + (idx * lineHeight)}" class="node-text central-text">${line}</text>`;
    });
    
    // PASO 3: DIBUJAR RAMAS Y SUBNODOS
    branches.forEach((branch, branchIdx) => {
      const branchY = 90 + (branchIdx + 1) * branchSpacing;
      const branchX = centralX + 300;
      const branchWidth = 150;
      const branchHeight = 60;
      
      // Fondo blanco para nodo rama
      svg += `<rect x="${branchX - branchWidth/2 - 2}" y="${branchY - branchHeight/2 - 2}" 
        width="${branchWidth + 4}" height="${branchHeight + 4}" rx="12" 
        fill="#ffffff" stroke="#e1e8ed" stroke-width="2"/>`;
      
      // Nodo rama principal
      svg += `<rect x="${branchX - branchWidth/2}" y="${branchY - branchHeight/2}" 
        width="${branchWidth}" height="${branchHeight}" rx="10" 
        fill="#059669" stroke="#047857" stroke-width="3" filter="url(#cleanShadow)"/>`;
      
      // Texto de rama - múltiples líneas
      const branchLines = cleanTextWrap(branch.label, 18);
      const branchStartY = branchY - ((branchLines.length - 1) * 16 / 2);
      
      branchLines.forEach((line, lineIdx) => {
        svg += `<text x="${branchX}" y="${branchStartY + (lineIdx * 16)}" class="node-text branch-text">${line}</text>`;
      });
      
      // Subnodos con espaciado perfecto
      if (branch.children && branch.children.length > 0) {
        const subStartX = branchX + 180;
        const subSpacing = Math.min(160, (width - subStartX - 100) / branch.children.length); // Más espaciado
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subX = subStartX + (childIdx * subSpacing);
          const subY = branchY;
          const subRadius = 55; // Agrandado de 45 a 55 para mejor formato de texto
          
          // Fondo blanco para subnodo
          svg += `<circle cx="${subX}" cy="${subY}" r="${subRadius + 2}" 
            fill="#ffffff" stroke="#e1e8ed" stroke-width="2"/>`;
          
          // Subnodo principal
          svg += `<circle cx="${subX}" cy="${subY}" r="${subRadius}" 
            fill="#dc2626" stroke="#b91c1c" stroke-width="3" filter="url(#cleanShadow)"/>`;
          
          // Texto del subnodo - perfectamente centrado en el círculo
          const subLines = cleanTextWrap(child.label, 14); // Más caracteres por línea
          const lineHeight = 14;
          const totalTextHeight = (subLines.length - 1) * lineHeight;
          const subStartY = subY - (totalTextHeight / 2);
          
          subLines.forEach((line, lineIdx) => {
            const yPosition = subStartY + (lineIdx * lineHeight);
            svg += `<text x="${subX}" y="${yPosition}" class="node-text sub-text" 
              text-anchor="middle" dominant-baseline="middle" 
              style="font-size: 14px;">${line}</text>`; // Texto perfectamente centrado
          });
        });
      }
    });
    
  } else {
    // DISEÑO VERTICAL - JERARQUÍA TOP-DOWN SIMPLE - AGRANDADO
    const centerX = width / 2;
    const centerY = height * 0.15; // Nodo central más arriba para dar más espacio
    const branches = structure.mainBranches;
    
    // 1. Líneas de conexión (más ligeras y siempre por debajo)
    branches.forEach((branch, idx) => {
      const branchY = centerY + 200; // Más espacio entre central y ramas
      const branchX = (width / (branches.length + 1)) * (idx + 1);
      
      // Línea desde la parte inferior del nodo central
      svg += `<line x1="${centerX}" y1="${centerY + 50}" 
        x2="${branchX}" y2="${branchY - 30}" 
        stroke="#94a3b8" stroke-width="3" stroke-linecap="round"/>`;
      
      if (branch.children && branch.children.length > 0) {
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subY = branchY + 140 + (childIdx * 90); // Más espacio entre subnodos
          // Línea desde la parte inferior del nodo rama
          svg += `<line x1="${branchX}" y1="${branchY + 30}" 
            x2="${branchX}" y2="${subY - 30}" 
            stroke="#94a3b8" stroke-width="3" stroke-linecap="round"/>`;
        });
      }
    });
    
    // 2. Nodo central (agrandado)
    svg += `<circle cx="${centerX}" cy="${centerY}" r="50" 
      fill="#4f46e5" stroke="none"/>`;
    
    const centralLines = wrapText(structure.centralThemeLabel, 14);
    const centralStartY = centerY - ((centralLines.length - 1) * 16 / 2);
    
    centralLines.forEach((line, idx) => {
      svg += `<text x="${centerX}" y="${centralStartY + (idx * 16)}" 
        font-family="Arial, sans-serif" font-size="18" font-weight="bold" 
        fill="white" text-anchor="middle" dominant-baseline="middle">${line}</text>`;
    });
    
    // 3. Ramas y subnodos (agrandados)
    branches.forEach((branch, idx) => {
      const branchY = centerY + 200; // Más espacio
      const branchX = (width / (branches.length + 1)) * (idx + 1);
      
      // Nodo rama (agrandado)
      svg += `<rect x="${branchX - 80}" y="${branchY - 30}" 
        width="160" height="60" rx="12" 
        fill="#059669" stroke="none"/>`;
      
      const branchLines = wrapText(branch.label, 18);
      const branchStartY = branchY - ((branchLines.length - 1) * 14 / 2);
      
      branchLines.forEach((line, lineIdx) => {
        svg += `<text x="${branchX}" y="${branchStartY + (lineIdx * 14)}" 
          font-family="Arial, sans-serif" font-size="14" font-weight="600" 
          fill="white" text-anchor="middle" dominant-baseline="middle">${line}</text>`;
      });
      
      // Subnodos (agrandados para mejor formato de texto)
      if (branch.children && branch.children.length > 0) {
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subY = branchY + 140 + (childIdx * 90); // Más espacio
          
          svg += `<circle cx="${branchX}" cy="${subY}" r="50" 
            fill="#ef4444" stroke="none"/>`; // Agrandado de 45 a 50
          
          const subLines = wrapText(child.label, 14); // Más caracteres para subnodos más grandes
          const lineHeight = 14;
          const totalTextHeight = (subLines.length - 1) * lineHeight;
          const subStartY = subY - (totalTextHeight / 2);
          
          subLines.forEach((line, lineIdx) => {
            const yPosition = subStartY + (lineIdx * lineHeight);
            svg += `<text x="${branchX}" y="${yPosition}" 
              font-family="Arial, sans-serif" font-size="14" font-weight="500" 
              fill="white" text-anchor="middle" dominant-baseline="middle">${line}</text>`; // Texto perfectamente centrado
          });
        });
      }
    });
  }
  
  svg += '</svg>';
  return svg;
}

// Función de envoltura de texto ultra-inteligente inspirada en D3.js
function intelligentTextWrap(text: string, maxChars: number): string[] {
  if (!text || text.length <= maxChars) return [text || ''];
  
  // Algoritmo de wrapping optimizado - MEJORADO para evitar cortes feos
  const words = text.split(' ');
  
  // Si es una sola palabra, no cortarla si cabe razonablemente
  if (words.length === 1) {
    if (text.length <= maxChars * 1.3) {
      return [text]; // Mostrar completa si no es demasiado larga
    }
    // Solo cortar si es muy larga
    const midPoint = Math.ceil(text.length / 2);
    return [text.substring(0, midPoint), text.substring(midPoint)];
  }
  
  const lines: string[] = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    
    if (testLine.length <= maxChars) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        // Palabra larga - permitir que se muestre completa si no es excesiva
        if (word.length > maxChars * 1.5) {
          lines.push(word.substring(0, maxChars));
          currentLine = word.substring(maxChars);
        } else {
          currentLine = word;
        }
      }
    }
  }
  
  if (currentLine) lines.push(currentLine);
  
  // Máximo 3 líneas para mejor legibilidad
  return lines.slice(0, 3);
}

// Función de envoltura de texto ultra-simple para compatibilidad
function ultraSimpleWrap(text: string, maxChars: number): string[] {
  if (!text || text.length <= maxChars) return [text || ''];
  
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    
    if (testLine.length <= maxChars) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        // Si una palabra es muy larga, córtala de forma simple
        lines.push(word.substring(0, maxChars));
        currentLine = word.length > maxChars ? word.substring(maxChars) : '';
      }
    }
  }
  
  if (currentLine) lines.push(currentLine);
  
  // Máximo 2 líneas para mantener el diseño ultra-simple
  return lines.slice(0, 2);
}

// Función de envoltura de texto simple y limpia (mantenida para compatibilidad)
function cleanTextWrap(text: string, maxChars: number): string[] {
  if (!text || text.length <= maxChars) return [text || ''];
  
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    
    if (testLine.length <= maxChars) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        // Si una palabra es muy larga, córtala
        lines.push(word.substring(0, maxChars));
        currentLine = word.length > maxChars ? word.substring(maxChars) : '';
      }
    }
  }
  
  if (currentLine) lines.push(currentLine);
  
  // Máximo 2 líneas para mantener legibilidad
  return lines.slice(0, 2);
}

// Función de utilidad mantenida para compatibilidad
function wrapText(text: string, maxLength: number): string[] {
  return cleanTextWrap(text, maxLength);
}

// ============================================================================
// FUNCIONES MEJORADAS PARA GENERACIÓN SVG ULTRA-PROFESIONAL
// ============================================================================

/**
 * Genera un SVG con diseño ultra-profesional inspirado en D3.js
 */
function generateEnhancedSvg(structure: MindMapStructure, isHorizontal?: boolean): string {
  // DISEÑO ULTRA-PROFESIONAL - CANVAS OPTIMIZADO PARA UNA PÁGINA
  const width = isHorizontal ? 1200 : 900;
  const height = isHorizontal ? 700 : 1000; // Reducido para caber en una página
  
  // Paleta de colores profesional inspirada en D3.js Tableau10
  const colorScheme = [
    '#4e79a7', // Central - azul profundo
    '#f28e2c', // Rama 1 - naranja
    '#e15759', // Rama 2 - rojo coral
    '#76b7b2', // Rama 3 - verde azulado
    '#59a14f', // Rama 4 - verde
    '#edc949', // Rama 5 - amarillo
    '#af7aa1', // Rama 6 - púrpura
    '#ff9d9a', // Subnodos - rosa claro
    '#9c755f', // Extra - marrón
    '#bab0ab'  // Extra - gris
  ];
  
  const colors = {
    background: '#ffffff',
    text: '#ffffff',
    line: '#999999',
    accent: '#f8f9fa',
    shadow: 'rgba(0,0,0,0.1)'
  };
  
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 ${width} ${height}" style="background: ${colors.background};">
    
    <defs>
      <filter id="professionalShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="2" dy="3" stdDeviation="3" flood-color="${colors.shadow}" flood-opacity="0.3"/>
      </filter>
      <style>
        .professional-text { 
          font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif; 
          text-anchor: middle; 
          dominant-baseline: middle; 
          font-weight: 600;
          letter-spacing: 0.3px;
        }
        .central-text { fill: ${colors.text}; font-size: 20px; font-weight: 700; }
        .branch-text { fill: ${colors.text}; font-size: 15px; font-weight: 600; }
        .sub-text { fill: ${colors.text}; font-size: 13px; font-weight: 500; }
        .connection-line { 
          stroke: ${colors.line}; 
          stroke-width: 2.5; 
          stroke-linecap: round;
          opacity: 0.8;
        }
      </style>
    </defs>`;

  if (isHorizontal) {
    // DISEÑO HORIZONTAL PROFESIONAL - INSPIRADO EN D3.js
    const centerX = 180;
    const centerY = height / 2;
    const centralW = 180;
    const centralH = 80;
    const branches = structure.mainBranches;
    
    // Algoritmo de posicionamiento mejorado - evita colisiones
    const branchSpacing = Math.max(120, (height - 120) / branches.length);
    const branchStartY = centerY - ((branches.length - 1) * branchSpacing / 2);
    
    // PASO 1: Líneas de conexión profesionales
    branches.forEach((branch, idx) => {
      const branchY: number = branchStartY + (idx * branchSpacing);
      const branchX = centerX + 300;
      const branchColor = colorScheme[idx + 1] || colorScheme[1];
      
      // Línea central → rama con mejor estilo
      svg += `<line x1="${centerX + centralW/2}" y1="${centerY}" 
        x2="${branchX - 80}" y2="${branchY}" class="connection-line" 
        stroke="${colors.line}" stroke-width="3"/>`;
      
      // Líneas rama → subnodos con espaciado inteligente
      if (branch.children && branch.children.length > 0) {
        const subStartX = branchX + 220;
        const subSpacing = Math.max(130, 400 / branch.children.length); // Espaciado adaptativo
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subX = subStartX + (childIdx * subSpacing);
          const subRadius = 50; // Tamaño óptimo
          
          svg += `<line x1="${branchX + 80}" y1="${branchY}" 
            x2="${subX - subRadius}" y2="${branchY}" class="connection-line" 
            stroke="${colors.line}" stroke-width="2"/>`;
        });
      }
    });
    
    // PASO 2: Nodo central profesional
    svg += `<rect x="${centerX - centralW/2}" y="${centerY - centralH/2}" 
      width="${centralW}" height="${centralH}" rx="20" 
      fill="${colorScheme[0]}" stroke="none" filter="url(#professionalShadow)"/>`;
    
    const centralLines = intelligentTextWrap(structure.centralThemeLabel, 16);
    const centralStartY = centerY - ((centralLines.length - 1) * 20 / 2);
    centralLines.forEach((line: string, idx: number) => {
      svg += `<text x="${centerX}" y="${centralStartY + (idx * 20)}" class="professional-text central-text">${line}</text>`;
    });
    
    // PASO 3: Ramas y subnodos con colores diferenciados
    branches.forEach((branch, idx) => {
      const branchY: number = branchStartY + (idx * branchSpacing);
      const branchX = centerX + 300;
      const branchW = 160;
      const branchH = 60;
      const branchColor = colorScheme[idx + 1] || colorScheme[1];
      
      // Nodo rama con color único
      svg += `<rect x="${branchX - branchW/2}" y="${branchY - branchH/2}" 
        width="${branchW}" height="${branchH}" rx="15" 
        fill="${branchColor}" stroke="none" filter="url(#professionalShadow)"/>`;
      
      const branchLines = intelligentTextWrap(branch.label, 18);
      const branchTextStartY: number = branchY - ((branchLines.length - 1) * 16 / 2);
      branchLines.forEach((line: string, lineIdx: number) => {
        svg += `<text x="${branchX}" y="${branchTextStartY + (lineIdx * 16)}" class="professional-text branch-text">${line}</text>`;
      });
      
      // Subnodos optimizados
      if (branch.children && branch.children.length > 0) {
        const subStartX = branchX + 220;
        const subSpacing = Math.max(130, 400 / branch.children.length);
        const subColor = colorScheme[7]; // Color consistente para subnodos
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subX = subStartX + (childIdx * subSpacing);
          const subRadius = 50;
          
          svg += `<circle cx="${subX}" cy="${branchY}" r="${subRadius}" 
            fill="${subColor}" stroke="none" filter="url(#professionalShadow)"/>`;
          
          const subLines = intelligentTextWrap(child.label, 12);
          const lineHeight = 14;
          const totalTextHeight = (subLines.length - 1) * lineHeight;
          const subTextStartY: number = branchY - (totalTextHeight / 2);
          subLines.forEach((line: string, lineIdx: number) => {
            const yPosition = subTextStartY + (lineIdx * lineHeight);
            svg += `<text x="${subX}" y="${yPosition}" class="professional-text sub-text" 
              text-anchor="middle" dominant-baseline="middle">${line}</text>`;
          });
        });
      }
    });
    
  } else {
    // DISEÑO VERTICAL PROFESIONAL - OPTIMIZADO PARA UNA PÁGINA
    const centerX = width / 2;
    const startY = 80; // Reducido de 120 a 80
    const centralR = 70; // Reducido de 85 a 70 para mejor proporción
    const branches = structure.mainBranches;
    
    // PASO 1: ALGORITMO DE POSICIONAMIENTO INTELIGENTE
    const branchY = startY + 180; // Reducido de 250 a 180
    const totalBranchWidth = Math.min(width - 80, branches.length * 180); // Ajustado
    const branchStartX = centerX - (totalBranchWidth / 2);
    const branchSpacing = totalBranchWidth / branches.length;
    
    // Líneas de conexión profesionales
    branches.forEach((branch, idx) => {
      const branchX = branchStartX + (idx + 0.5) * branchSpacing;
      const branchColor = colorScheme[idx + 1] || colorScheme[1];
      
      // Línea central → rama (desde la parte inferior del central)
      svg += `<line x1="${centerX}" y1="${startY + centralR}" 
        x2="${branchX}" y2="${branchY - 27}" class="connection-line" 
        stroke="${colors.line}" stroke-width="3"/>`;
      
      // Líneas rama → subnodos
      if (branch.children && branch.children.length > 0) {
        const subStartY = branchY + 90; // Sincronizado con PASO 4
        const subSpacing = 75; // Sincronizado con PASO 4
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subY = subStartY + (childIdx * subSpacing);
          const subR = 40; // Sincronizado con PASO 4
          
          svg += `<line x1="${branchX}" y1="${branchY + 27}" 
            x2="${branchX}" y2="${subY - subR}" class="connection-line" 
            stroke="${colors.line}" stroke-width="2"/>`;
        });
      }
    });
    
    // PASO 2: NODO CENTRAL PROFESIONAL
    svg += `<circle cx="${centerX}" cy="${startY}" r="${centralR}" 
      fill="${colorScheme[0]}" stroke="none" filter="url(#professionalShadow)"/>`;
    
    const centralLines = intelligentTextWrap(structure.centralThemeLabel, 12); // Reducido de 16 a 12 para más líneas
    const centralTextY = startY - ((centralLines.length - 1) * 16 / 2); // Reducido espaciado
    centralLines.forEach((line: string, idx: number) => {
      svg += `<text x="${centerX}" y="${centralTextY + (idx * 16)}" class="professional-text central-text" 
        style="font-size: 15px;">${line}</text>`; // Reducido de 22px a 15px
    });
    
    // PASO 3: RAMAS PRINCIPALES CON COLORES ÚNICOS
    branches.forEach((branch, idx) => {
      const branchX = branchStartX + (idx + 0.5) * branchSpacing;
      const branchW = 150; // Reducido de 170 a 150
      const branchH = 55;  // Reducido de 70 a 55
      const branchColor = colorScheme[idx + 1] || colorScheme[1];
      
      // Nodo rama profesional
      svg += `<rect x="${branchX - branchW/2}" y="${branchY - branchH/2}" 
        width="${branchW}" height="${branchH}" rx="14" 
        fill="${branchColor}" stroke="none" filter="url(#professionalShadow)"/>`;
      
      const branchLines = intelligentTextWrap(branch.label, 16); // Reducido de 18 a 16
      const branchTextY = branchY - ((branchLines.length - 1) * 15 / 2);
      branchLines.forEach((line: string, lineIdx: number) => {
        svg += `<text x="${branchX}" y="${branchTextY + (lineIdx * 15)}" class="professional-text branch-text" 
          style="font-size: 13px;">${line}</text>`; // Reducido de 16px a 13px
      });
      
      // PASO 4: SUBNODOS OPTIMIZADOS PARA UNA PÁGINA
      if (branch.children && branch.children.length > 0) {
        const subStartY = branchY + 90; // Reducido de 140 a 90
        const subSpacing = 75; // Reducido de 110 a 75 para caber en una página
        const subColor = colorScheme[7]; // Color consistente para subnodos
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subY = subStartY + (childIdx * subSpacing);
          const subR = 40; // Reducido de 55 a 40
          
          // Subnodo profesional
          svg += `<circle cx="${branchX}" cy="${subY}" r="${subR}" 
            fill="${subColor}" stroke="none" filter="url(#professionalShadow)"/>`;
          
          const subLines = intelligentTextWrap(child.label, 12); // Reducido de 14 a 12
          const lineHeight = 13; // Reducido de 15 a 13
          const totalTextHeight = (subLines.length - 1) * lineHeight;
          const subTextY = subY - (totalTextHeight / 2);
          subLines.forEach((line: string, lineIdx: number) => {
            const yPosition = subTextY + (lineIdx * lineHeight);
            svg += `<text x="${branchX}" y="${yPosition}" class="professional-text sub-text" 
              text-anchor="middle" dominant-baseline="middle" style="font-size: 11px;">${line}</text>`;
          });
        });
      }
    });
  }
  
  svg += '</svg>';
  return svg;
}

/**
 * Función mejorada de envoltura de texto con algoritmo más inteligente
 */
function smartTextWrap(text: string, maxChars: number): string[] {
  if (!text || text.length <= maxChars) return [text || ''];
  
  // Primero intentar cortar por palabras
  const words = text.split(' ');
  if (words.length === 1) {
    // Si es una sola palabra muy larga, cortarla inteligentemente
    if (text.length > maxChars * 2) {
      return [text.substring(0, maxChars), text.substring(maxChars, maxChars * 2)];
    }
    return [text];
  }
  
  const lines: string[] = [];
  let currentLine = '';
  
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    
    if (testLine.length <= maxChars) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        // Si una palabra es muy larga, cortarla inteligentemente
        if (word.length > maxChars) {
          lines.push(word.substring(0, maxChars));
          currentLine = word.substring(maxChars);
        } else {
          currentLine = word;
        }
      }
    }
  }
  
  if (currentLine) lines.push(currentLine);
  
  // Máximo 3 líneas para el nuevo diseño mejorado
  return lines.slice(0, 3);
}

// Función de utilidad para compatibilidad con el diseño anterior
function enhancedTextWrap(text: string, maxChars: number): string[] {
  return smartTextWrap(text, maxChars);
}

// =============================================================================
// FUNCIONES ESPECIALIZADAS PARA MATEMÁTICAS
// =============================================================================

/**
 * Genera estructura mock especializada para temas matemáticos
 */
function generateMathMockStructure(input: CreateMindMapInput): MindMapStructure {
  const centralTheme = input.centralTheme.toLowerCase();
  const language = input.language;
  
  // Mapeo de temas matemáticos con ejercicios, fórmulas y procedimientos
  const mathTopicMappings: Record<string, {centralLabel: string, branches: Array<{label: string, children: string[]}>}> = {
    // =====================================================================
    // OPERACIONES BÁSICAS - SUMAS, RESTAS, ETC.
    // =====================================================================
    'suma': {
      centralLabel: language === 'es' ? 'SUMA ➕' : 'ADDITION ➕',
      branches: [
        {
          label: language === 'es' ? '🖐️ Usar Dedos' : '🖐️ Use Fingers',
          children: language === 'es' 
            ? ['3 + 2 = 5 ✋', '4 + 1 = 5', '2 + 3 = 5']
            : ['3 + 2 = 5 ✋', '4 + 1 = 5', '2 + 3 = 5']
        },
        {
          label: language === 'es' ? '0️⃣ Sumar Cero' : '0️⃣ Add Zero',
          children: language === 'es'
            ? ['5 + 0 = 5', '3 + 0 = 3', '0 + 7 = 7']
            : ['5 + 0 = 5', '3 + 0 = 3', '0 + 7 = 7']
        },
        {
          label: language === 'es' ? '🔟 Formar 10' : '🔟 Make 10',
          children: language === 'es'
            ? ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
            : ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
        },
        {
          label: language === 'es' ? '👯 Dobles' : '👯 Doubles',
          children: language === 'es'
            ? ['2 + 2 = 4', '5 + 5 = 10', '3 + 3 = 6']
            : ['2 + 2 = 4', '5 + 5 = 10', '3 + 3 = 6']
        }
      ]
    },
    'sumas': {
      centralLabel: language === 'es' ? 'SUMAS ➕' : 'ADDITION ➕',
      branches: [
        {
          label: language === 'es' ? '🖐️ Usar Dedos' : '🖐️ Use Fingers',
          children: language === 'es' 
            ? ['3 + 2 = 5 ✋', '4 + 1 = 5', '2 + 3 = 5']
            : ['3 + 2 = 5 ✋', '4 + 1 = 5', '2 + 3 = 5']
        },
        {
          label: language === 'es' ? '0️⃣ Sumar Cero' : '0️⃣ Add Zero',
          children: language === 'es'
            ? ['5 + 0 = 5', '3 + 0 = 3', '0 + 7 = 7']
            : ['5 + 0 = 5', '3 + 0 = 3', '0 + 7 = 7']
        },
        {
          label: language === 'es' ? '🔟 Formar 10' : '🔟 Make 10',
          children: language === 'es'
            ? ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
            : ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
        },
        {
          label: language === 'es' ? '👯 Dobles' : '👯 Doubles',
          children: language === 'es'
            ? ['2 + 2 = 4', '5 + 5 = 10', '3 + 3 = 6']
            : ['2 + 2 = 4', '5 + 5 = 10', '3 + 3 = 6']
        }
      ]
    },
    'resta': {
      centralLabel: language === 'es' ? 'RESTA a - b = c' : 'SUBTRACTION a - b = c',
      branches: [
        {
          label: language === 'es' ? '📐 Términos' : '📐 Terms',
          children: language === 'es' 
            ? ['a = minuendo', 'b = sustraendo', 'c = diferencia']
            : ['a = minuend', 'b = subtrahend', 'c = difference']
        },
        {
          label: language === 'es' ? '🔢 Ejemplos' : '🔢 Examples',
          children: language === 'es'
            ? ['42 - 17 = 25', '100 - 36 = 64', '305 - 148 = 157']
            : ['42 - 17 = 25', '100 - 36 = 64', '305 - 148 = 157']
        },
        {
          label: language === 'es' ? '✏️ Ejercicios' : '✏️ Exercises',
          children: language === 'es'
            ? ['85 - 37 = ?', '200 - 86 = ?', '500 - 123 = ?']
            : ['85 - 37 = ?', '200 - 86 = ?', '500 - 123 = ?']
        },
        {
          label: language === 'es' ? '✓ Prueba' : '✓ Check',
          children: language === 'es'
            ? ['c + b = a', '25 + 17 = 42', '64 + 36 = 100']
            : ['c + b = a', '25 + 17 = 42', '64 + 36 = 100']
        }
      ]
    },
    'restas': {
      centralLabel: language === 'es' ? 'RESTAS a - b = c' : 'SUBTRACTION a - b = c',
      branches: [
        {
          label: language === 'es' ? '📐 Términos' : '📐 Terms',
          children: language === 'es' 
            ? ['a = minuendo', 'b = sustraendo', 'c = diferencia']
            : ['a = minuend', 'b = subtrahend', 'c = difference']
        },
        {
          label: language === 'es' ? '🔢 Ejemplos' : '🔢 Examples',
          children: language === 'es'
            ? ['42 - 17 = 25', '100 - 36 = 64', '305 - 148 = 157']
            : ['42 - 17 = 25', '100 - 36 = 64', '305 - 148 = 157']
        },
        {
          label: language === 'es' ? '✏️ Ejercicios' : '✏️ Exercises',
          children: language === 'es'
            ? ['85 - 37 = ?', '200 - 86 = ?', '500 - 123 = ?']
            : ['85 - 37 = ?', '200 - 86 = ?', '500 - 123 = ?']
        },
        {
          label: language === 'es' ? '✓ Prueba' : '✓ Check',
          children: language === 'es'
            ? ['c + b = a', '25 + 17 = 42', '64 + 36 = 100']
            : ['c + b = a', '25 + 17 = 42', '64 + 36 = 100']
        }
      ]
    },
    'adición': {
      centralLabel: language === 'es' ? 'ADICIÓN a + b = c' : 'ADDITION a + b = c',
      branches: [
        {
          label: language === 'es' ? '📐 Propiedades' : '📐 Properties',
          children: language === 'es' 
            ? ['a+b = b+a', '(a+b)+c = a+(b+c)', 'a + 0 = a']
            : ['a+b = b+a', '(a+b)+c = a+(b+c)', 'a + 0 = a']
        },
        {
          label: language === 'es' ? '🔢 Ejemplos' : '🔢 Examples',
          children: language === 'es'
            ? ['8 + 7 = 15', '27 + 35 = 62', '148 + 275 = 423']
            : ['8 + 7 = 15', '27 + 35 = 62', '148 + 275 = 423']
        },
        {
          label: language === 'es' ? '✏️ Ejercicios' : '✏️ Exercises',
          children: language === 'es'
            ? ['25 + 18 = ?', '156 + 89 = ?', '999 + 1 = ?']
            : ['25 + 18 = ?', '156 + 89 = ?', '999 + 1 = ?']
        },
        {
          label: language === 'es' ? '💡 Trucos' : '💡 Tricks',
          children: language === 'es'
            ? ['99+1 = 100', '47+3 = 50', '25+25 = 50']
            : ['99+1 = 100', '47+3 = 50', '25+25 = 50']
        }
      ]
    },
    'sustracción': {
      centralLabel: language === 'es' ? 'SUSTRACCIÓN a - b = c' : 'SUBTRACTION a - b = c',
      branches: [
        {
          label: language === 'es' ? '📐 Términos' : '📐 Terms',
          children: language === 'es' 
            ? ['a = minuendo', 'b = sustraendo', 'c = diferencia']
            : ['a = minuend', 'b = subtrahend', 'c = difference']
        },
        {
          label: language === 'es' ? '🔢 Ejemplos' : '🔢 Examples',
          children: language === 'es'
            ? ['42 - 17 = 25', '100 - 36 = 64', '305 - 148 = 157']
            : ['42 - 17 = 25', '100 - 36 = 64', '305 - 148 = 157']
        },
        {
          label: language === 'es' ? '✏️ Ejercicios' : '✏️ Exercises',
          children: language === 'es'
            ? ['85 - 37 = ?', '200 - 86 = ?', '500 - 123 = ?']
            : ['85 - 37 = ?', '200 - 86 = ?', '500 - 123 = ?']
        },
        {
          label: language === 'es' ? '✓ Prueba' : '✓ Check',
          children: language === 'es'
            ? ['c + b = a', '25 + 17 = 42', '64 + 36 = 100']
            : ['c + b = a', '25 + 17 = 42', '64 + 36 = 100']
        }
      ]
    },
    'tablas de multiplicar': {
      centralLabel: language === 'es' ? 'TABLAS MULTIPLICAR' : 'TIMES TABLES',
      branches: [
        {
          label: language === 'es' ? '📐 Tabla 7' : '📐 Table 7',
          children: language === 'es' 
            ? ['7×6 = 42', '7×7 = 49', '7×8 = 56']
            : ['7×6 = 42', '7×7 = 49', '7×8 = 56']
        },
        {
          label: language === 'es' ? '🔢 Tabla 8' : '🔢 Table 8',
          children: language === 'es'
            ? ['8×6 = 48', '8×7 = 56', '8×8 = 64']
            : ['8×6 = 48', '8×7 = 56', '8×8 = 64']
        },
        {
          label: language === 'es' ? '✏️ Tabla 9' : '✏️ Table 9',
          children: language === 'es'
            ? ['9×6 = 54', '9×7 = 63', '9×8 = 72']
            : ['9×6 = 54', '9×7 = 63', '9×8 = 72']
        },
        {
          label: language === 'es' ? '💡 Truco 9' : '💡 9 Trick',
          children: language === 'es'
            ? ['Usa dedos', '9×4 = 36', '9×7 = 63']
            : ['Use fingers', '9×4 = 36', '9×7 = 63']
        }
      ]
    },
    'números decimales': {
      centralLabel: language === 'es' ? 'DECIMALES' : 'DECIMALS',
      branches: [
        {
          label: language === 'es' ? '📐 Lectura' : '📐 Reading',
          children: language === 'es' 
            ? ['0,5 = 5 décimos', '0,25 = 25 cents.', '3,14 = pi']
            : ['0.5 = 5 tenths', '0.25 = 25 hunds.', '3.14 = pi']
        },
        {
          label: language === 'es' ? '🔢 Suma' : '🔢 Add',
          children: language === 'es'
            ? ['Alinear comas', '2,5 + 1,25', '= 3,75']
            : ['Align decimals', '2.5 + 1.25', '= 3.75']
        },
        {
          label: language === 'es' ? '✖️ Multiplicar' : '✖️ Multiply',
          children: language === 'es'
            ? ['Sin coma', '2,5 × 0,4', '= 1,00']
            : ['No decimal', '2.5 × 0.4', '= 1.00']
        },
        {
          label: language === 'es' ? '➗ Dividir' : '➗ Divide',
          children: language === 'es'
            ? ['7,5 ÷ 2,5 = 3', '10 ÷ 0,5 = 20', '6 ÷ 0,2 = 30']
            : ['7.5 ÷ 2.5 = 3', '10 ÷ 0.5 = 20', '6 ÷ 0.2 = 30']
        }
      ]
    },
    'potencias': {
      centralLabel: language === 'es' ? 'POTENCIAS aⁿ' : 'POWERS aⁿ',
      branches: [
        {
          label: language === 'es' ? '📐 Qué es' : '📐 What is',
          children: language === 'es' 
            ? ['aⁿ = a×a×...n', 'a = base', 'n = exponente']
            : ['aⁿ = a×a×...n', 'a = base', 'n = exponent']
        },
        {
          label: language === 'es' ? '🔢 Reglas' : '🔢 Rules',
          children: language === 'es'
            ? ['aᵐ × aⁿ = aᵐ⁺ⁿ', 'aᵐ ÷ aⁿ = aᵐ⁻ⁿ', '(aᵐ)ⁿ = aᵐˣⁿ']
            : ['aᵐ × aⁿ = aᵐ⁺ⁿ', 'aᵐ ÷ aⁿ = aᵐ⁻ⁿ', '(aᵐ)ⁿ = aᵐˣⁿ']
        },
        {
          label: language === 'es' ? '✏️ Ejemplos' : '✏️ Examples',
          children: language === 'es'
            ? ['2³ = 2×2×2 = 8', '5² = 25', '10³ = 1.000']
            : ['2³ = 2×2×2 = 8', '5² = 25', '10³ = 1,000']
        },
        {
          label: language === 'es' ? '📊 Casos Especiales' : '📊 Special Cases',
          children: language === 'es'
            ? ['a⁰ = 1', 'a¹ = a', 'a⁻¹ = 1/a']
            : ['a⁰ = 1', 'a¹ = a', 'a⁻¹ = 1/a']
        }
      ]
    },
    'raíces': {
      centralLabel: language === 'es' ? 'RAÍCES √a' : 'ROOTS √a',
      branches: [
        {
          label: language === 'es' ? '📐 Definición' : '📐 Definition',
          children: language === 'es' 
            ? ['√a = b si b² = a', 'ⁿ√a = raíz n-ésima', 'Operación inversa potencia']
            : ['√a = b if b² = a', 'ⁿ√a = nth root', 'Inverse of power']
        },
        {
          label: language === 'es' ? '🔢 Raíces Perfectas' : '🔢 Perfect Roots',
          children: language === 'es'
            ? ['√4 = 2', '√9 = 3', '√16 = 4', '√25 = 5']
            : ['√4 = 2', '√9 = 3', '√16 = 4', '√25 = 5']
        },
        {
          label: language === 'es' ? '✏️ Propiedades' : '✏️ Properties',
          children: language === 'es'
            ? ['√(a×b) = √a × √b', '√(a/b) = √a / √b', '√a² = |a|']
            : ['√(a×b) = √a × √b', '√(a/b) = √a / √b', '√a² = |a|']
        },
        {
          label: language === 'es' ? '📊 Aproximaciones' : '📊 Approximations',
          children: language === 'es'
            ? ['√2 ≈ 1,414', '√3 ≈ 1,732', '√5 ≈ 2,236']
            : ['√2 ≈ 1.414', '√3 ≈ 1.732', '√5 ≈ 2.236']
        }
      ]
    },
    'razones y proporciones': {
      centralLabel: language === 'es' ? 'RAZONES Y PROPORCIONES' : 'RATIOS AND PROPORTIONS',
      branches: [
        {
          label: language === 'es' ? '📐 Razón' : '📐 Ratio',
          children: language === 'es' 
            ? ['a:b = a/b', 'Comparación cociente', 'Ej: 3:4 = 3/4 = 0,75']
            : ['a:b = a/b', 'Quotient comparison', 'Ex: 3:4 = 3/4 = 0.75']
        },
        {
          label: language === 'es' ? '🔢 Proporción' : '🔢 Proportion',
          children: language === 'es'
            ? ['a/b = c/d', 'a×d = b×c', 'Medios = Extremos']
            : ['a/b = c/d', 'a×d = b×c', 'Means = Extremes']
        },
        {
          label: language === 'es' ? '✏️ Regla de 3' : '✏️ Rule of Three',
          children: language === 'es'
            ? ['a → b', 'c → x = (b×c)/a', 'Ej: 3→6, 5→x=10']
            : ['a → b', 'c → x = (b×c)/a', 'Ex: 3→6, 5→x=10']
        },
        {
          label: language === 'es' ? '📊 Directa/Inversa' : '📊 Direct/Inverse',
          children: language === 'es'
            ? ['Directa: ↑ más → ↑ más', 'Inversa: ↑ más → ↓ menos', 'Identificar tipo']
            : ['Direct: ↑ more → ↑ more', 'Inverse: ↑ more → ↓ less', 'Identify type']
        }
      ]
    },
    // ARITMÉTICA Y OPERACIONES BÁSICAS
    'fracciones': {
      centralLabel: language === 'es' ? 'FRACCIONES a/b' : 'FRACTIONS a/b',
      branches: [
        {
          label: language === 'es' ? '📐 Definición' : '📐 Definition',
          children: language === 'es' 
            ? ['a = numerador', 'b = denominador', 'b ≠ 0']
            : ['a = numerator', 'b = denominator', 'b ≠ 0']
        },
        {
          label: language === 'es' ? '🔢 Suma y Resta' : '🔢 Add & Subtract',
          children: language === 'es'
            ? ['a/c + b/c = (a+b)/c', 'MCM para distintos', 'Ej: 1/2 + 1/4 = 3/4']
            : ['a/c + b/c = (a+b)/c', 'LCM for different', 'Ex: 1/2 + 1/4 = 3/4']
        },
        {
          label: language === 'es' ? '✖️ Multiplicación' : '✖️ Multiplication',
          children: language === 'es'
            ? ['a/b × c/d = ac/bd', 'Ej: 2/3 × 1/2 = 2/6 = 1/3', 'Simplificar resultado']
            : ['a/b × c/d = ac/bd', 'Ex: 2/3 × 1/2 = 2/6 = 1/3', 'Simplify result']
        },
        {
          label: language === 'es' ? '➗ División' : '➗ Division',
          children: language === 'es'
            ? ['a/b ÷ c/d = a/b × d/c', 'Invertir y multiplicar', 'Ej: 3/4 ÷ 1/2 = 3/2']
            : ['a/b ÷ c/d = a/b × d/c', 'Invert and multiply', 'Ex: 3/4 ÷ 1/2 = 3/2']
        }
      ]
    },
    'ecuación cuadrática': {
      centralLabel: language === 'es' ? 'ECUACIÓN CUADRÁTICA ax²+bx+c=0' : 'QUADRATIC EQUATION ax²+bx+c=0',
      branches: [
        {
          label: language === 'es' ? '📐 Fórmula General' : '📐 General Formula',
          children: language === 'es'
            ? ['x = (-b±√Δ)/2a', 'Δ = b² - 4ac', 'Discriminante']
            : ['x = (-b±√Δ)/2a', 'Δ = b² - 4ac', 'Discriminant']
        },
        {
          label: language === 'es' ? '🔢 Procedimiento' : '🔢 Procedure',
          children: language === 'es'
            ? ['1. Identificar a,b,c', '2. Calcular Δ', '3. Aplicar fórmula']
            : ['1. Identify a,b,c', '2. Calculate Δ', '3. Apply formula']
        },
        {
          label: language === 'es' ? '✏️ Ejemplo' : '✏️ Example',
          children: language === 'es'
            ? ['x²-5x+6=0', 'a=1, b=-5, c=6', 'x₁=2, x₂=3']
            : ['x²-5x+6=0', 'a=1, b=-5, c=6', 'x₁=2, x₂=3']
        },
        {
          label: language === 'es' ? '📊 Tipos de Raíces' : '📊 Root Types',
          children: language === 'es'
            ? ['Δ>0: 2 reales', 'Δ=0: 1 real doble', 'Δ<0: complejas']
            : ['Δ>0: 2 real', 'Δ=0: 1 double', 'Δ<0: complex']
        }
      ]
    },
    'teorema de pitágoras': {
      centralLabel: language === 'es' ? 'TEOREMA DE PITÁGORAS a²+b²=c²' : 'PYTHAGOREAN THEOREM a²+b²=c²',
      branches: [
        {
          label: language === 'es' ? '📐 Fórmula' : '📐 Formula',
          children: language === 'es'
            ? ['c² = a² + b²', 'c = √(a² + b²)', 'c = hipotenusa']
            : ['c² = a² + b²', 'c = √(a² + b²)', 'c = hypotenuse']
        },
        {
          label: language === 'es' ? '🔢 Para hallar cateto' : '🔢 Find leg',
          children: language === 'es'
            ? ['a² = c² - b²', 'a = √(c² - b²)', 'Solo triáng. rect.']
            : ['a² = c² - b²', 'a = √(c² - b²)', 'Right triangle only']
        },
        {
          label: language === 'es' ? '✏️ Ejemplo Clásico' : '✏️ Classic Example',
          children: language === 'es'
            ? ['3² + 4² = 5²', '9 + 16 = 25', 'Terna: 3, 4, 5']
            : ['3² + 4² = 5²', '9 + 16 = 25', 'Triple: 3, 4, 5']
        },
        {
          label: language === 'es' ? '📏 Otras Ternas' : '📏 Other Triples',
          children: language === 'es'
            ? ['5, 12, 13', '8, 15, 17', '7, 24, 25']
            : ['5, 12, 13', '8, 15, 17', '7, 24, 25']
        }
      ]
    },
    'porcentaje': {
      centralLabel: language === 'es' ? 'PORCENTAJE %' : 'PERCENTAGE %',
      branches: [
        {
          label: language === 'es' ? '📐 Fórmula Base' : '📐 Base Formula',
          children: language === 'es'
            ? ['% = (parte/total)×100', 'Parte = (% × total)/100', 'Total = parte×100/%']
            : ['% = (part/total)×100', 'Part = (% × total)/100', 'Total = part×100/%']
        },
        {
          label: language === 'es' ? '🔢 Calcular %' : '🔢 Calculate %',
          children: language === 'es'
            ? ['1. Dividir parte/total', '2. Multiplicar por 100', 'Ej: 25/100 = 25%']
            : ['1. Divide part/total', '2. Multiply by 100', 'Ex: 25/100 = 25%']
        },
        {
          label: language === 'es' ? '✏️ Ejemplos' : '✏️ Examples',
          children: language === 'es'
            ? ['20% de 150 = 30', '50% = mitad', '25% = cuarto']
            : ['20% of 150 = 30', '50% = half', '25% = quarter']
        },
        {
          label: language === 'es' ? '📊 Conversiones' : '📊 Conversions',
          children: language === 'es'
            ? ['25% = 0.25 = 1/4', '50% = 0.5 = 1/2', '75% = 0.75 = 3/4']
            : ['25% = 0.25 = 1/4', '50% = 0.5 = 1/2', '75% = 0.75 = 3/4']
        }
      ]
    },
    'área': {
      centralLabel: language === 'es' ? 'FÓRMULAS DE ÁREA' : 'AREA FORMULAS',
      branches: [
        {
          label: language === 'es' ? '📐 Cuadrado' : '📐 Square',
          children: language === 'es'
            ? ['A = lado²', 'A = l × l', 'Ej: l=5 → A=25']
            : ['A = side²', 'A = s × s', 'Ex: s=5 → A=25']
        },
        {
          label: language === 'es' ? '📏 Rectángulo' : '📏 Rectangle',
          children: language === 'es'
            ? ['A = base × altura', 'A = b × h', 'Ej: 4×6=24']
            : ['A = base × height', 'A = b × h', 'Ex: 4×6=24']
        },
        {
          label: language === 'es' ? '🔺 Triángulo' : '🔺 Triangle',
          children: language === 'es'
            ? ['A = (b × h)/2', 'Mitad del rectángulo', 'Ej: (6×4)/2=12']
            : ['A = (b × h)/2', 'Half rectangle', 'Ex: (6×4)/2=12']
        },
        {
          label: language === 'es' ? '⭕ Círculo' : '⭕ Circle',
          children: language === 'es'
            ? ['A = π × r²', 'π ≈ 3.14159', 'Ej: r=3 → A≈28.27']
            : ['A = π × r²', 'π ≈ 3.14159', 'Ex: r=3 → A≈28.27']
        }
      ]
    },
    'perímetro': {
      centralLabel: language === 'es' ? 'FÓRMULAS DE PERÍMETRO' : 'PERIMETER FORMULAS',
      branches: [
        {
          label: language === 'es' ? '📐 Cuadrado' : '📐 Square',
          children: language === 'es'
            ? ['P = 4 × lado', 'P = 4l', 'Ej: l=5 → P=20']
            : ['P = 4 × side', 'P = 4s', 'Ex: s=5 → P=20']
        },
        {
          label: language === 'es' ? '📏 Rectángulo' : '📏 Rectangle',
          children: language === 'es'
            ? ['P = 2(b + h)', 'P = 2b + 2h', 'Ej: 2(4+6)=20']
            : ['P = 2(b + h)', 'P = 2b + 2h', 'Ex: 2(4+6)=20']
        },
        {
          label: language === 'es' ? '🔺 Triángulo' : '🔺 Triangle',
          children: language === 'es'
            ? ['P = a + b + c', 'Suma de lados', 'Ej: 3+4+5=12']
            : ['P = a + b + c', 'Sum of sides', 'Ex: 3+4+5=12']
        },
        {
          label: language === 'es' ? '⭕ Circunferencia' : '⭕ Circumference',
          children: language === 'es'
            ? ['C = 2πr', 'C = πd', 'Ej: r=3 → C≈18.85']
            : ['C = 2πr', 'C = πd', 'Ex: r=3 → C≈18.85']
        }
      ]
    },
    'multiplicación': {
      centralLabel: language === 'es' ? 'MULTIPLICACIÓN a × b' : 'MULTIPLICATION a × b',
      branches: [
        {
          label: language === 'es' ? '📐 Propiedades' : '📐 Properties',
          children: language === 'es'
            ? ['Conmutativa: a×b=b×a', 'Asociativa: (a×b)×c', 'Distributiva']
            : ['Commutative: a×b=b×a', 'Associative: (a×b)×c', 'Distributive']
        },
        {
          label: language === 'es' ? '🔢 Elemento Neutro' : '🔢 Identity Element',
          children: language === 'es'
            ? ['a × 1 = a', 'a × 0 = 0', '5 × 1 = 5']
            : ['a × 1 = a', 'a × 0 = 0', '5 × 1 = 5']
        },
        {
          label: language === 'es' ? '✏️ Tablas Clave' : '✏️ Key Tables',
          children: language === 'es'
            ? ['7×8=56', '6×7=42', '8×9=72']
            : ['7×8=56', '6×7=42', '8×9=72']
        },
        {
          label: language === 'es' ? '📊 Trucos' : '📊 Tricks',
          children: language === 'es'
            ? ['×9: dedos', '×5: mitad×10', '×11: suma dígitos']
            : ['×9: fingers', '×5: half×10', '×11: sum digits']
        }
      ]
    },
    'división': {
      centralLabel: language === 'es' ? 'DIVISIÓN a ÷ b = c' : 'DIVISION a ÷ b = c',
      branches: [
        {
          label: language === 'es' ? '📐 Términos' : '📐 Terms',
          children: language === 'es'
            ? ['a = dividendo', 'b = divisor', 'c = cociente']
            : ['a = dividend', 'b = divisor', 'c = quotient']
        },
        {
          label: language === 'es' ? '🔢 Verificación' : '🔢 Verification',
          children: language === 'es'
            ? ['D = d × c + r', 'Ej: 17=5×3+2', 'r < divisor']
            : ['D = d × q + r', 'Ex: 17=5×3+2', 'r < divisor']
        },
        {
          label: language === 'es' ? '✏️ División Exacta' : '✏️ Exact Division',
          children: language === 'es'
            ? ['Resto = 0', '20 ÷ 4 = 5', 'Sin residuo']
            : ['Remainder = 0', '20 ÷ 4 = 5', 'No remainder']
        },
        {
          label: language === 'es' ? '⚠️ Regla' : '⚠️ Rule',
          children: language === 'es'
            ? ['No dividir por 0', '÷1 = mismo número', '÷ sí mismo = 1']
            : ["Can't divide by 0", '÷1 = same number', '÷ itself = 1']
        }
      ]
    },
    'números enteros': {
      centralLabel: language === 'es' ? 'NÚMEROS ENTEROS ℤ' : 'INTEGERS ℤ',
      branches: [
        {
          label: language === 'es' ? '📐 Definición' : '📐 Definition',
          children: language === 'es'
            ? ['ℤ = {...-2,-1,0,1,2...}', 'Positivos: +', 'Negativos: -']
            : ['ℤ = {...-2,-1,0,1,2...}', 'Positive: +', 'Negative: -']
        },
        {
          label: language === 'es' ? '➕ Suma' : '➕ Addition',
          children: language === 'es'
            ? ['(+)+(+) = +', '(-)+(-)  = -', 'Signos ≠: restar']
            : ['(+)+(+) = +', '(-)+(-)  = -', 'Diff signs: subtract']
        },
        {
          label: language === 'es' ? '✖️ Multiplicación' : '✖️ Multiplication',
          children: language === 'es'
            ? ['(+)×(+) = +', '(-)×(-) = +', '(+)×(-) = -']
            : ['(+)×(+) = +', '(-)×(-) = +', '(+)×(-) = -']
        },
        {
          label: language === 'es' ? '✏️ Ejemplos' : '✏️ Examples',
          children: language === 'es'
            ? ['(-3)+(-5)=-8', '(-4)×(-2)=+8', '(-6)÷(+3)=-2']
            : ['(-3)+(-5)=-8', '(-4)×(-2)=+8', '(-6)÷(+3)=-2']
        }
      ]
    },
    'álgebra': {
      centralLabel: language === 'es' ? 'ÁLGEBRA BÁSICA' : 'BASIC ALGEBRA',
      branches: [
        {
          label: language === 'es' ? '📐 Expresiones' : '📐 Expressions',
          children: language === 'es'
            ? ['Variable: x, y', 'Constante: números', 'Coeficiente: 3x']
            : ['Variable: x, y', 'Constant: numbers', 'Coefficient: 3x']
        },
        {
          label: language === 'es' ? '🔢 Ecuaciones' : '🔢 Equations',
          children: language === 'es'
            ? ['ax + b = c', 'Despejar x', 'x = (c-b)/a']
            : ['ax + b = c', 'Solve for x', 'x = (c-b)/a']
        },
        {
          label: language === 'es' ? '✏️ Ejemplo' : '✏️ Example',
          children: language === 'es'
            ? ['2x + 3 = 11', '2x = 11 - 3 = 8', 'x = 8/2 = 4']
            : ['2x + 3 = 11', '2x = 11 - 3 = 8', 'x = 8/2 = 4']
        },
        {
          label: language === 'es' ? '📊 Productos' : '📊 Products',
          children: language === 'es'
            ? ['(a+b)² = a²+2ab+b²', '(a-b)² = a²-2ab+b²', '(a+b)(a-b) = a²-b²']
            : ['(a+b)² = a²+2ab+b²', '(a-b)² = a²-2ab+b²', '(a+b)(a-b) = a²-b²']
        }
      ]
    },
    // =====================================================================
    // TRUCOS RÁPIDOS DE MATEMÁTICAS - PARA NIÑOS DE 1RO BÁSICO
    // =====================================================================
    'trucos': {
      centralLabel: language === 'es' ? 'TRUCOS RÁPIDOS ✨' : 'QUICK TRICKS ✨',
      branches: [
        {
          label: language === 'es' ? '0️⃣ Sumar Cero' : '0️⃣ Add Zero',
          children: language === 'es'
            ? ['5 + 0 = 5', '0 + 3 = 3', '¡No cambia!']
            : ['5 + 0 = 5', '0 + 3 = 3', 'No change!']
        },
        {
          label: language === 'es' ? '🔟 Formar 10' : '🔟 Make 10',
          children: language === 'es'
            ? ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
            : ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
        },
        {
          label: language === 'es' ? '👯 Dobles' : '👯 Doubles',
          children: language === 'es'
            ? ['2 + 2 = 4', '5 + 5 = 10', '4 + 4 = 8']
            : ['2 + 2 = 4', '5 + 5 = 10', '4 + 4 = 8']
        },
        {
          label: language === 'es' ? '🖐️ Usa Dedos' : '🖐️ Use Fingers',
          children: language === 'es'
            ? ['3 + 2 = 5 ✋', '4 + 3 = 7', '¡Cuenta!']
            : ['3 + 2 = 5 ✋', '4 + 3 = 7', 'Count!']
        },
        {
          label: language === 'es' ? '➕ Sumar 1' : '➕ Add 1',
          children: language === 'es'
            ? ['5 + 1 = 6', '9 + 1 = 10', '¡El siguiente!']
            : ['5 + 1 = 6', '9 + 1 = 10', 'The next one!']
        }
      ]
    },
    'trucos rápidos': {
      centralLabel: language === 'es' ? 'TRUCOS RÁPIDOS ✨' : 'QUICK TRICKS ✨',
      branches: [
        {
          label: language === 'es' ? '0️⃣ Sumar Cero' : '0️⃣ Add Zero',
          children: language === 'es'
            ? ['5 + 0 = 5', '0 + 3 = 3', '¡No cambia!']
            : ['5 + 0 = 5', '0 + 3 = 3', 'No change!']
        },
        {
          label: language === 'es' ? '🔟 Formar 10' : '🔟 Make 10',
          children: language === 'es'
            ? ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
            : ['7 + 3 = 10', '8 + 2 = 10', '6 + 4 = 10']
        },
        {
          label: language === 'es' ? '👯 Dobles' : '👯 Doubles',
          children: language === 'es'
            ? ['2 + 2 = 4', '5 + 5 = 10', '4 + 4 = 8']
            : ['2 + 2 = 4', '5 + 5 = 10', '4 + 4 = 8']
        },
        {
          label: language === 'es' ? '🖐️ Usa Dedos' : '🖐️ Use Fingers',
          children: language === 'es'
            ? ['3 + 2 = 5 ✋', '4 + 3 = 7', '¡Cuenta!']
            : ['3 + 2 = 5 ✋', '4 + 3 = 7', 'Count!']
        },
        {
          label: language === 'es' ? '➕ Sumar 1' : '➕ Add 1',
          children: language === 'es'
            ? ['5 + 1 = 6', '9 + 1 = 10', '¡El siguiente!']
            : ['5 + 1 = 6', '9 + 1 = 10', 'The next one!']
        }
      ]
    },
    'trucos matemáticos': {
      centralLabel: language === 'es' ? 'TRUCOS MATEMÁTICOS' : 'MATH TRICKS',
      branches: [
        {
          label: language === 'es' ? '➕ Sumas' : '➕ Addition',
          children: language === 'es'
            ? ['n+0=n', 'Der. a izq.', 'Completar 10s']
            : ['n+0=n', 'Right to left', 'Complete 10s']
        },
        {
          label: language === 'es' ? '➖ Restas' : '➖ Subtraction',
          children: language === 'es'
            ? ['n-0=n', 'Prestar decenas', '100-37=63']
            : ['n-0=n', 'Borrow tens', '100-37=63']
        },
        {
          label: language === 'es' ? '✖️ Multiplicar' : '✖️ Multiply',
          children: language === 'es'
            ? ['×10: añadir 0', '×5: mitad×10', '×11: suma dígitos']
            : ['×10: add 0', '×5: half×10', '×11: sum digits']
        },
        {
          label: language === 'es' ? '➗ Dividir' : '➗ Divide',
          children: language === 'es'
            ? ['÷2: mitad', '÷10: quitar 0', '÷5: ×2÷10']
            : ['÷2: half', '÷10: remove 0', '÷5: ×2÷10']
        },
        {
          label: language === 'es' ? '🧠 Cálculo Mental' : '🧠 Mental Math',
          children: language === 'es'
            ? ['Descomponer', '25×4=100', '8×7: 8×7=56']
            : ['Decompose', '25×4=100', '8×7: 8×7=56']
        }
      ]
    },
    'cálculo mental': {
      centralLabel: language === 'es' ? 'CÁLCULO MENTAL' : 'MENTAL MATH',
      branches: [
        {
          label: language === 'es' ? '➕ Sumar Fácil' : '➕ Easy Addition',
          children: language === 'es'
            ? ['Der. a izq.', 'Completar 10', '99+47: 100+46']
            : ['Right to left', 'Complete 10', '99+47: 100+46']
        },
        {
          label: language === 'es' ? '➖ Restar Fácil' : '➖ Easy Subtraction',
          children: language === 'es'
            ? ['Contar hacia arriba', '100-63: 63+?=100', 'Prestando: 52-28']
            : ['Count up', '100-63: 63+?=100', 'Borrowing: 52-28']
        },
        {
          label: language === 'es' ? '✖️ Multiplicar Fácil' : '✖️ Easy Multiply',
          children: language === 'es'
            ? ['×9: dedos', '×5: ÷2×10', '×25: ÷4×100']
            : ['×9: fingers', '×5: ÷2×10', '×25: ÷4×100']
        },
        {
          label: language === 'es' ? '🎯 Números Amigos' : '🎯 Friendly Numbers',
          children: language === 'es'
            ? ['Suman 10: 7+3', 'Suman 100: 75+25', '×que dan 100']
            : ['Sum 10: 7+3', 'Sum 100: 75+25', '× give 100']
        },
        {
          label: language === 'es' ? '💡 Patrones' : '💡 Patterns',
          children: language === 'es'
            ? ['×11: 23×11=253', '×9: suma=9', 'Cuadrados: 5²=25']
            : ['×11: 23×11=253', '×9: sum=9', 'Squares: 5²=25']
        }
      ]
    }
  };
  
  // Buscar tema en mapeos
  let structure = mathTopicMappings[centralTheme];
  
  if (!structure) {
    // Buscar coincidencias parciales
    for (const [key, value] of Object.entries(mathTopicMappings)) {
      if (centralTheme.includes(key) || key.includes(centralTheme)) {
        structure = value;
        break;
      }
    }
  }
  
  if (!structure) {
    // Fallback genérico para matemáticas - CON CONTENIDO ÚTIL
    const themeUpper = input.centralTheme.toUpperCase();
    structure = {
      centralLabel: themeUpper,
      branches: [
        {
          label: language === 'es' ? '📐 Concepto' : '📐 Concept',
          children: language === 'es' 
            ? [`Qué es ${input.centralTheme}`, 'Elementos clave', 'Notación: símbolos']
            : [`What is ${input.centralTheme}`, 'Key elements', 'Notation: symbols']
        },
        {
          label: language === 'es' ? '🔢 Fórmulas' : '🔢 Formulas',
          children: language === 'es'
            ? ['Fórmula principal', 'Fórmulas derivadas', 'Variables: a, b, x']
            : ['Main formula', 'Derived formulas', 'Variables: a, b, x']
        },
        {
          label: language === 'es' ? '✏️ Procedimiento' : '✏️ Procedure',
          children: language === 'es'
            ? ['1. Identificar datos', '2. Aplicar fórmula', '3. Calcular resultado']
            : ['1. Identify data', '2. Apply formula', '3. Calculate result']
        },
        {
          label: language === 'es' ? '📊 Ejercicio' : '📊 Exercise',
          children: language === 'es'
            ? ['Datos: valores', 'Desarrollo: pasos', 'Resultado: respuesta']
            : ['Data: values', 'Development: steps', 'Result: answer']
        }
      ]
    };
  }
  
  return {
    centralThemeLabel: structure.centralLabel.toUpperCase(),
    mainBranches: structure.branches.map(branch => ({
      label: branch.label,
      children: branch.children.map(child => ({ label: child }))
    }))
  };
}

/**
 * Genera SVG especializado para mapas mentales de matemáticas
 * Usa colores y estilos optimizados para fórmulas y ejercicios
 */
function generateMathSvg(structure: MindMapStructure, isHorizontal?: boolean): string {
  const width = isHorizontal ? 1500 : 1100;
  const height = isHorizontal ? 850 : 1300;
  
  // Paleta de colores especial para matemáticas - tonos azules/verdes profesionales
  const mathColorScheme = [
    '#1e40af', // Central - azul oscuro (matemáticas)
    '#7c3aed', // Rama 1 - violeta (fórmulas)
    '#059669', // Rama 2 - verde esmeralda (procedimientos)
    '#dc2626', // Rama 3 - rojo (ejemplos)
    '#ea580c', // Rama 4 - naranja (aplicaciones)
    '#0891b2', // Rama 5 - cyan
    '#6366f1', // Subnodos - índigo
    '#8b5cf6', // Subnodos alternativo
    '#10b981', // Verde claro
    '#f59e0b'  // Amarillo dorado
  ];
  
  const colors = {
    background: '#f8fafc',
    text: '#ffffff',
    darkText: '#1e293b',
    line: '#64748b',
    mathBg: '#e0e7ff', // Fondo claro para fórmulas
    shadow: 'rgba(0,0,0,0.12)'
  };
  
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 ${width} ${height}" style="background: ${colors.background};">
    
    <defs>
      <filter id="mathShadow" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="2" dy="4" stdDeviation="4" flood-color="${colors.shadow}" flood-opacity="0.4"/>
      </filter>
      
      <!-- Gradiente especial para nodo central matemático -->
      <linearGradient id="mathCentralGradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#1e40af;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#3b82f6;stop-opacity:1" />
      </linearGradient>
      
      <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&amp;display=swap');
        
        .math-text { 
          font-family: 'JetBrains Mono', 'Consolas', 'Monaco', monospace; 
          text-anchor: middle; 
          dominant-baseline: middle; 
          font-weight: 500;
          letter-spacing: 0.2px;
        }
        .central-text { fill: ${colors.text}; font-size: 20px; font-weight: 700; }
        .branch-text { fill: ${colors.text}; font-size: 14px; font-weight: 600; }
        .sub-text { fill: ${colors.text}; font-size: 12px; font-weight: 500; }
        .formula-text { 
          font-family: 'JetBrains Mono', 'Consolas', monospace; 
          font-size: 13px;
          font-weight: 600;
        }
        .math-line { 
          stroke: ${colors.line}; 
          stroke-width: 2.5; 
          stroke-linecap: round;
          stroke-dasharray: none;
          opacity: 0.7;
        }
      </style>
    </defs>
    
    <!-- Decoración de fondo matemático -->
    <text x="50" y="50" fill="#e2e8f0" font-size="80" opacity="0.3">∑</text>
    <text x="${width - 100}" y="${height - 50}" fill="#e2e8f0" font-size="70" opacity="0.3">π</text>
    <text x="${width - 80}" y="80" fill="#e2e8f0" font-size="60" opacity="0.25">∞</text>
    <text x="40" y="${height - 80}" fill="#e2e8f0" font-size="65" opacity="0.25">√</text>
    `;

  if (isHorizontal) {
    // DISEÑO HORIZONTAL PARA MATEMÁTICAS
    const centerX = 200;
    const centerY = height / 2;
    const centralW = 200;
    const centralH = 90;
    const branches = structure.mainBranches;
    
    const branchSpacing = Math.max(130, (height - 150) / branches.length);
    const branchStartY = centerY - ((branches.length - 1) * branchSpacing / 2);
    
    // Líneas de conexión
    branches.forEach((branch, idx) => {
      const branchY = branchStartY + (idx * branchSpacing);
      const branchX = centerX + 340;
      
      svg += `<line x1="${centerX + centralW/2}" y1="${centerY}" 
        x2="${branchX - 90}" y2="${branchY}" class="math-line"/>`;
      
      if (branch.children && branch.children.length > 0) {
        const subStartX = branchX + 240;
        const subSpacing = Math.max(150, 450 / branch.children.length);
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subX = subStartX + (childIdx * subSpacing);
          svg += `<line x1="${branchX + 90}" y1="${branchY}" 
            x2="${subX - 55}" y2="${branchY}" class="math-line"/>`;
        });
      }
    });
    
    // Nodo central con gradiente matemático
    svg += `<rect x="${centerX - centralW/2}" y="${centerY - centralH/2}" 
      width="${centralW}" height="${centralH}" rx="20" 
      fill="url(#mathCentralGradient)" stroke="${mathColorScheme[0]}" stroke-width="3" filter="url(#mathShadow)"/>`;
    
    // Ícono matemático en el centro
    svg += `<text x="${centerX - centralW/2 + 25}" y="${centerY}" fill="white" font-size="24" opacity="0.8">∑</text>`;
    
    const centralLines = intelligentTextWrap(structure.centralThemeLabel, 18);
    const centralStartY = centerY - ((centralLines.length - 1) * 22 / 2);
    centralLines.forEach((line: string, idx: number) => {
      svg += `<text x="${centerX + 10}" y="${centralStartY + (idx * 22)}" class="math-text central-text">${escapeXml(line)}</text>`;
    });
    
    // Ramas y subnodos
    branches.forEach((branch, idx) => {
      const branchY = branchStartY + (idx * branchSpacing);
      const branchX = centerX + 340;
      const branchW = 180;
      const branchH = 65;
      const branchColor = mathColorScheme[idx + 1] || mathColorScheme[1];
      
      svg += `<rect x="${branchX - branchW/2}" y="${branchY - branchH/2}" 
        width="${branchW}" height="${branchH}" rx="15" 
        fill="${branchColor}" stroke="none" filter="url(#mathShadow)"/>`;
      
      const branchLines = intelligentTextWrap(branch.label, 20);
      const branchTextStartY = branchY - ((branchLines.length - 1) * 18 / 2);
      branchLines.forEach((line: string, lineIdx: number) => {
        svg += `<text x="${branchX}" y="${branchTextStartY + (lineIdx * 18)}" class="math-text branch-text">${escapeXml(line)}</text>`;
      });
      
      // Subnodos para fórmulas y ejercicios
      if (branch.children && branch.children.length > 0) {
        const subStartX = branchX + 240;
        const subSpacing = Math.max(150, 450 / branch.children.length);
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subX = subStartX + (childIdx * subSpacing);
          const subRadius = 55;
          const subColor = mathColorScheme[6 + (childIdx % 2)];
          
          svg += `<circle cx="${subX}" cy="${branchY}" r="${subRadius}" 
            fill="${subColor}" stroke="none" filter="url(#mathShadow)"/>`;
          
          const subLines = intelligentTextWrap(child.label, 14);
          const lineHeight = 15;
          const totalTextHeight = (subLines.length - 1) * lineHeight;
          const subTextStartY = branchY - (totalTextHeight / 2);
          subLines.forEach((line: string, lineIdx: number) => {
            const yPosition = subTextStartY + (lineIdx * lineHeight);
            svg += `<text x="${subX}" y="${yPosition}" class="math-text formula-text" fill="white">${escapeXml(line)}</text>`;
          });
        });
      }
    });
    
  } else {
    // DISEÑO VERTICAL PARA MATEMÁTICAS
    const centerX = width / 2;
    const startY = 130;
    const centralR = 90;
    const branches = structure.mainBranches;
    
    const branchY = startY + 280;
    const totalBranchWidth = Math.min(width - 140, branches.length * 220);
    const branchStartX = centerX - (totalBranchWidth / 2);
    const branchSpacing = totalBranchWidth / branches.length;
    
    // Líneas de conexión
    branches.forEach((branch, idx) => {
      const branchX = branchStartX + (idx + 0.5) * branchSpacing;
      
      svg += `<line x1="${centerX}" y1="${startY + centralR}" 
        x2="${branchX}" y2="${branchY - 40}" class="math-line"/>`;
      
      if (branch.children && branch.children.length > 0) {
        const subStartY = branchY + 160;
        const subSpacing = 110;
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subY = subStartY + (childIdx * subSpacing);
          svg += `<line x1="${branchX}" y1="${branchY + 40}" 
            x2="${branchX}" y2="${subY - 55}" class="math-line"/>`;
        });
      }
    });
    
    // Nodo central matemático
    svg += `<circle cx="${centerX}" cy="${startY}" r="${centralR}" 
      fill="url(#mathCentralGradient)" stroke="${mathColorScheme[0]}" stroke-width="4" filter="url(#mathShadow)"/>`;
    
    // Símbolo matemático decorativo
    svg += `<text x="${centerX}" y="${startY - 35}" fill="white" font-size="28" text-anchor="middle" opacity="0.9">∑</text>`;
    
    const centralLines = intelligentTextWrap(structure.centralThemeLabel, 16);
    const centralTextY = startY + 10 - ((centralLines.length - 1) * 22 / 2);
    centralLines.forEach((line: string, idx: number) => {
      svg += `<text x="${centerX}" y="${centralTextY + (idx * 22)}" class="math-text central-text" 
        style="font-size: 19px;">${escapeXml(line)}</text>`;
    });
    
    // Ramas principales
    branches.forEach((branch, idx) => {
      const branchX = branchStartX + (idx + 0.5) * branchSpacing;
      const branchW = 185;
      const branchH = 75;
      const branchColor = mathColorScheme[idx + 1] || mathColorScheme[1];
      
      svg += `<rect x="${branchX - branchW/2}" y="${branchY - branchH/2}" 
        width="${branchW}" height="${branchH}" rx="18" 
        fill="${branchColor}" stroke="none" filter="url(#mathShadow)"/>`;
      
      const branchLines = intelligentTextWrap(branch.label, 20);
      const branchTextY = branchY - ((branchLines.length - 1) * 18 / 2);
      branchLines.forEach((line: string, lineIdx: number) => {
        svg += `<text x="${branchX}" y="${branchTextY + (lineIdx * 18)}" class="math-text branch-text" 
          style="font-size: 15px;">${escapeXml(line)}</text>`;
      });
      
      // Subnodos con fórmulas
      if (branch.children && branch.children.length > 0) {
        const subStartY = branchY + 160;
        const subSpacing = 110;
        
        branch.children.forEach((child: MindMapNode, childIdx: number) => {
          const subY = subStartY + (childIdx * subSpacing);
          const subR = 55;
          const subColor = mathColorScheme[6 + (childIdx % 2)];
          
          svg += `<circle cx="${branchX}" cy="${subY}" r="${subR}" 
            fill="${subColor}" stroke="none" filter="url(#mathShadow)"/>`;
          
          const subLines = intelligentTextWrap(child.label, 14);
          const lineHeight = 15;
          const totalTextHeight = (subLines.length - 1) * lineHeight;
          const subTextY = subY - (totalTextHeight / 2);
          subLines.forEach((line: string, lineIdx: number) => {
            const yPosition = subTextY + (lineIdx * lineHeight);
            svg += `<text x="${branchX}" y="${yPosition}" class="math-text formula-text" 
              fill="white" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`;
          });
        });
      }
    });
  }
  
  svg += '</svg>';
  return svg;
}

/**
 * Escapa caracteres especiales para XML/SVG
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}