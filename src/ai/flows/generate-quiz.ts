
// src/ai/flows/generate-quiz.ts
'use server';

/**
 * @fileOverview Generates a quiz on a specific topic from a selected book.
 * The quiz will have 15 open-ended questions, each with its expected answer/explanation.
 *
 * - generateQuiz - A function that handles the quiz generation process.
 * - GenerateQuizInput - The input type for the generateQuiz function.
 * - GenerateQuizOutput - The return type for the generateQuiz function (formatted HTML string).
 */

import { ai } from '@/ai/genkit';
import { z } from 'genkit';
import { bookPDFs } from '@/lib/books-data';
import { getOpenRouterClient, hasOpenRouterApiKey, OPENROUTER_MODELS } from '@/lib/openrouter-client';
import { getContentGenerationContext, generateAIPromptInstructions } from '@/lib/topic-descriptions';

// Cache para contenido de PDFs (evita descargas repetidas)
const pdfContentCache = new Map<string, { pages: string[]; timestamp: number }>();
const PDF_CACHE_TTL = 30 * 60 * 1000; // 30 minutos
const PDF_FAILURE_TTL = 5 * 60 * 1000; // 5 minutos (para caché negativa)

// Cache para contexto extraído por topic (evita re-procesar)
const contextCache = new Map<string, { context: string; references: string[]; timestamp: number }>();
const CONTEXT_CACHE_TTL = 15 * 60 * 1000; // 15 minutos

// Cache para salida final del quiz (evita llamadas repetidas al modelo)
const quizOutputCache = new Map<string, { output: GenerateQuizOutput; timestamp: number }>();
const QUIZ_OUTPUT_TTL = 10 * 60 * 1000; // 10 minutos

// Deduplicación de requests concurrentes (mismo input)
const quizInFlight = new Map<string, Promise<GenerateQuizOutput>>();

function normalizeForMatch(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function makeQuizCacheKey(input: GenerateQuizInput): string {
  return [
    input.language,
    input.courseName?.trim() || '',
    input.bookTitle?.trim() || '',
    input.topic?.trim().toLowerCase() || '',
  ].join('|');
}

function isLikelyRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests|rate\s*limit|quota/i.test(msg);
}

// =============================================================================
// FUNCIÓN PARA DETECTAR SI ES ASIGNATURA DE MATEMÁTICAS
// =============================================================================
function isMathSubject(bookTitle: string, topic?: string): boolean {
  const lowerTitle = normalizeForMatch(bookTitle);
  const lowerTopic = normalizeForMatch(topic || '');
  
  const mathKeywords = [
    'matematica', 'matematicas', 'math',
    'algebra', 'geometria',
    'calculo', 'aritmetica',
    'trigonometria',
    'suma', 'sumas', 'adicion',
    'resta', 'restas', 'sustraccion',
    'multiplicacion',
    'division',
    'fraccion', 'fracciones',
    'numeros',
    // Raíces / radicales
    'raiz', 'raices', 'raiz cuadrada', 'raices cuadradas', 'radical', 'radicales', 'sqrt',
    // Potencias / exponentes (común en el mismo bloque de contenidos)
    'potencia', 'potencias', 'exponente', 'exponentes'
  ];
  
  for (const keyword of mathKeywords) {
    if (lowerTitle.includes(keyword) || lowerTopic.includes(keyword)) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// FUNCIÓN PARA DETECTAR ASIGNATURAS CON COMPONENTE DE CÁLCULO (FÍSICA, QUÍMICA, BIOLOGÍA)
// =============================================================================
type ScienceSubjectType = 'fisica' | 'quimica' | 'biologia' | null;

function isScienceWithCalculations(bookTitle: string, topic?: string): ScienceSubjectType {
  const lowerTitle = normalizeForMatch(bookTitle);
  const lowerTopic = normalizeForMatch(topic || '');
  const combined = lowerTitle + ' ' + lowerTopic;
  
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
}

// Función para obtener instrucciones específicas de cálculo por asignatura
function getScienceCalculationInstructions(subjectType: ScienceSubjectType, language: 'es' | 'en'): string {
  if (!subjectType) return '';
  
  const instructions: Record<ScienceSubjectType, { es: string; en: string }> = {
    fisica: {
      es: `IMPORTANTE - FÍSICA CON CÁLCULOS:
Esta es una asignatura de FÍSICA que requiere tanto TEORÍA como PROBLEMAS CON CÁLCULOS.
Incluye problemas que requieran:
- Aplicar fórmulas (v = d/t, F = m×a, E = m×c², P = W/t, etc.)
- Calcular magnitudes físicas (velocidad, aceleración, fuerza, energía, trabajo, potencia)
- Resolver problemas de cinemática y dinámica
- Conversión de unidades (m/s a km/h, Joules a calorías, etc.)
- Análisis de gráficos de movimiento
Los problemas deben mostrar el desarrollo paso a paso con las fórmulas aplicadas.`,
      en: `IMPORTANT - PHYSICS WITH CALCULATIONS:
This is a PHYSICS subject that requires both THEORY and CALCULATION PROBLEMS.
Include problems that require:
- Applying formulas (v = d/t, F = m×a, E = m×c², P = W/t, etc.)
- Calculating physical magnitudes (velocity, acceleration, force, energy, work, power)
- Solving kinematics and dynamics problems
- Unit conversion (m/s to km/h, Joules to calories, etc.)
- Motion graph analysis
Problems must show step-by-step development with applied formulas.`
    },
    quimica: {
      es: `IMPORTANTE - QUÍMICA CON CÁLCULOS:
Esta es una asignatura de QUÍMICA que requiere tanto TEORÍA como PROBLEMAS CON CÁLCULOS.
Incluye problemas que requieran:
- Cálculos estequiométricos (moles, masa molar, reactivo limitante)
- Balanceo de ecuaciones químicas
- Cálculos de concentración (molaridad, % masa/volumen)
- Cálculos de pH y pOH
- Problemas de diluciones
- Cálculos de rendimiento de reacciones
Los problemas deben mostrar el desarrollo paso a paso con las fórmulas aplicadas.`,
      en: `IMPORTANT - CHEMISTRY WITH CALCULATIONS:
This is a CHEMISTRY subject that requires both THEORY and CALCULATION PROBLEMS.
Include problems that require:
- Stoichiometric calculations (moles, molar mass, limiting reagent)
- Balancing chemical equations
- Concentration calculations (molarity, % mass/volume)
- pH and pOH calculations
- Dilution problems
- Reaction yield calculations
Problems must show step-by-step development with applied formulas.`
    },
    biologia: {
      es: `IMPORTANTE - BIOLOGÍA CON CÁLCULOS:
Esta es una asignatura de BIOLOGÍA que incluye TEORÍA y algunos PROBLEMAS CON CÁLCULOS.
Incluye problemas que requieran:
- Cálculos de probabilidad genética (cruces monohíbridos, dihíbridos, cuadros de Punnett)
- Proporciones fenotípicas y genotípicas
- Cálculos de frecuencias alélicas en poblaciones
- Problemas de cadenas tróficas y transferencia de energía
- Cálculos de tasas de crecimiento poblacional
Combina preguntas teóricas con problemas de aplicación matemática.`,
      en: `IMPORTANT - BIOLOGY WITH CALCULATIONS:
This is a BIOLOGY subject that includes THEORY and some CALCULATION PROBLEMS.
Include problems that require:
- Genetic probability calculations (monohybrid, dihybrid crosses, Punnett squares)
- Phenotypic and genotypic ratios
- Allele frequency calculations in populations
- Food chain and energy transfer problems
- Population growth rate calculations
Combine theoretical questions with mathematical application problems.`
    }
  };
  
  return instructions[subjectType]?.[language] || '';
}

// =============================================================================
// BANCO DE PROBLEMAS MATEMÁTICOS CON DESARROLLO PARA 1RO BÁSICO
// =============================================================================
const mathProblemBanks: Record<string, Array<{ q: string; a: string }>> = {
  // =====================================================================
  // RAÍCES CUADRADAS / RADICALES
  // =====================================================================
  'raices cuadradas': [
    {
      q: '√️⃣ Problema 1: ¿Cuál es la raíz cuadrada de 49?',
      a: `📝 DESARROLLO:
• Buscamos un número que multiplicado por sí mismo dé 49
• 7 × 7 = 49
• Entonces √49 = 7

✅ RESPUESTA: √49 = 7

🔍 VERIFICACIÓN: 7² = 7 × 7 = 49 ✓`
    },
    {
      q: '√️⃣ Problema 2: ¿Cuál es la raíz cuadrada de 64?',
      a: `📝 DESARROLLO:
• Buscamos un número que al cuadrado sea 64
• 8 × 8 = 64
• Entonces √64 = 8

✅ RESPUESTA: √64 = 8

🔍 VERIFICACIÓN: 8² = 64 ✓`
    },
    {
      q: '√️⃣ Problema 3: ¿Cuál es la raíz cuadrada de 81?',
      a: `📝 DESARROLLO:
• Buscamos el número cuyo cuadrado es 81
• 9 × 9 = 81
• Entonces √81 = 9

✅ RESPUESTA: √81 = 9

🔍 VERIFICACIÓN: 9² = 81 ✓`
    },
    {
      q: '√️⃣ Problema 4: Completa: √__ = 6. ¿Qué número va en el espacio?',
      a: `📝 DESARROLLO:
• Si √__ = 6, entonces el número debe ser 6²
• 6² = 6 × 6 = 36
• Por lo tanto, √36 = 6

✅ RESPUESTA: El número es 36

🔍 VERIFICACIÓN: √36 = 6 ✓`
    },
    {
      q: '√️⃣ Problema 5: Completa: √__ = 10. ¿Qué número va en el espacio?',
      a: `📝 DESARROLLO:
• Si √__ = 10, entonces el número debe ser 10²
• 10² = 10 × 10 = 100
• Por lo tanto, √100 = 10

✅ RESPUESTA: El número es 100

🔍 VERIFICACIÓN: √100 = 10 ✓`
    },
    {
      q: '√️⃣ Problema 6: ¿Cuál es la raíz cuadrada de 25?',
      a: `📝 DESARROLLO:
• 25 es un cuadrado perfecto
• 5 × 5 = 25
• Entonces √25 = 5

✅ RESPUESTA: √25 = 5

🔍 VERIFICACIÓN: 5² = 25 ✓`
    },
    {
      q: '√️⃣ Problema 7: ¿Cuál es la raíz cuadrada de 16?',
      a: `📝 DESARROLLO:
• 4 × 4 = 16
• Entonces √16 = 4

✅ RESPUESTA: √16 = 4

🔍 VERIFICACIÓN: 4² = 16 ✓`
    },
    {
      q: '√️⃣ Problema 8: ¿Cuál es la raíz cuadrada de 9?',
      a: `📝 DESARROLLO:
• 3 × 3 = 9
• Entonces √9 = 3

✅ RESPUESTA: √9 = 3

🔍 VERIFICACIÓN: 3² = 9 ✓`
    },
    {
      q: '√️⃣ Problema 9: ¿Cuál es la raíz cuadrada de 1?',
      a: `📝 DESARROLLO:
• 1 × 1 = 1
• Entonces √1 = 1

✅ RESPUESTA: √1 = 1

🔍 VERIFICACIÓN: 1² = 1 ✓`
    },
    {
      q: '√️⃣ Problema 10: ¿Cuál es la raíz cuadrada de 0?',
      a: `📝 DESARROLLO:
• 0 × 0 = 0
• Entonces √0 = 0

✅ RESPUESTA: √0 = 0

🔍 VERIFICACIÓN: 0² = 0 ✓`
    },
    {
      q: '√️⃣ Problema 11: Calcula: √36 + √9',
      a: `📝 DESARROLLO:
• √36 = 6 (porque 6×6=36)
• √9 = 3 (porque 3×3=9)
• Sumamos: 6 + 3 = 9

✅ RESPUESTA: √36 + √9 = 9

🔍 VERIFICACIÓN: √36=6 y √9=3, entonces 6+3=9 ✓`
    },
    {
      q: '√️⃣ Problema 12: Ordena de menor a mayor: √25, √36, √49',
      a: `📝 DESARROLLO:
• √25 = 5
• √36 = 6
• √49 = 7
• Orden: 5 < 6 < 7

✅ RESPUESTA: √25 < √36 < √49

🔍 VERIFICACIÓN: 5 < 6 < 7 ✓`
    },
    {
      q: '√️⃣ Problema 13: Un cuadrado tiene área 64 cm². ¿Cuánto mide un lado?',
      a: `📝 DESARROLLO:
• Fórmula: área del cuadrado = lado × lado = lado²
• Si el área es 64, entonces lado² = 64
• Lado = √64
• √64 = 8

✅ RESPUESTA: El lado mide 8 cm

🔍 VERIFICACIÓN: 8 × 8 = 64 cm² ✓`
    },
    {
      q: '√️⃣ Problema 14: ¿Cuál de estos números es un cuadrado perfecto: 20, 36, 50? Explica.',
      a: `📝 DESARROLLO:
• Un cuadrado perfecto es un número que puede escribirse como n×n
• 36 = 6×6
• 20 y 50 no son cuadrados perfectos (no existe un número entero n con n×n=20 o n×n=50)

✅ RESPUESTA: 36 es un cuadrado perfecto

🔍 VERIFICACIÓN: √36 = 6 (entero) ✓`
    },
    {
      q: '√️⃣ Problema 15: Verdadero o falso: √81 = 8. Corrige si es falso.',
      a: `📝 DESARROLLO:
• Probamos: 8 × 8 = 64 (no es 81)
• Probamos con 9: 9 × 9 = 81
• Entonces √81 = 9

✅ RESPUESTA: Falso. √81 = 9

🔍 VERIFICACIÓN: 9² = 81 ✓`
    }
  ],
  'raiz cuadrada': [],
  'raices': [],
  'raiz': [],
  'radicales': [],
  'radical': [],
  'sumas': [
    { 
      q: '🍎 María tiene 3 manzanas y su mamá le regala 2 más. ¿Cuántas manzanas tiene ahora?', 
      a: `📝 DESARROLLO:
• Datos: María tiene 3 manzanas, le dan 2 más
• Operación: SUMA (porque le dan más)
• Cálculo: 3 + 2 = 5

✅ RESPUESTA: María tiene 5 manzanas.

💡 TRUCO: Puedes usar los dedos: levanta 3 dedos, luego 2 más, y cuenta todos.` 
    },
    { 
      q: '🐕 En el parque hay 4 perros. Llegan 3 perros más. ¿Cuántos perros hay en total?', 
      a: `📝 DESARROLLO:
• Datos: Hay 4 perros, llegan 3 más
• Operación: SUMA (porque llegan más)
• Cálculo: 4 + 3 = 7

✅ RESPUESTA: Hay 7 perros en el parque.

💡 TRUCO: Cuenta desde el número mayor (4) y suma de uno en uno: 5, 6, 7.` 
    },
    { 
      q: '✏️ Pedro tiene 5 lápices azules y 4 lápices rojos. ¿Cuántos lápices tiene en total?', 
      a: `📝 DESARROLLO:
• Datos: 5 lápices azules + 4 lápices rojos
• Operación: SUMA (queremos el total)
• Cálculo: 5 + 4 = 9

✅ RESPUESTA: Pedro tiene 9 lápices en total.

💡 TRUCO: 5 + 4 es un "amigo del 9". Recuerda: 5 + 5 = 10, entonces 5 + 4 = 9.` 
    },
    { 
      q: '⭐ Sofía dibuja 6 estrellas. Luego dibuja 2 estrellas más. ¿Cuántas estrellas dibujó?', 
      a: `📝 DESARROLLO:
• Datos: Dibuja 6 estrellas, luego 2 más
• Operación: SUMA (dibuja más)
• Cálculo: 6 + 2 = 8

✅ RESPUESTA: Sofía dibujó 8 estrellas.

💡 TRUCO: Sumar 2 es como contar dos números más: 6 → 7 → 8.` 
    },
    { 
      q: '🍪 Hay 7 galletas en un plato y 3 en otro. ¿Cuántas galletas hay en total?', 
      a: `📝 DESARROLLO:
• Datos: 7 galletas + 3 galletas
• Operación: SUMA (queremos juntar todo)
• Cálculo: 7 + 3 = 10

✅ RESPUESTA: Hay 10 galletas en total.

💡 TRUCO: 7 + 3 = 10. ¡Son "amigos del 10"! Memoriza estas parejas: 7+3, 8+2, 6+4, 9+1, 5+5.` 
    },
    { 
      q: '🎈 Carlitos tiene 2 globos rojos y 5 globos azules. ¿Cuántos globos tiene?', 
      a: `📝 DESARROLLO:
• Datos: 2 globos rojos + 5 globos azules
• Operación: SUMA
• Cálculo: 2 + 5 = 7

✅ RESPUESTA: Carlitos tiene 7 globos.

💡 TRUCO: El orden no importa: 2 + 5 = 5 + 2 = 7. ¡Siempre da lo mismo!` 
    },
    { 
      q: '📚 Ana tiene 4 libros. Su abuela le regala 4 libros más. ¿Cuántos libros tiene ahora?', 
      a: `📝 DESARROLLO:
• Datos: 4 libros + 4 libros más
• Operación: SUMA (le regalan)
• Cálculo: 4 + 4 = 8

✅ RESPUESTA: Ana tiene 8 libros.

💡 TRUCO: 4 + 4 es un "doble". Los dobles son fáciles: 1+1=2, 2+2=4, 3+3=6, 4+4=8, 5+5=10.` 
    },
    { 
      q: '🐱 En una casa hay 1 gato negro y 6 gatos blancos. ¿Cuántos gatos hay?', 
      a: `📝 DESARROLLO:
• Datos: 1 gato + 6 gatos
• Operación: SUMA
• Cálculo: 1 + 6 = 7

✅ RESPUESTA: Hay 7 gatos en la casa.

💡 TRUCO: Sumar 1 es fácil: solo avanza un número. 6 + 1 = 7.` 
    },
    { 
      q: '🌺 En el jardín hay 5 flores rojas y 5 flores amarillas. ¿Cuántas flores hay?', 
      a: `📝 DESARROLLO:
• Datos: 5 flores + 5 flores
• Operación: SUMA
• Cálculo: 5 + 5 = 10

✅ RESPUESTA: Hay 10 flores en el jardín.

💡 TRUCO: 5 + 5 = 10. ¡Es el doble de 5! Usa tus dos manos: 5 dedos + 5 dedos = 10.` 
    },
    { 
      q: '🚗 En el estacionamiento hay 8 autos. Llegan 2 autos más. ¿Cuántos autos hay ahora?', 
      a: `📝 DESARROLLO:
• Datos: 8 autos + 2 autos más
• Operación: SUMA (llegan más)
• Cálculo: 8 + 2 = 10

✅ RESPUESTA: Hay 10 autos en el estacionamiento.

💡 TRUCO: 8 + 2 = 10. ¡Amigos del 10! Recuerda esta pareja.` 
    },
    { 
      q: '🍭 Tomás compra 3 dulces y su hermano le da 3 más. ¿Cuántos dulces tiene?', 
      a: `📝 DESARROLLO:
• Datos: 3 dulces + 3 dulces
• Operación: SUMA
• Cálculo: 3 + 3 = 6

✅ RESPUESTA: Tomás tiene 6 dulces.

💡 TRUCO: 3 + 3 es un doble. Los dobles son fáciles de recordar.` 
    },
    { 
      q: '🐦 En un árbol hay 6 pájaros. Llegan 4 pájaros más. ¿Cuántos pájaros hay?', 
      a: `📝 DESARROLLO:
• Datos: 6 pájaros + 4 pájaros
• Operación: SUMA
• Cálculo: 6 + 4 = 10

✅ RESPUESTA: Hay 10 pájaros en el árbol.

💡 TRUCO: 6 + 4 = 10. ¡Otra pareja de amigos del 10!` 
    },
    { 
      q: '🎂 En la fiesta hay 5 niños. Llegan 3 niños más. ¿Cuántos niños hay en la fiesta?', 
      a: `📝 DESARROLLO:
• Datos: 5 niños + 3 niños más
• Operación: SUMA
• Cálculo: 5 + 3 = 8

✅ RESPUESTA: Hay 8 niños en la fiesta.

💡 TRUCO: Cuenta desde 5: seis, siete, ocho. ¡Tres saltos!` 
    },
    { 
      q: '🖍️ Lucía tiene 2 crayones y encuentra 7 más. ¿Cuántos crayones tiene ahora?', 
      a: `📝 DESARROLLO:
• Datos: 2 crayones + 7 crayones
• Operación: SUMA (encuentra más)
• Cálculo: 2 + 7 = 9

✅ RESPUESTA: Lucía tiene 9 crayones.

💡 TRUCO: Cambia el orden si es más fácil: 7 + 2 = 9. ¡El resultado es el mismo!` 
    },
    { 
      q: '🐸 En la laguna hay 9 ranas. Llega 1 rana más. ¿Cuántas ranas hay ahora?', 
      a: `📝 DESARROLLO:
• Datos: 9 ranas + 1 rana
• Operación: SUMA
• Cálculo: 9 + 1 = 10

✅ RESPUESTA: Hay 10 ranas en la laguna.

💡 TRUCO: 9 + 1 = 10. ¡Sumar 1 siempre te da el siguiente número!` 
    }
  ],
  'suma': [
    { 
      q: '🍎 María tiene 3 manzanas y su mamá le regala 2 más. ¿Cuántas manzanas tiene ahora?', 
      a: `📝 DESARROLLO:
• Datos: María tiene 3 manzanas, le dan 2 más
• Operación: SUMA (porque le dan más)
• Cálculo: 3 + 2 = 5

✅ RESPUESTA: María tiene 5 manzanas.

💡 TRUCO: Puedes usar los dedos: levanta 3 dedos, luego 2 más, y cuenta todos.` 
    },
    { 
      q: '🐕 En el parque hay 4 perros. Llegan 3 perros más. ¿Cuántos perros hay en total?', 
      a: `📝 DESARROLLO:
• Datos: Hay 4 perros, llegan 3 más
• Operación: SUMA (porque llegan más)
• Cálculo: 4 + 3 = 7

✅ RESPUESTA: Hay 7 perros en el parque.

💡 TRUCO: Cuenta desde el número mayor (4) y suma de uno en uno: 5, 6, 7.` 
    },
    { 
      q: '✏️ Pedro tiene 5 lápices azules y 4 lápices rojos. ¿Cuántos lápices tiene en total?', 
      a: `📝 DESARROLLO:
• Datos: 5 lápices azules + 4 lápices rojos
• Operación: SUMA (queremos el total)
• Cálculo: 5 + 4 = 9

✅ RESPUESTA: Pedro tiene 9 lápices en total.

💡 TRUCO: 5 + 4 es un "casi doble". Piensa: 5 + 5 = 10, entonces 5 + 4 = 9.` 
    },
    { 
      q: '🍪 Hay 7 galletas en un plato y 3 en otro. ¿Cuántas galletas hay en total?', 
      a: `📝 DESARROLLO:
• Datos: 7 galletas + 3 galletas
• Operación: SUMA (queremos juntar todo)
• Cálculo: 7 + 3 = 10

✅ RESPUESTA: Hay 10 galletas en total.

💡 TRUCO: 7 + 3 = 10. ¡Son "amigos del 10"!` 
    },
    { 
      q: '🐱 En una casa hay 1 gato negro y 6 gatos blancos. ¿Cuántos gatos hay?', 
      a: `📝 DESARROLLO:
• Datos: 1 gato + 6 gatos
• Operación: SUMA
• Cálculo: 1 + 6 = 7

✅ RESPUESTA: Hay 7 gatos en la casa.

💡 TRUCO: Sumar 1 es el número que sigue: 6 + 1 = 7.` 
    },
    { 
      q: '🌺 En el jardín hay 5 flores rojas y 5 flores amarillas. ¿Cuántas flores hay?', 
      a: `📝 DESARROLLO:
• Datos: 5 flores + 5 flores
• Operación: SUMA
• Cálculo: 5 + 5 = 10

✅ RESPUESTA: Hay 10 flores en el jardín.

💡 TRUCO: 5 + 5 = 10. ¡Usa tus dos manos: 5 dedos + 5 dedos = 10 dedos!` 
    },
    { 
      q: '🚗 En el estacionamiento hay 8 autos. Llegan 2 autos más. ¿Cuántos autos hay ahora?', 
      a: `📝 DESARROLLO:
• Datos: 8 autos + 2 autos más
• Operación: SUMA (llegan más)
• Cálculo: 8 + 2 = 10

✅ RESPUESTA: Hay 10 autos en el estacionamiento.

💡 TRUCO: 8 + 2 = 10. ¡Amigos del 10!` 
    },
    { 
      q: '📚 Ana tiene 4 libros. Su abuela le regala 4 libros más. ¿Cuántos libros tiene ahora?', 
      a: `📝 DESARROLLO:
• Datos: 4 libros + 4 libros más
• Operación: SUMA (le regalan)
• Cálculo: 4 + 4 = 8

✅ RESPUESTA: Ana tiene 8 libros.

💡 TRUCO: 4 + 4 es un "doble". Los dobles: 2+2=4, 3+3=6, 4+4=8, 5+5=10.` 
    },
    { 
      q: '🎈 Carlitos tiene 2 globos rojos y 5 globos azules. ¿Cuántos globos tiene?', 
      a: `📝 DESARROLLO:
• Datos: 2 globos rojos + 5 globos azules
• Operación: SUMA
• Cálculo: 2 + 5 = 7

✅ RESPUESTA: Carlitos tiene 7 globos.

💡 TRUCO: Puedes cambiar el orden: 5 + 2 = 7. ¡Da lo mismo!` 
    },
    { 
      q: '⭐ Sofía dibuja 6 estrellas. Luego dibuja 2 estrellas más. ¿Cuántas estrellas dibujó?', 
      a: `📝 DESARROLLO:
• Datos: Dibuja 6 estrellas, luego 2 más
• Operación: SUMA (dibuja más)
• Cálculo: 6 + 2 = 8

✅ RESPUESTA: Sofía dibujó 8 estrellas.

💡 TRUCO: Sumar 2 = contar dos más: 6 → 7 → 8.` 
    },
    { 
      q: '🍭 Tomás compra 3 dulces y su hermano le da 3 más. ¿Cuántos dulces tiene?', 
      a: `📝 DESARROLLO:
• Datos: 3 dulces + 3 dulces
• Operación: SUMA
• Cálculo: 3 + 3 = 6

✅ RESPUESTA: Tomás tiene 6 dulces.

💡 TRUCO: 3 + 3 es un doble. ¡Fácil de recordar!` 
    },
    { 
      q: '🐦 En un árbol hay 6 pájaros. Llegan 4 pájaros más. ¿Cuántos pájaros hay?', 
      a: `📝 DESARROLLO:
• Datos: 6 pájaros + 4 pájaros
• Operación: SUMA
• Cálculo: 6 + 4 = 10

✅ RESPUESTA: Hay 10 pájaros en el árbol.

💡 TRUCO: 6 + 4 = 10. ¡Amigos del 10!` 
    },
    { 
      q: '🎂 En la fiesta hay 5 niños. Llegan 3 niños más. ¿Cuántos niños hay en la fiesta?', 
      a: `📝 DESARROLLO:
• Datos: 5 niños + 3 niños más
• Operación: SUMA
• Cálculo: 5 + 3 = 8

✅ RESPUESTA: Hay 8 niños en la fiesta.

💡 TRUCO: Desde 5 cuenta 3: seis, siete, ocho.` 
    },
    { 
      q: '🖍️ Lucía tiene 2 crayones y encuentra 7 más. ¿Cuántos crayones tiene ahora?', 
      a: `📝 DESARROLLO:
• Datos: 2 crayones + 7 crayones
• Operación: SUMA (encuentra más)
• Cálculo: 2 + 7 = 9

✅ RESPUESTA: Lucía tiene 9 crayones.

💡 TRUCO: Cambia el orden: 7 + 2 = 9. ¡El resultado es igual!` 
    },
    { 
      q: '🐸 En la laguna hay 9 ranas. Llega 1 rana más. ¿Cuántas ranas hay ahora?', 
      a: `📝 DESARROLLO:
• Datos: 9 ranas + 1 rana
• Operación: SUMA
• Cálculo: 9 + 1 = 10

✅ RESPUESTA: Hay 10 ranas en la laguna.

💡 TRUCO: 9 + 1 = 10. ¡Sumar 1 te da el número siguiente!` 
    }
  ],
  'restas': [
    { 
      q: '🍎 Juan tiene 8 manzanas y come 3. ¿Cuántas manzanas le quedan?', 
      a: `📝 DESARROLLO:
• Datos: Juan tiene 8 manzanas, come 3
• Operación: RESTA (porque come/quita)
• Cálculo: 8 - 3 = 5

✅ RESPUESTA: A Juan le quedan 5 manzanas.

💡 TRUCO: Cuenta hacia atrás desde 8: siete, seis, cinco. ¡3 saltos atrás!` 
    },
    { 
      q: '🐕 En el parque hay 7 perros. Se van 2 perros. ¿Cuántos perros quedan?', 
      a: `📝 DESARROLLO:
• Datos: Hay 7 perros, se van 2
• Operación: RESTA (porque se van)
• Cálculo: 7 - 2 = 5

✅ RESPUESTA: Quedan 5 perros en el parque.

💡 TRUCO: Restar 2 es contar 2 hacia atrás: 7 → 6 → 5.` 
    },
    { 
      q: '✏️ María tiene 10 lápices y pierde 4. ¿Cuántos lápices le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 lápices, pierde 4
• Operación: RESTA (porque pierde)
• Cálculo: 10 - 4 = 6

✅ RESPUESTA: A María le quedan 6 lápices.

💡 TRUCO: 10 - 4 = 6. Recuerda: 4 + 6 = 10, así que 10 - 4 = 6.` 
    },
    { 
      q: '🍪 Hay 9 galletas en la mesa. Los niños comen 5. ¿Cuántas galletas quedan?', 
      a: `📝 DESARROLLO:
• Datos: 9 galletas, comen 5
• Operación: RESTA (porque comen)
• Cálculo: 9 - 5 = 4

✅ RESPUESTA: Quedan 4 galletas en la mesa.

💡 TRUCO: 9 - 5 = 4. Piensa: 5 + 4 = 9.` 
    },
    { 
      q: '🎈 Carlos tiene 6 globos y se le revientan 2. ¿Cuántos globos le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 6 globos, se revientan 2
• Operación: RESTA (porque se revientan)
• Cálculo: 6 - 2 = 4

✅ RESPUESTA: A Carlos le quedan 4 globos.

💡 TRUCO: 6 - 2 = 4. Cuenta 2 hacia atrás: 6 → 5 → 4.` 
    },
    { 
      q: '📚 Ana tiene 10 libros y regala 3. ¿Cuántos libros le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 libros, regala 3
• Operación: RESTA (porque regala)
• Cálculo: 10 - 3 = 7

✅ RESPUESTA: A Ana le quedan 7 libros.

💡 TRUCO: 10 - 3 = 7. Recuerda: 3 + 7 = 10.` 
    },
    { 
      q: '🐱 Hay 5 gatos jugando. Se van 1 gato. ¿Cuántos gatos quedan?', 
      a: `📝 DESARROLLO:
• Datos: 5 gatos, se va 1
• Operación: RESTA (porque se va)
• Cálculo: 5 - 1 = 4

✅ RESPUESTA: Quedan 4 gatos jugando.

💡 TRUCO: Restar 1 es el número anterior: 5 - 1 = 4.` 
    },
    { 
      q: '🌺 En el jardín hay 8 flores. Se marchitan 3 flores. ¿Cuántas flores quedan?', 
      a: `📝 DESARROLLO:
• Datos: 8 flores, se marchitan 3
• Operación: RESTA (porque se marchitan)
• Cálculo: 8 - 3 = 5

✅ RESPUESTA: Quedan 5 flores en el jardín.

💡 TRUCO: 8 - 3 = 5. Cuenta atrás: 8 → 7 → 6 → 5.` 
    },
    { 
      q: '🚗 Hay 10 autos. Salen 5 autos. ¿Cuántos autos quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 autos, salen 5
• Operación: RESTA (porque salen)
• Cálculo: 10 - 5 = 5

✅ RESPUESTA: Quedan 5 autos.

💡 TRUCO: 10 - 5 = 5. ¡La mitad de 10 es 5!` 
    },
    { 
      q: '🍭 Sofía tiene 7 dulces y da 4 a su amigo. ¿Cuántos dulces le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 7 dulces, da 4
• Operación: RESTA (porque da)
• Cálculo: 7 - 4 = 3

✅ RESPUESTA: A Sofía le quedan 3 dulces.

💡 TRUCO: 7 - 4 = 3. Piensa: 4 + 3 = 7.` 
    },
    { 
      q: '🐦 En el árbol hay 9 pájaros. Vuelan 6 pájaros. ¿Cuántos pájaros quedan?', 
      a: `📝 DESARROLLO:
• Datos: 9 pájaros, vuelan 6
• Operación: RESTA (porque vuelan)
• Cálculo: 9 - 6 = 3

✅ RESPUESTA: Quedan 3 pájaros en el árbol.

💡 TRUCO: 9 - 6 = 3. Recuerda: 6 + 3 = 9.` 
    },
    { 
      q: '🎂 Hay 10 velas en el pastel. Soplan 10 velas. ¿Cuántas velas quedan encendidas?', 
      a: `📝 DESARROLLO:
• Datos: 10 velas, soplan 10
• Operación: RESTA (porque apagan)
• Cálculo: 10 - 10 = 0

✅ RESPUESTA: Quedan 0 velas encendidas (ninguna).

💡 TRUCO: Cuando restas un número a sí mismo, siempre da 0.` 
    },
    { 
      q: '⭐ Pedro tiene 6 estrellas doradas. Pierde 0 estrellas. ¿Cuántas estrellas tiene?', 
      a: `📝 DESARROLLO:
• Datos: 6 estrellas, pierde 0
• Operación: RESTA (pero resta cero)
• Cálculo: 6 - 0 = 6

✅ RESPUESTA: Pedro tiene 6 estrellas.

💡 TRUCO: Restar 0 no cambia el número: 6 - 0 = 6.` 
    },
    { 
      q: '🖍️ Lucía tiene 8 crayones y presta 5 a su hermano. ¿Cuántos crayones le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 8 crayones, presta 5
• Operación: RESTA (porque presta)
• Cálculo: 8 - 5 = 3

✅ RESPUESTA: A Lucía le quedan 3 crayones.

💡 TRUCO: 8 - 5 = 3. Piensa: 5 + 3 = 8.` 
    },
    { 
      q: '🐸 Hay 10 ranas en la laguna. Saltan fuera 7 ranas. ¿Cuántas ranas quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 ranas, saltan 7
• Operación: RESTA (porque se van)
• Cálculo: 10 - 7 = 3

✅ RESPUESTA: Quedan 3 ranas en la laguna.

💡 TRUCO: 10 - 7 = 3. Recuerda: 7 + 3 = 10.` 
    }
  ],
  'resta': [
    { 
      q: '🍎 Juan tiene 8 manzanas y come 3. ¿Cuántas manzanas le quedan?', 
      a: `📝 DESARROLLO:
• Datos: Juan tiene 8 manzanas, come 3
• Operación: RESTA (porque come/quita)
• Cálculo: 8 - 3 = 5

✅ RESPUESTA: A Juan le quedan 5 manzanas.

💡 TRUCO: Cuenta hacia atrás desde 8: siete, seis, cinco.` 
    },
    { 
      q: '🐕 En el parque hay 7 perros. Se van 2 perros. ¿Cuántos perros quedan?', 
      a: `📝 DESARROLLO:
• Datos: Hay 7 perros, se van 2
• Operación: RESTA (porque se van)
• Cálculo: 7 - 2 = 5

✅ RESPUESTA: Quedan 5 perros en el parque.

💡 TRUCO: 7 - 2 = 5. Dos saltos atrás: 7 → 6 → 5.` 
    },
    { 
      q: '✏️ María tiene 10 lápices y pierde 4. ¿Cuántos lápices le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 lápices, pierde 4
• Operación: RESTA (porque pierde)
• Cálculo: 10 - 4 = 6

✅ RESPUESTA: A María le quedan 6 lápices.

💡 TRUCO: 4 + 6 = 10, entonces 10 - 4 = 6.` 
    },
    { 
      q: '🍪 Hay 9 galletas en la mesa. Los niños comen 5. ¿Cuántas galletas quedan?', 
      a: `📝 DESARROLLO:
• Datos: 9 galletas, comen 5
• Operación: RESTA (porque comen)
• Cálculo: 9 - 5 = 4

✅ RESPUESTA: Quedan 4 galletas en la mesa.

💡 TRUCO: 5 + 4 = 9, entonces 9 - 5 = 4.` 
    },
    { 
      q: '🎈 Carlos tiene 6 globos y se le revientan 2. ¿Cuántos globos le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 6 globos, se revientan 2
• Operación: RESTA
• Cálculo: 6 - 2 = 4

✅ RESPUESTA: A Carlos le quedan 4 globos.

💡 TRUCO: 6 - 2 = 4. Cuenta atrás: 6 → 5 → 4.` 
    },
    { 
      q: '📚 Ana tiene 10 libros y regala 3. ¿Cuántos libros le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 libros, regala 3
• Operación: RESTA (porque regala)
• Cálculo: 10 - 3 = 7

✅ RESPUESTA: A Ana le quedan 7 libros.

💡 TRUCO: 3 + 7 = 10, entonces 10 - 3 = 7.` 
    },
    { 
      q: '🐱 Hay 5 gatos jugando. Se va 1 gato. ¿Cuántos gatos quedan?', 
      a: `📝 DESARROLLO:
• Datos: 5 gatos, se va 1
• Operación: RESTA
• Cálculo: 5 - 1 = 4

✅ RESPUESTA: Quedan 4 gatos jugando.

💡 TRUCO: Restar 1 = el número anterior.` 
    },
    { 
      q: '🌺 En el jardín hay 8 flores. Se marchitan 3 flores. ¿Cuántas flores quedan?', 
      a: `📝 DESARROLLO:
• Datos: 8 flores, se marchitan 3
• Operación: RESTA
• Cálculo: 8 - 3 = 5

✅ RESPUESTA: Quedan 5 flores en el jardín.

💡 TRUCO: Cuenta atrás: 8 → 7 → 6 → 5.` 
    },
    { 
      q: '🚗 Hay 10 autos. Salen 5 autos. ¿Cuántos autos quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 autos, salen 5
• Operación: RESTA
• Cálculo: 10 - 5 = 5

✅ RESPUESTA: Quedan 5 autos.

💡 TRUCO: 10 - 5 = 5. ¡La mitad de 10!` 
    },
    { 
      q: '🍭 Sofía tiene 7 dulces y da 4 a su amigo. ¿Cuántos dulces le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 7 dulces, da 4
• Operación: RESTA
• Cálculo: 7 - 4 = 3

✅ RESPUESTA: A Sofía le quedan 3 dulces.

💡 TRUCO: 4 + 3 = 7, entonces 7 - 4 = 3.` 
    },
    { 
      q: '🐦 En el árbol hay 9 pájaros. Vuelan 6 pájaros. ¿Cuántos pájaros quedan?', 
      a: `📝 DESARROLLO:
• Datos: 9 pájaros, vuelan 6
• Operación: RESTA
• Cálculo: 9 - 6 = 3

✅ RESPUESTA: Quedan 3 pájaros en el árbol.

💡 TRUCO: 6 + 3 = 9, entonces 9 - 6 = 3.` 
    },
    { 
      q: '🎂 Hay 10 velas en el pastel. Soplan 10 velas. ¿Cuántas quedan encendidas?', 
      a: `📝 DESARROLLO:
• Datos: 10 velas, soplan 10
• Operación: RESTA
• Cálculo: 10 - 10 = 0

✅ RESPUESTA: Quedan 0 velas encendidas.

💡 TRUCO: Un número menos sí mismo = 0.` 
    },
    { 
      q: '⭐ Pedro tiene 6 estrellas. Pierde 0 estrellas. ¿Cuántas tiene?', 
      a: `📝 DESARROLLO:
• Datos: 6 estrellas, pierde 0
• Operación: RESTA
• Cálculo: 6 - 0 = 6

✅ RESPUESTA: Pedro tiene 6 estrellas.

💡 TRUCO: Restar 0 no cambia el número.` 
    },
    { 
      q: '🖍️ Lucía tiene 8 crayones y presta 5. ¿Cuántos le quedan?', 
      a: `📝 DESARROLLO:
• Datos: 8 crayones, presta 5
• Operación: RESTA
• Cálculo: 8 - 5 = 3

✅ RESPUESTA: A Lucía le quedan 3 crayones.

💡 TRUCO: 5 + 3 = 8, entonces 8 - 5 = 3.` 
    },
    { 
      q: '🐸 Hay 10 ranas. Saltan fuera 7 ranas. ¿Cuántas quedan?', 
      a: `📝 DESARROLLO:
• Datos: 10 ranas, saltan 7
• Operación: RESTA
• Cálculo: 10 - 7 = 3

✅ RESPUESTA: Quedan 3 ranas en la laguna.

💡 TRUCO: 7 + 3 = 10, entonces 10 - 7 = 3.` 
    }
  ],
  'números': [
    { 
      q: '🔢 ¿Qué número viene después del 5?', 
      a: `📝 DESARROLLO:
• Contamos: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
• Después del 5 viene el 6

✅ RESPUESTA: El número 6 viene después del 5.

💡 TRUCO: El número que sigue es como sumar 1: 5 + 1 = 6.` 
    },
    { 
      q: '🔢 ¿Qué número viene antes del 8?', 
      a: `📝 DESARROLLO:
• Contamos: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
• Antes del 8 viene el 7

✅ RESPUESTA: El número 7 viene antes del 8.

💡 TRUCO: El número anterior es como restar 1: 8 - 1 = 7.` 
    },
    { 
      q: '🔢 Ordena de menor a mayor: 7, 3, 9, 1', 
      a: `📝 DESARROLLO:
• Buscamos el más pequeño primero: 1
• Luego el siguiente: 3
• Después: 7
• El más grande: 9
• Orden: 1, 3, 7, 9

✅ RESPUESTA: 1, 3, 7, 9

💡 TRUCO: Piensa en la recta numérica: los de la izquierda son menores.` 
    },
    { 
      q: '🔢 ¿Cuál es mayor: 6 o 4?', 
      a: `📝 DESARROLLO:
• Comparamos 6 y 4
• 6 está más a la derecha en la recta numérica
• 6 es mayor que 4 (6 > 4)

✅ RESPUESTA: 6 es mayor que 4.

💡 TRUCO: El número más grande tiene más unidades.` 
    },
    { 
      q: '🔢 ¿Cuál es menor: 9 o 5?', 
      a: `📝 DESARROLLO:
• Comparamos 9 y 5
• 5 está más a la izquierda en la recta numérica
• 5 es menor que 9 (5 < 9)

✅ RESPUESTA: 5 es menor que 9.

💡 TRUCO: El número más pequeño está más cerca del 0.` 
    },
    { 
      q: '🔢 Escribe los números del 1 al 5.', 
      a: `📝 DESARROLLO:
• Empezamos desde el 1
• Contamos de uno en uno
• Paramos en el 5

✅ RESPUESTA: 1, 2, 3, 4, 5

💡 TRUCO: Usa los dedos de una mano para contar.` 
    },
    { 
      q: '🔢 ¿Cuántas unidades tiene el número 7?', 
      a: `📝 DESARROLLO:
• El número 7 es un número de un dígito
• Tiene 7 unidades

✅ RESPUESTA: El número 7 tiene 7 unidades.

💡 TRUCO: Los números del 1 al 9 tienen tantas unidades como su valor.` 
    },
    { 
      q: '🔢 ¿Qué número está entre el 4 y el 6?', 
      a: `📝 DESARROLLO:
• Contamos: 4, 5, 6
• Entre el 4 y el 6 está el 5

✅ RESPUESTA: El número 5 está entre el 4 y el 6.

💡 TRUCO: El número del medio es el que viene después del primero.` 
    },
    { 
      q: '🔢 Cuenta de 2 en 2 hasta 10: 2, 4, ...', 
      a: `📝 DESARROLLO:
• Empezamos en 2
• Sumamos 2 cada vez: 2+2=4, 4+2=6, 6+2=8, 8+2=10
• Secuencia: 2, 4, 6, 8, 10

✅ RESPUESTA: 2, 4, 6, 8, 10

💡 TRUCO: Estos son los números pares.` 
    },
    { 
      q: '🔢 ¿Cuántos dedos tienes en una mano?', 
      a: `📝 DESARROLLO:
• Contamos los dedos: pulgar, índice, medio, anular, meñique
• Total: 5 dedos

✅ RESPUESTA: Tienes 5 dedos en una mano.

💡 TRUCO: ¡Usa tu mano para contar hasta 5!` 
    },
    { 
      q: '🔢 ¿Cuántos dedos tienes en las dos manos?', 
      a: `📝 DESARROLLO:
• Una mano: 5 dedos
• Dos manos: 5 + 5 = 10 dedos

✅ RESPUESTA: Tienes 10 dedos en las dos manos.

💡 TRUCO: 5 + 5 = 10. ¡Usa tus manos para contar hasta 10!` 
    },
    { 
      q: '🔢 ¿Qué número es el doble de 3?', 
      a: `📝 DESARROLLO:
• El doble significa multiplicar por 2
• O sumar el número consigo mismo
• 3 + 3 = 6

✅ RESPUESTA: El doble de 3 es 6.

💡 TRUCO: Doble = el número dos veces: 3 + 3 = 6.` 
    },
    { 
      q: '🔢 ¿Qué número es la mitad de 8?', 
      a: `📝 DESARROLLO:
• La mitad significa dividir en 2 partes iguales
• 8 ÷ 2 = 4
• Comprobamos: 4 + 4 = 8 ✓

✅ RESPUESTA: La mitad de 8 es 4.

💡 TRUCO: Busca qué número sumado consigo mismo da 8.` 
    },
    { 
      q: '🔢 Escribe el número que representa: ●●●●●●', 
      a: `📝 DESARROLLO:
• Contamos los círculos: 1, 2, 3, 4, 5, 6
• Total: 6 círculos

✅ RESPUESTA: El número es 6.

💡 TRUCO: Cuenta de uno en uno señalando cada círculo.` 
    },
    { 
      q: '🔢 ¿Cuánto es 10 - 10?', 
      a: `📝 DESARROLLO:
• Tenemos 10
• Quitamos 10
• No queda nada

✅ RESPUESTA: 10 - 10 = 0

💡 TRUCO: Cualquier número menos sí mismo es 0.` 
    }
  ],
  'trucos': [
    { 
      q: '💡 ¿Cuál es el truco para sumar 0 a cualquier número?', 
      a: `📝 DESARROLLO:
• Ejemplos: 5 + 0 = 5, 8 + 0 = 8, 3 + 0 = 3
• Sumar 0 no cambia el número

✅ RESPUESTA: Cuando sumas 0, el número queda igual. Es el "elemento neutro".

💡 TRUCO: 0 es como no agregar nada. ¡El número no cambia!` 
    },
    { 
      q: '💡 ¿Cuál es el truco para sumar 1 a cualquier número?', 
      a: `📝 DESARROLLO:
• Ejemplos: 5 + 1 = 6, 8 + 1 = 9, 3 + 1 = 4
• Sumar 1 da el número siguiente

✅ RESPUESTA: Sumar 1 es pasar al número que sigue (el vecino de la derecha).

💡 TRUCO: 1, 2, 3, 4, 5... Sumar 1 = ¡saltar al siguiente!` 
    },
    { 
      q: '💡 ¿Cuáles son los "amigos del 10"?', 
      a: `📝 DESARROLLO:
• Son parejas de números que suman 10:
• 1 + 9 = 10
• 2 + 8 = 10
• 3 + 7 = 10
• 4 + 6 = 10
• 5 + 5 = 10

✅ RESPUESTA: Los amigos del 10 son: 1+9, 2+8, 3+7, 4+6, 5+5.

💡 TRUCO: ¡Memoriza estas parejas! Son muy útiles.` 
    },
    { 
      q: '💡 ¿Cómo uso los dedos para sumar 3 + 4?', 
      a: `📝 DESARROLLO:
• Paso 1: Levanta 3 dedos en una mano
• Paso 2: Levanta 4 dedos en la otra mano
• Paso 3: Cuenta todos los dedos levantados: 1, 2, 3, 4, 5, 6, 7

✅ RESPUESTA: 3 + 4 = 7

💡 TRUCO: ¡Tus manos son la mejor calculadora!` 
    },
    { 
      q: '💡 ¿Qué son los "dobles" en matemáticas?', 
      a: `📝 DESARROLLO:
• Los dobles son cuando sumas un número consigo mismo:
• 1 + 1 = 2
• 2 + 2 = 4
• 3 + 3 = 6
• 4 + 4 = 8
• 5 + 5 = 10

✅ RESPUESTA: Los dobles son: 1+1=2, 2+2=4, 3+3=6, 4+4=8, 5+5=10.

💡 TRUCO: ¡Memoriza los dobles! Son fáciles de recordar.` 
    },
    { 
      q: '💡 ¿Cuál es el truco para restar 0?', 
      a: `📝 DESARROLLO:
• Ejemplos: 5 - 0 = 5, 8 - 0 = 8, 3 - 0 = 3
• Restar 0 no cambia el número

✅ RESPUESTA: Cuando restas 0, el número queda igual.

💡 TRUCO: 0 es como no quitar nada. ¡El número no cambia!` 
    },
    { 
      q: '💡 ¿Cuál es el truco para restar un número a sí mismo?', 
      a: `📝 DESARROLLO:
• Ejemplos: 5 - 5 = 0, 8 - 8 = 0, 3 - 3 = 0
• Quitar todo lo que tienes = no queda nada

✅ RESPUESTA: Cualquier número menos sí mismo es 0.

💡 TRUCO: Si tienes 5 y das 5, ¡no te queda nada!` 
    },
    { 
      q: '💡 ¿Cómo puedo sumar más fácil cambiando el orden?', 
      a: `📝 DESARROLLO:
• 2 + 7 puede ser difícil
• Pero 7 + 2 es más fácil (empiezas del mayor)
• 2 + 7 = 7 + 2 = 9

✅ RESPUESTA: Puedes cambiar el orden de los números. ¡El resultado es el mismo!

💡 TRUCO: Empieza siempre por el número mayor y suma el menor.` 
    },
    { 
      q: '💡 ¿Cómo cuento hacia atrás para restar?', 
      a: `📝 DESARROLLO:
• Para 8 - 3:
• Empiezo en 8
• Cuento 3 hacia atrás: 7, 6, 5
• Llegué al 5

✅ RESPUESTA: Para restar, cuenta hacia atrás tantos números como indica el segundo número.

💡 TRUCO: 8 - 3 → empiezo en 8, doy 3 saltos atrás: 7, 6, 5 = ¡5!` 
    },
    { 
      q: '💡 ¿Cuál es el truco del "casi doble"?', 
      a: `📝 DESARROLLO:
• Si sabes que 4 + 4 = 8
• Entonces 4 + 5 = 8 + 1 = 9
• Y 4 + 3 = 8 - 1 = 7

✅ RESPUESTA: El "casi doble" es usar un doble conocido y sumar o restar 1.

💡 TRUCO: 4+5 = (4+4)+1 = 8+1 = 9` 
    },
    { 
      q: '💡 ¿Cómo uso el truco "formar 10" para sumar 8 + 5?', 
      a: `📝 DESARROLLO:
• Quiero formar 10 con el 8
• 8 necesita 2 para ser 10
• Tomo 2 del 5 (quedan 3)
• 10 + 3 = 13

✅ RESPUESTA: 8 + 5 = (8 + 2) + 3 = 10 + 3 = 13

💡 TRUCO: ¡Forma 10 primero, es más fácil sumar!` 
    },
    { 
      q: '💡 ¿Por qué es útil saber contar de 2 en 2?', 
      a: `📝 DESARROLLO:
• Contando de 2 en 2: 2, 4, 6, 8, 10
• Sirve para contar cosas en parejas
• Como zapatos, guantes, ojos...

✅ RESPUESTA: Contar de 2 en 2 es más rápido cuando tienes parejas de objetos.

💡 TRUCO: 2, 4, 6, 8, 10... ¡Son los números pares!` 
    },
    { 
      q: '💡 ¿Cómo sé si debo sumar o restar en un problema?', 
      a: `📝 DESARROLLO:
• SUMAR cuando: dan más, llegan, agregan, compran, juntan
• RESTAR cuando: quitan, se van, pierden, comen, regalan

✅ RESPUESTA: Lee las palabras clave del problema.

💡 TRUCO: 
• "Más", "y", "llegan" → SUMAR (+)
• "Quedan", "se van", "pierde" → RESTAR (-)` 
    },
    { 
      q: '💡 ¿Cuál es el truco para sumar 9 + un número?', 
      a: `📝 DESARROLLO:
• 9 + 4 = ?
• Truco: 9 es casi 10
• Suma 10 + 4 = 14
• Resta 1: 14 - 1 = 13

✅ RESPUESTA: 9 + 4 = 10 + 4 - 1 = 13

💡 TRUCO: Sumar 9 = sumar 10 y restar 1.` 
    },
    { 
      q: '💡 ¿Cómo compruebo si mi resta está bien?', 
      a: `📝 DESARROLLO:
• Si 7 - 3 = 4
• Compruebo: 3 + 4 = 7 ✓
• ¡La suma me ayuda a verificar!

✅ RESPUESTA: Suma el resultado con el número que restaste. Debe dar el número inicial.

💡 TRUCO: 7 - 3 = 4 → Comprueba: 3 + 4 = 7 ✓` 
    }
  ],
  // =====================================================================
  // ECUACIONES - NIVEL BÁSICO Y MEDIO
  // =====================================================================
  'ecuaciones': [
    { 
      q: '🔢 Resuelve: x + 5 = 12. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x + 5 = 12
• Para despejar x, restamos 5 de ambos lados
• x + 5 - 5 = 12 - 5
• x = 7

✅ RESPUESTA: x = 7

🔍 VERIFICACIÓN: 7 + 5 = 12 ✓` 
    },
    { 
      q: '🔢 Resuelve: x - 3 = 10. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x - 3 = 10
• Para despejar x, sumamos 3 a ambos lados
• x - 3 + 3 = 10 + 3
• x = 13

✅ RESPUESTA: x = 13

🔍 VERIFICACIÓN: 13 - 3 = 10 ✓` 
    },
    { 
      q: '🔢 Resuelve: 2x = 14. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 2x = 14
• Para despejar x, dividimos ambos lados entre 2
• 2x ÷ 2 = 14 ÷ 2
• x = 7

✅ RESPUESTA: x = 7

🔍 VERIFICACIÓN: 2 × 7 = 14 ✓` 
    },
    { 
      q: '🔢 Resuelve: x/4 = 5. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x/4 = 5
• Para despejar x, multiplicamos ambos lados por 4
• (x/4) × 4 = 5 × 4
• x = 20

✅ RESPUESTA: x = 20

🔍 VERIFICACIÓN: 20 ÷ 4 = 5 ✓` 
    },
    { 
      q: '🔢 Resuelve: 3x + 2 = 17. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 3x + 2 = 17
• Paso 1: Restamos 2 de ambos lados
  → 3x + 2 - 2 = 17 - 2
  → 3x = 15
• Paso 2: Dividimos entre 3
  → 3x ÷ 3 = 15 ÷ 3
  → x = 5

✅ RESPUESTA: x = 5

🔍 VERIFICACIÓN: 3(5) + 2 = 15 + 2 = 17 ✓` 
    },
    { 
      q: '🔢 Resuelve: 2x - 4 = 10. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 2x - 4 = 10
• Paso 1: Sumamos 4 a ambos lados
  → 2x - 4 + 4 = 10 + 4
  → 2x = 14
• Paso 2: Dividimos entre 2
  → x = 7

✅ RESPUESTA: x = 7

🔍 VERIFICACIÓN: 2(7) - 4 = 14 - 4 = 10 ✓` 
    },
    { 
      q: '🔢 Resuelve: 5x = 35. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 5x = 35
• Dividimos ambos lados entre 5
• x = 35 ÷ 5
• x = 7

✅ RESPUESTA: x = 7

🔍 VERIFICACIÓN: 5 × 7 = 35 ✓` 
    },
    { 
      q: '🔢 Resuelve: x + 8 = 8. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x + 8 = 8
• Restamos 8 de ambos lados
• x = 8 - 8
• x = 0

✅ RESPUESTA: x = 0

🔍 VERIFICACIÓN: 0 + 8 = 8 ✓` 
    },
    { 
      q: '🔢 Resuelve: 4x - 8 = 0. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 4x - 8 = 0
• Paso 1: Sumamos 8 a ambos lados
  → 4x = 8
• Paso 2: Dividimos entre 4
  → x = 2

✅ RESPUESTA: x = 2

🔍 VERIFICACIÓN: 4(2) - 8 = 8 - 8 = 0 ✓` 
    },
    { 
      q: '🔢 Resuelve: x/3 + 2 = 5. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x/3 + 2 = 5
• Paso 1: Restamos 2 de ambos lados
  → x/3 = 3
• Paso 2: Multiplicamos por 3
  → x = 9

✅ RESPUESTA: x = 9

🔍 VERIFICACIÓN: 9/3 + 2 = 3 + 2 = 5 ✓` 
    },
    { 
      q: '🔢 Si 2x + 3 = x + 7, ¿cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 2x + 3 = x + 7
• Paso 1: Restamos x de ambos lados
  → 2x - x + 3 = 7
  → x + 3 = 7
• Paso 2: Restamos 3 de ambos lados
  → x = 4

✅ RESPUESTA: x = 4

🔍 VERIFICACIÓN: 2(4) + 3 = 8 + 3 = 11; 4 + 7 = 11 ✓` 
    },
    { 
      q: '🔢 Resuelve: 6x = 42. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 6x = 42
• Dividimos ambos lados entre 6
• x = 42 ÷ 6
• x = 7

✅ RESPUESTA: x = 7

🔍 VERIFICACIÓN: 6 × 7 = 42 ✓` 
    },
    { 
      q: '🔢 Resuelve: x - 15 = 25. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x - 15 = 25
• Sumamos 15 a ambos lados
• x = 25 + 15
• x = 40

✅ RESPUESTA: x = 40

🔍 VERIFICACIÓN: 40 - 15 = 25 ✓` 
    },
    { 
      q: '🔢 Resuelve: 3x + 6 = 21. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: 3x + 6 = 21
• Paso 1: Restamos 6 de ambos lados
  → 3x = 15
• Paso 2: Dividimos entre 3
  → x = 5

✅ RESPUESTA: x = 5

🔍 VERIFICACIÓN: 3(5) + 6 = 15 + 6 = 21 ✓` 
    },
    { 
      q: '🔢 Resuelve: x/2 = 10. ¿Cuánto vale x?', 
      a: `📝 DESARROLLO:
• Ecuación: x/2 = 10
• Multiplicamos ambos lados por 2
• x = 10 × 2
• x = 20

✅ RESPUESTA: x = 20

🔍 VERIFICACIÓN: 20 ÷ 2 = 10 ✓` 
    }
  ],
  // =====================================================================
  // MULTIPLICACIÓN
  // =====================================================================
  'multiplicación': [
    { 
      q: '✖️ En una caja hay 4 filas de 6 chocolates cada una. ¿Cuántos chocolates hay en total?', 
      a: `📝 DESARROLLO:
• Datos: 4 filas, 6 chocolates por fila
• Operación: MULTIPLICACIÓN (grupos iguales)
• Cálculo: 4 × 6 = 24

✅ RESPUESTA: Hay 24 chocolates en total.

💡 TRUCO: 4 × 6 = 4 × 5 + 4 = 20 + 4 = 24` 
    },
    { 
      q: '✖️ Cada semana María ahorra $5. ¿Cuánto ahorrará en 7 semanas?', 
      a: `📝 DESARROLLO:
• Datos: $5 por semana, 7 semanas
• Operación: MULTIPLICACIÓN
• Cálculo: 5 × 7 = 35

✅ RESPUESTA: María ahorrará $35.

💡 TRUCO: 5 × 7 = la mitad de 7 × 10 = 70/2 = 35` 
    },
    { 
      q: '✖️ Un edificio tiene 8 pisos y en cada piso hay 9 ventanas. ¿Cuántas ventanas tiene el edificio?', 
      a: `📝 DESARROLLO:
• Datos: 8 pisos, 9 ventanas por piso
• Operación: MULTIPLICACIÓN
• Cálculo: 8 × 9 = 72

✅ RESPUESTA: El edificio tiene 72 ventanas.

💡 TRUCO: 8 × 9 = 8 × 10 - 8 = 80 - 8 = 72` 
    },
    { 
      q: '✖️ Calcula: 7 × 8', 
      a: `📝 DESARROLLO:
• 7 × 8 significa 7 grupos de 8 (o 8 grupos de 7)
• Podemos usar: 7 × 8 = 7 × 10 - 7 × 2 = 70 - 14 = 56
• O recordar la tabla: 7 × 8 = 56

✅ RESPUESTA: 7 × 8 = 56

💡 TRUCO: 5-6-7-8 → 56 = 7 × 8` 
    },
    { 
      q: '✖️ Calcula: 9 × 6', 
      a: `📝 DESARROLLO:
• 9 × 6 = 9 × 6
• Truco del 9: 9 × 6 = 10 × 6 - 6 = 60 - 6 = 54
• O con los dedos: baja el dedo 6, quedan 5 a la izquierda y 4 a la derecha = 54

✅ RESPUESTA: 9 × 6 = 54

💡 TRUCO: En la tabla del 9, los dígitos siempre suman 9: 5 + 4 = 9` 
    },
    { 
      q: '✖️ Un autobús tiene 12 filas con 4 asientos cada una. ¿Cuántos asientos tiene?', 
      a: `📝 DESARROLLO:
• Datos: 12 filas, 4 asientos por fila
• Operación: MULTIPLICACIÓN
• Cálculo: 12 × 4 = 48

✅ RESPUESTA: El autobús tiene 48 asientos.

💡 TRUCO: 12 × 4 = 10 × 4 + 2 × 4 = 40 + 8 = 48` 
    },
    { 
      q: '✖️ Calcula: 5 × 5', 
      a: `📝 DESARROLLO:
• 5 × 5 = 25
• Es un cuadrado perfecto
• 5 grupos de 5

✅ RESPUESTA: 5 × 5 = 25

💡 TRUCO: Los cuadrados: 1, 4, 9, 16, 25, 36, 49, 64, 81, 100` 
    },
    { 
      q: '✖️ Una granja tiene 6 corrales con 7 gallinas cada uno. ¿Cuántas gallinas hay?', 
      a: `📝 DESARROLLO:
• Datos: 6 corrales, 7 gallinas por corral
• Operación: MULTIPLICACIÓN
• Cálculo: 6 × 7 = 42

✅ RESPUESTA: Hay 42 gallinas en la granja.

💡 TRUCO: 6 × 7 = 6 × 7 = 42 (memorízalo: "6 por 7, cuarenta y dos")` 
    },
    { 
      q: '✖️ Calcula: 8 × 8', 
      a: `📝 DESARROLLO:
• 8 × 8 = 64
• Es un cuadrado perfecto
• 8 grupos de 8

✅ RESPUESTA: 8 × 8 = 64

💡 TRUCO: Los cuadrados perfectos son importantes: 8² = 64` 
    },
    { 
      q: '✖️ Una tienda vende paquetes de 12 lápices. Si compras 5 paquetes, ¿cuántos lápices tienes?', 
      a: `📝 DESARROLLO:
• Datos: 12 lápices por paquete, 5 paquetes
• Operación: MULTIPLICACIÓN
• Cálculo: 12 × 5 = 60

✅ RESPUESTA: Tienes 60 lápices.

💡 TRUCO: 12 × 5 = 60 (la mitad de 12 × 10 = 120/2 = 60)` 
    },
    { 
      q: '✖️ Calcula: 11 × 7', 
      a: `📝 DESARROLLO:
• 11 × 7 = ?
• Truco del 11: suma los dígitos de 7 → 7
• Resultado: 77

✅ RESPUESTA: 11 × 7 = 77

💡 TRUCO: Multiplicar por 11 (un solo dígito): repite el dígito: 11×7=77, 11×4=44` 
    },
    { 
      q: '✖️ Calcula: 10 × 15', 
      a: `📝 DESARROLLO:
• 10 × 15 = ?
• Multiplicar por 10: agregar un cero
• 15 → 150

✅ RESPUESTA: 10 × 15 = 150

💡 TRUCO: Multiplicar por 10 = agregar un 0 al final` 
    },
    { 
      q: '✖️ Calcula: 3 × 9', 
      a: `📝 DESARROLLO:
• 3 × 9 = ?
• Truco del 9: 3 × 9 = 3 × 10 - 3 = 30 - 3 = 27
• O con los dedos

✅ RESPUESTA: 3 × 9 = 27

💡 TRUCO: Los dígitos suman 9: 2 + 7 = 9 ✓` 
    },
    { 
      q: '✖️ Un estante tiene 5 niveles con 8 libros cada uno. ¿Cuántos libros hay?', 
      a: `📝 DESARROLLO:
• Datos: 5 niveles, 8 libros por nivel
• Operación: MULTIPLICACIÓN
• Cálculo: 5 × 8 = 40

✅ RESPUESTA: Hay 40 libros en el estante.

💡 TRUCO: 5 × 8 = 40 (la mitad de 8 × 10)` 
    },
    { 
      q: '✖️ Calcula: 4 × 7', 
      a: `📝 DESARROLLO:
• 4 × 7 = ?
• 4 × 7 = 2 × 7 × 2 = 14 × 2 = 28
• O: 4 × 7 = 4 × 5 + 4 × 2 = 20 + 8 = 28

✅ RESPUESTA: 4 × 7 = 28

💡 TRUCO: 4 × 7 = 28 (es el doble de 14)` 
    }
  ],
  'multiplicacion': [
    { 
      q: '✖️ En una caja hay 4 filas de 6 chocolates cada una. ¿Cuántos chocolates hay en total?', 
      a: `📝 DESARROLLO:
• Datos: 4 filas, 6 chocolates por fila
• Operación: MULTIPLICACIÓN (grupos iguales)
• Cálculo: 4 × 6 = 24

✅ RESPUESTA: Hay 24 chocolates en total.

💡 TRUCO: 4 × 6 = 4 × 5 + 4 = 20 + 4 = 24` 
    },
    { 
      q: '✖️ Cada semana María ahorra $5. ¿Cuánto ahorrará en 7 semanas?', 
      a: `📝 DESARROLLO:
• Datos: $5 por semana, 7 semanas
• Operación: MULTIPLICACIÓN
• Cálculo: 5 × 7 = 35

✅ RESPUESTA: María ahorrará $35.

💡 TRUCO: 5 × 7 = 35` 
    },
    { 
      q: '✖️ Calcula: 7 × 8', 
      a: `📝 DESARROLLO:
• 7 × 8 significa 7 grupos de 8
• 7 × 8 = 56

✅ RESPUESTA: 7 × 8 = 56

💡 TRUCO: 5-6-7-8 → 56 = 7 × 8` 
    },
    { 
      q: '✖️ Calcula: 9 × 6', 
      a: `📝 DESARROLLO:
• 9 × 6 = 10 × 6 - 6 = 60 - 6 = 54

✅ RESPUESTA: 9 × 6 = 54

💡 TRUCO: Los dígitos suman 9: 5 + 4 = 9` 
    },
    { 
      q: '✖️ Calcula: 8 × 8', 
      a: `📝 DESARROLLO:
• 8 × 8 = 64
• Es un cuadrado perfecto

✅ RESPUESTA: 8 × 8 = 64

💡 TRUCO: 8² = 64` 
    },
    { 
      q: '✖️ Calcula: 6 × 7', 
      a: `📝 DESARROLLO:
• 6 × 7 = 42

✅ RESPUESTA: 6 × 7 = 42

💡 TRUCO: "6 por 7, cuarenta y dos"` 
    },
    { 
      q: '✖️ Calcula: 5 × 9', 
      a: `📝 DESARROLLO:
• 5 × 9 = 45

✅ RESPUESTA: 5 × 9 = 45

💡 TRUCO: 4 + 5 = 9 (regla del 9)` 
    },
    { 
      q: '✖️ Calcula: 3 × 8', 
      a: `📝 DESARROLLO:
• 3 × 8 = 24

✅ RESPUESTA: 3 × 8 = 24` 
    },
    { 
      q: '✖️ Calcula: 12 × 5', 
      a: `📝 DESARROLLO:
• 12 × 5 = 60

✅ RESPUESTA: 12 × 5 = 60

💡 TRUCO: 12 × 5 = mitad de 12 × 10` 
    },
    { 
      q: '✖️ Calcula: 10 × 7', 
      a: `📝 DESARROLLO:
• 10 × 7 = 70

✅ RESPUESTA: 10 × 7 = 70

💡 TRUCO: ×10 = agregar un 0` 
    },
    { 
      q: '✖️ Calcula: 4 × 9', 
      a: `📝 DESARROLLO:
• 4 × 9 = 36

✅ RESPUESTA: 4 × 9 = 36

💡 TRUCO: 3 + 6 = 9 ✓` 
    },
    { 
      q: '✖️ Calcula: 11 × 8', 
      a: `📝 DESARROLLO:
• 11 × 8 = 88

✅ RESPUESTA: 11 × 8 = 88` 
    },
    { 
      q: '✖️ Calcula: 7 × 7', 
      a: `📝 DESARROLLO:
• 7 × 7 = 49
• Cuadrado perfecto

✅ RESPUESTA: 7 × 7 = 49` 
    },
    { 
      q: '✖️ Calcula: 2 × 15', 
      a: `📝 DESARROLLO:
• 2 × 15 = 30

✅ RESPUESTA: 2 × 15 = 30

💡 TRUCO: El doble de 15` 
    },
    { 
      q: '✖️ Calcula: 6 × 6', 
      a: `📝 DESARROLLO:
• 6 × 6 = 36
• Cuadrado perfecto

✅ RESPUESTA: 6 × 6 = 36` 
    }
  ],
  // =====================================================================
  // DIVISIÓN
  // =====================================================================
  'división': [
    { 
      q: '➗ Si tenemos 24 galletas y queremos repartirlas entre 6 amigos por igual, ¿cuántas le tocan a cada uno?', 
      a: `📝 DESARROLLO:
• Datos: 24 galletas, 6 amigos
• Operación: DIVISIÓN (repartir en partes iguales)
• Cálculo: 24 ÷ 6 = 4

✅ RESPUESTA: A cada amigo le tocan 4 galletas.

🔍 VERIFICACIÓN: 6 × 4 = 24 ✓` 
    },
    { 
      q: '➗ Calcula: 56 ÷ 8', 
      a: `📝 DESARROLLO:
• 56 ÷ 8 = ?
• Pregunta: ¿8 × ? = 56?
• 8 × 7 = 56
• Por lo tanto: 56 ÷ 8 = 7

✅ RESPUESTA: 56 ÷ 8 = 7

🔍 VERIFICACIÓN: 8 × 7 = 56 ✓` 
    },
    { 
      q: '➗ Calcula: 45 ÷ 9', 
      a: `📝 DESARROLLO:
• 45 ÷ 9 = ?
• Pregunta: ¿9 × ? = 45?
• 9 × 5 = 45
• Por lo tanto: 45 ÷ 9 = 5

✅ RESPUESTA: 45 ÷ 9 = 5

🔍 VERIFICACIÓN: 9 × 5 = 45 ✓` 
    },
    { 
      q: '➗ Un libro tiene 72 páginas. Si leo 8 páginas cada día, ¿en cuántos días termino?', 
      a: `📝 DESARROLLO:
• Datos: 72 páginas, 8 páginas por día
• Operación: DIVISIÓN
• Cálculo: 72 ÷ 8 = 9

✅ RESPUESTA: Terminaré el libro en 9 días.

🔍 VERIFICACIÓN: 8 × 9 = 72 ✓` 
    },
    { 
      q: '➗ Calcula: 63 ÷ 7', 
      a: `📝 DESARROLLO:
• 63 ÷ 7 = ?
• Pregunta: ¿7 × ? = 63?
• 7 × 9 = 63

✅ RESPUESTA: 63 ÷ 7 = 9

🔍 VERIFICACIÓN: 7 × 9 = 63 ✓` 
    },
    { 
      q: '➗ Hay 36 estudiantes y se forman grupos de 4. ¿Cuántos grupos se forman?', 
      a: `📝 DESARROLLO:
• Datos: 36 estudiantes, grupos de 4
• Operación: DIVISIÓN
• Cálculo: 36 ÷ 4 = 9

✅ RESPUESTA: Se forman 9 grupos.

🔍 VERIFICACIÓN: 4 × 9 = 36 ✓` 
    },
    { 
      q: '➗ Calcula: 81 ÷ 9', 
      a: `📝 DESARROLLO:
• 81 ÷ 9 = ?
• 9 × 9 = 81

✅ RESPUESTA: 81 ÷ 9 = 9

💡 TRUCO: 81 es 9 al cuadrado` 
    },
    { 
      q: '➗ Calcula: 48 ÷ 6', 
      a: `📝 DESARROLLO:
• 48 ÷ 6 = ?
• 6 × 8 = 48

✅ RESPUESTA: 48 ÷ 6 = 8

🔍 VERIFICACIÓN: 6 × 8 = 48 ✓` 
    },
    { 
      q: '➗ Calcula: 100 ÷ 10', 
      a: `📝 DESARROLLO:
• 100 ÷ 10 = ?
• Dividir entre 10 = quitar un cero
• 100 → 10

✅ RESPUESTA: 100 ÷ 10 = 10

💡 TRUCO: Dividir entre 10 = quitar el último 0` 
    },
    { 
      q: '➗ Calcula: 35 ÷ 5', 
      a: `📝 DESARROLLO:
• 35 ÷ 5 = ?
• 5 × 7 = 35

✅ RESPUESTA: 35 ÷ 5 = 7

🔍 VERIFICACIÓN: 5 × 7 = 35 ✓` 
    },
    { 
      q: '➗ Tengo $42 y quiero comprar chocolates de $6 cada uno. ¿Cuántos puedo comprar?', 
      a: `📝 DESARROLLO:
• Datos: $42 total, $6 cada chocolate
• Operación: DIVISIÓN
• Cálculo: 42 ÷ 6 = 7

✅ RESPUESTA: Puedo comprar 7 chocolates.

🔍 VERIFICACIÓN: 6 × 7 = $42 ✓` 
    },
    { 
      q: '➗ Calcula: 64 ÷ 8', 
      a: `📝 DESARROLLO:
• 64 ÷ 8 = ?
• 8 × 8 = 64

✅ RESPUESTA: 64 ÷ 8 = 8

💡 TRUCO: 64 es 8 al cuadrado` 
    },
    { 
      q: '➗ Calcula: 27 ÷ 3', 
      a: `📝 DESARROLLO:
• 27 ÷ 3 = ?
• 3 × 9 = 27

✅ RESPUESTA: 27 ÷ 3 = 9

🔍 VERIFICACIÓN: 3 × 9 = 27 ✓` 
    },
    { 
      q: '➗ Una cuerda de 54 cm se corta en pedazos de 9 cm. ¿Cuántos pedazos salen?', 
      a: `📝 DESARROLLO:
• Datos: 54 cm total, pedazos de 9 cm
• Operación: DIVISIÓN
• Cálculo: 54 ÷ 9 = 6

✅ RESPUESTA: Salen 6 pedazos.

🔍 VERIFICACIÓN: 9 × 6 = 54 ✓` 
    },
    { 
      q: '➗ Calcula: 40 ÷ 5', 
      a: `📝 DESARROLLO:
• 40 ÷ 5 = ?
• 5 × 8 = 40

✅ RESPUESTA: 40 ÷ 5 = 8

🔍 VERIFICACIÓN: 5 × 8 = 40 ✓` 
    }
  ],
  'division': [
    { 
      q: '➗ Si tenemos 24 galletas para 6 amigos, ¿cuántas le tocan a cada uno?', 
      a: `📝 DESARROLLO:
• Datos: 24 galletas, 6 amigos
• Operación: DIVISIÓN
• Cálculo: 24 ÷ 6 = 4

✅ RESPUESTA: A cada amigo le tocan 4 galletas.

🔍 VERIFICACIÓN: 6 × 4 = 24 ✓` 
    },
    { 
      q: '➗ Calcula: 56 ÷ 8', 
      a: `📝 DESARROLLO:
• 56 ÷ 8 = 7

✅ RESPUESTA: 56 ÷ 8 = 7

🔍 VERIFICACIÓN: 8 × 7 = 56 ✓` 
    },
    { 
      q: '➗ Calcula: 45 ÷ 9', 
      a: `📝 DESARROLLO:
• 45 ÷ 9 = 5

✅ RESPUESTA: 45 ÷ 9 = 5

🔍 VERIFICACIÓN: 9 × 5 = 45 ✓` 
    },
    { 
      q: '➗ Calcula: 63 ÷ 7', 
      a: `📝 DESARROLLO:
• 63 ÷ 7 = 9

✅ RESPUESTA: 63 ÷ 7 = 9

🔍 VERIFICACIÓN: 7 × 9 = 63 ✓` 
    },
    { 
      q: '➗ Calcula: 81 ÷ 9', 
      a: `📝 DESARROLLO:
• 81 ÷ 9 = 9

✅ RESPUESTA: 81 ÷ 9 = 9` 
    },
    { 
      q: '➗ Calcula: 48 ÷ 6', 
      a: `📝 DESARROLLO:
• 48 ÷ 6 = 8

✅ RESPUESTA: 48 ÷ 6 = 8

🔍 VERIFICACIÓN: 6 × 8 = 48 ✓` 
    },
    { 
      q: '➗ Calcula: 72 ÷ 8', 
      a: `📝 DESARROLLO:
• 72 ÷ 8 = 9

✅ RESPUESTA: 72 ÷ 8 = 9

🔍 VERIFICACIÓN: 8 × 9 = 72 ✓` 
    },
    { 
      q: '➗ Calcula: 100 ÷ 10', 
      a: `📝 DESARROLLO:
• 100 ÷ 10 = 10

✅ RESPUESTA: 100 ÷ 10 = 10` 
    },
    { 
      q: '➗ Calcula: 35 ÷ 5', 
      a: `📝 DESARROLLO:
• 35 ÷ 5 = 7

✅ RESPUESTA: 35 ÷ 5 = 7` 
    },
    { 
      q: '➗ Calcula: 64 ÷ 8', 
      a: `📝 DESARROLLO:
• 64 ÷ 8 = 8

✅ RESPUESTA: 64 ÷ 8 = 8` 
    },
    { 
      q: '➗ Calcula: 27 ÷ 3', 
      a: `📝 DESARROLLO:
• 27 ÷ 3 = 9

✅ RESPUESTA: 27 ÷ 3 = 9` 
    },
    { 
      q: '➗ Calcula: 54 ÷ 6', 
      a: `📝 DESARROLLO:
• 54 ÷ 6 = 9

✅ RESPUESTA: 54 ÷ 6 = 9` 
    },
    { 
      q: '➗ Calcula: 40 ÷ 5', 
      a: `📝 DESARROLLO:
• 40 ÷ 5 = 8

✅ RESPUESTA: 40 ÷ 5 = 8` 
    },
    { 
      q: '➗ Calcula: 42 ÷ 7', 
      a: `📝 DESARROLLO:
• 42 ÷ 7 = 6

✅ RESPUESTA: 42 ÷ 7 = 6` 
    },
    { 
      q: '➗ Calcula: 36 ÷ 4', 
      a: `📝 DESARROLLO:
• 36 ÷ 4 = 9

✅ RESPUESTA: 36 ÷ 4 = 9` 
    }
  ],
  // =====================================================================
  // FRACCIONES
  // =====================================================================
  'fracciones': [
    { 
      q: '🍕 Una pizza se divide en 8 partes iguales. Si comes 3 partes, ¿qué fracción comiste?', 
      a: `📝 DESARROLLO:
• Total de partes: 8 (denominador)
• Partes que comiste: 3 (numerador)
• Fracción: 3/8

✅ RESPUESTA: Comiste 3/8 de la pizza.

💡 CONCEPTO: numerador/denominador = partes tomadas/total de partes` 
    },
    { 
      q: '🍕 ¿Cuánto es 1/2 + 1/2?', 
      a: `📝 DESARROLLO:
• Las fracciones tienen el mismo denominador
• Sumamos los numeradores: 1 + 1 = 2
• Mantenemos el denominador: 2
• Resultado: 2/2 = 1 (un entero)

✅ RESPUESTA: 1/2 + 1/2 = 1

💡 TRUCO: Dos mitades hacen un entero` 
    },
    { 
      q: '🔢 ¿Cuánto es 2/5 + 1/5?', 
      a: `📝 DESARROLLO:
• Mismo denominador (5)
• Sumamos numeradores: 2 + 1 = 3
• Resultado: 3/5

✅ RESPUESTA: 2/5 + 1/5 = 3/5

💡 REGLA: Con mismo denominador, solo suma los numeradores` 
    },
    { 
      q: '🔢 ¿Cuánto es 3/4 - 1/4?', 
      a: `📝 DESARROLLO:
• Mismo denominador (4)
• Restamos numeradores: 3 - 1 = 2
• Resultado: 2/4 = 1/2 (simplificado)

✅ RESPUESTA: 3/4 - 1/4 = 2/4 = 1/2

💡 TRUCO: 2/4 se puede simplificar dividiendo entre 2` 
    },
    { 
      q: '🔢 ¿Qué fracción es mayor: 1/3 o 1/4?', 
      a: `📝 DESARROLLO:
• Con mismo numerador, el denominador más pequeño da la fracción mayor
• 3 < 4, entonces 1/3 > 1/4
• Otra forma: 1/3 ≈ 0.33 y 1/4 = 0.25

✅ RESPUESTA: 1/3 es mayor que 1/4

💡 REGLA: Mismo numerador → denominador más pequeño = fracción mayor` 
    },
    { 
      q: '🔢 Simplifica la fracción 4/8', 
      a: `📝 DESARROLLO:
• Buscamos el MCD de 4 y 8
• MCD(4,8) = 4
• Dividimos numerador y denominador entre 4
• 4÷4 = 1, 8÷4 = 2
• Resultado: 1/2

✅ RESPUESTA: 4/8 = 1/2

💡 TRUCO: 4/8 es lo mismo que la mitad` 
    },
    { 
      q: '🔢 Convierte 1/2 a una fracción con denominador 6', 
      a: `📝 DESARROLLO:
• Queremos ?/6 = 1/2
• Multiplicamos denominador por 3: 2 × 3 = 6
• Multiplicamos numerador por 3: 1 × 3 = 3
• Resultado: 3/6

✅ RESPUESTA: 1/2 = 3/6

💡 REGLA: Multiplica numerador y denominador por el mismo número` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/4 de 20?', 
      a: `📝 DESARROLLO:
• "De" significa multiplicar
• 1/4 de 20 = 1/4 × 20
• = 20 ÷ 4
• = 5

✅ RESPUESTA: 1/4 de 20 = 5

💡 TRUCO: 1/4 de un número = dividir entre 4` 
    },
    { 
      q: '🔢 ¿Cuánto es 2/3 × 6?', 
      a: `📝 DESARROLLO:
• 2/3 × 6 = (2 × 6) / 3
• = 12/3
• = 4

✅ RESPUESTA: 2/3 × 6 = 4

💡 TRUCO: Multiplica arriba, luego divide` 
    },
    { 
      q: '🔢 ¿Cuánto es 3/5 + 1/5?', 
      a: `📝 DESARROLLO:
• Mismo denominador
• Sumamos: 3 + 1 = 4
• Resultado: 4/5

✅ RESPUESTA: 3/5 + 1/5 = 4/5` 
    },
    { 
      q: '🔢 ¿Cuánto es 5/6 - 2/6?', 
      a: `📝 DESARROLLO:
• Mismo denominador
• Restamos: 5 - 2 = 3
• Resultado: 3/6 = 1/2

✅ RESPUESTA: 5/6 - 2/6 = 3/6 = 1/2` 
    },
    { 
      q: '🔢 Ordena de menor a mayor: 1/2, 1/4, 3/4', 
      a: `📝 DESARROLLO:
• Convertimos a mismo denominador (4)
• 1/2 = 2/4
• 1/4 = 1/4
• 3/4 = 3/4
• Orden: 1/4 < 2/4 < 3/4

✅ RESPUESTA: 1/4, 1/2, 3/4` 
    },
    { 
      q: '🔢 ¿Qué fracción representa la mitad?', 
      a: `📝 DESARROLLO:
• La mitad divide algo en 2 partes iguales
• Tomamos 1 de las 2 partes
• Fracción: 1/2

✅ RESPUESTA: 1/2 representa la mitad

💡 EQUIVALENTES: 1/2 = 2/4 = 3/6 = 4/8 = 5/10` 
    },
    { 
      q: '🔢 Si 3/4 de una clase son niñas y hay 28 estudiantes, ¿cuántas niñas hay?', 
      a: `📝 DESARROLLO:
• Total: 28 estudiantes
• Fracción de niñas: 3/4
• Cálculo: 3/4 × 28 = (3 × 28) / 4 = 84/4 = 21

✅ RESPUESTA: Hay 21 niñas.

🔍 VERIFICACIÓN: 21 es 3/4 de 28 ✓` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/2 × 1/2?', 
      a: `📝 DESARROLLO:
• Multiplicamos numeradores: 1 × 1 = 1
• Multiplicamos denominadores: 2 × 2 = 4
• Resultado: 1/4

✅ RESPUESTA: 1/2 × 1/2 = 1/4

💡 CONCEPTO: La mitad de la mitad es un cuarto` 
    }
  ],
  'fraccion': [
    { 
      q: '🍕 Una pizza se divide en 8 partes. Si comes 3, ¿qué fracción comiste?', 
      a: `📝 DESARROLLO:
• Total: 8, Comiste: 3
• Fracción: 3/8

✅ RESPUESTA: 3/8` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/2 + 1/2?', 
      a: `📝 DESARROLLO:
• 1/2 + 1/2 = 2/2 = 1

✅ RESPUESTA: 1` 
    },
    { 
      q: '🔢 ¿Cuánto es 2/5 + 1/5?', 
      a: `📝 DESARROLLO:
• 2/5 + 1/5 = 3/5

✅ RESPUESTA: 3/5` 
    },
    { 
      q: '🔢 ¿Cuánto es 3/4 - 1/4?', 
      a: `📝 DESARROLLO:
• 3/4 - 1/4 = 2/4 = 1/2

✅ RESPUESTA: 1/2` 
    },
    { 
      q: '🔢 Simplifica 4/8', 
      a: `📝 DESARROLLO:
• 4/8 = 1/2

✅ RESPUESTA: 1/2` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/4 de 20?', 
      a: `📝 DESARROLLO:
• 20 ÷ 4 = 5

✅ RESPUESTA: 5` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/2 de 10?', 
      a: `📝 DESARROLLO:
• 10 ÷ 2 = 5

✅ RESPUESTA: 5` 
    },
    { 
      q: '🔢 ¿Qué es mayor: 1/3 o 1/4?', 
      a: `📝 DESARROLLO:
• 1/3 > 1/4

✅ RESPUESTA: 1/3` 
    },
    { 
      q: '🔢 ¿Cuánto es 2/3 de 9?', 
      a: `📝 DESARROLLO:
• (9 × 2) ÷ 3 = 18 ÷ 3 = 6

✅ RESPUESTA: 6` 
    },
    { 
      q: '🔢 Suma: 1/4 + 2/4', 
      a: `📝 DESARROLLO:
• 1/4 + 2/4 = 3/4

✅ RESPUESTA: 3/4` 
    },
    { 
      q: '🔢 Resta: 5/6 - 1/6', 
      a: `📝 DESARROLLO:
• 5/6 - 1/6 = 4/6 = 2/3

✅ RESPUESTA: 2/3` 
    },
    { 
      q: '🔢 ¿Cuánto es 3/4 de 12?', 
      a: `📝 DESARROLLO:
• (12 × 3) ÷ 4 = 36 ÷ 4 = 9

✅ RESPUESTA: 9` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/2 × 1/2?', 
      a: `📝 DESARROLLO:
• 1/2 × 1/2 = 1/4

✅ RESPUESTA: 1/4` 
    },
    { 
      q: '🔢 Simplifica 6/9', 
      a: `📝 DESARROLLO:
• 6/9 = 2/3

✅ RESPUESTA: 2/3` 
    },
    { 
      q: '🔢 ¿Cuánto es 1/3 + 1/3?', 
      a: `📝 DESARROLLO:
• 1/3 + 1/3 = 2/3

✅ RESPUESTA: 2/3` 
    }
  ],

  // =====================================================================
  // POTENCIAS / EXPONENTES
  // =====================================================================
  'potencias': [
    {
      q: '⚡ Potencias 1: Calcula 2^5.',
      a: `📝 DESARROLLO:
• Una potencia 2^5 significa multiplicar 2 por sí mismo 5 veces
• 2^5 = 2 × 2 × 2 × 2 × 2
• 2 × 2 = 4
• 4 × 2 = 8
• 8 × 2 = 16
• 16 × 2 = 32

✅ RESPUESTA: 2^5 = 32

🔍 VERIFICACIÓN: 32 ÷ 2 = 16, 16 ÷ 2 = 8, 8 ÷ 2 = 4, 4 ÷ 2 = 2, 2 ÷ 2 = 1 (se dividió 5 veces) ✓`
    },
    {
      q: '⚡ Potencias 2: Calcula 3^4.',
      a: `📝 DESARROLLO:
• 3^4 = 3 × 3 × 3 × 3
• 3 × 3 = 9
• 9 × 3 = 27
• 27 × 3 = 81

✅ RESPUESTA: 3^4 = 81

🔍 VERIFICACIÓN: 81 ÷ 3 = 27, 27 ÷ 3 = 9, 9 ÷ 3 = 3, 3 ÷ 3 = 1 (4 divisiones) ✓`
    },
    {
      q: '⚡ Potencias 3: Calcula 10^3.',
      a: `📝 DESARROLLO:
• 10^3 = 10 × 10 × 10
• 10 × 10 = 100
• 100 × 10 = 1000

✅ RESPUESTA: 10^3 = 1000

🔍 VERIFICACIÓN: 1000 ÷ 10 = 100, 100 ÷ 10 = 10, 10 ÷ 10 = 1 (3 divisiones) ✓`
    },
    {
      q: '⚡ Potencias 4: Usa la regla del producto: simplifica 2^3 × 2^4.',
      a: `📝 DESARROLLO:
• Regla: a^m × a^n = a^(m+n)
• Base igual: 2
• Exponentes: 3 y 4
• 2^3 × 2^4 = 2^(3+4) = 2^7
• 2^7 = 128

✅ RESPUESTA: 2^3 × 2^4 = 2^7 = 128

🔍 VERIFICACIÓN: 2^3=8 y 2^4=16; 8×16=128 ✓`
    },
    {
      q: '⚡ Potencias 5: Usa la regla del cociente: simplifica 5^6 ÷ 5^2.',
      a: `📝 DESARROLLO:
• Regla: a^m ÷ a^n = a^(m−n)
• Base igual: 5
• Exponentes: 6 y 2
• 5^6 ÷ 5^2 = 5^(6−2) = 5^4
• 5^4 = 5×5×5×5 = 625

✅ RESPUESTA: 5^6 ÷ 5^2 = 5^4 = 625

🔍 VERIFICACIÓN: 5^6=15625 y 5^2=25; 15625÷25=625 ✓`
    },
    {
      q: '⚡ Potencias 6: Simplifica (3^2)^4.',
      a: `📝 DESARROLLO:
• Regla: (a^m)^n = a^(m×n)
• (3^2)^4 = 3^(2×4) = 3^8
• 3^8 = 6561

✅ RESPUESTA: (3^2)^4 = 3^8 = 6561

🔍 VERIFICACIÓN: 3^2=9 y 9^4=9×9×9×9=6561 ✓`
    },
    {
      q: '⚡ Potencias 7: Simplifica 7^0.',
      a: `📝 DESARROLLO:
• Regla: a^0 = 1 (si a ≠ 0)
• Como 7 ≠ 0, entonces 7^0 = 1

✅ RESPUESTA: 7^0 = 1

🔍 VERIFICACIÓN: 7^1 ÷ 7^1 = 7^(1−1) = 7^0 = 1 ✓`
    },
    {
      q: '⚡ Potencias 8: Simplifica 2^(−3).',
      a: `📝 DESARROLLO:
• Regla: a^(−n) = 1 / a^n
• 2^(−3) = 1 / 2^3
• 2^3 = 8
• Entonces 2^(−3) = 1/8

✅ RESPUESTA: 2^(−3) = 1/8

🔍 VERIFICACIÓN: 2^3 × 2^(−3) = 2^(3−3) = 2^0 = 1; 8 × (1/8) = 1 ✓`
    },
    {
      q: '⚡ Potencias 9: Simplifica 4^3.',
      a: `📝 DESARROLLO:
• 4^3 = 4 × 4 × 4
• 4 × 4 = 16
• 16 × 4 = 64

✅ RESPUESTA: 4^3 = 64

🔍 VERIFICACIÓN: 64 ÷ 4 = 16, 16 ÷ 4 = 4, 4 ÷ 4 = 1 (3 divisiones) ✓`
    },
    {
      q: '⚡ Potencias 10: Simplifica 2^4 × 3^4.',
      a: `📝 DESARROLLO:
• Regla: a^n × b^n = (ab)^n
• 2^4 × 3^4 = (2×3)^4 = 6^4
• 6^4 = 6×6×6×6
• 6×6=36
• 36×6=216
• 216×6=1296

✅ RESPUESTA: 2^4 × 3^4 = 6^4 = 1296

🔍 VERIFICACIÓN: 2^4=16 y 3^4=81; 16×81=1296 ✓`
    },
    {
      q: '⚡ Potencias 11: Simplifica 9^(1/2).',
      a: `📝 DESARROLLO:
• Regla: a^(1/2) = √a
• 9^(1/2) = √9
• √9 = 3

✅ RESPUESTA: 9^(1/2) = 3

🔍 VERIFICACIÓN: 3^2 = 9 ✓`
    },
    {
      q: '⚡ Potencias 12: Expresa 0,00045 en notación científica.',
      a: `📝 DESARROLLO:
• Notación científica: a × 10^n, con 1 ≤ a < 10
• 0,00045 = 4,5 moviendo la coma 4 lugares a la derecha
• Como movimos a la derecha, el exponente es negativo
• Entonces: 0,00045 = 4,5 × 10^(−4)

✅ RESPUESTA: 0,00045 = 4,5 × 10^(−4)

🔍 VERIFICACIÓN: 4,5 × 10^(−4) = 4,5 ÷ 10^4 = 4,5 ÷ 10000 = 0,00045 ✓`
    },
    {
      q: '⚡ Potencias 13: Expresa 7.200.000 en notación científica.',
      a: `📝 DESARROLLO:
• 7.200.000 = 7,2 moviendo la coma 6 lugares a la izquierda
• Como movimos a la izquierda, el exponente es positivo
• Entonces: 7.200.000 = 7,2 × 10^6

✅ RESPUESTA: 7.200.000 = 7,2 × 10^6

🔍 VERIFICACIÓN: 7,2 × 10^6 = 7,2 × 1.000.000 = 7.200.000 ✓`
    },
    {
      q: '⚡ Potencias 14: Simplifica (2^3 × 2^2) ÷ 2^4.',
      a: `📝 DESARROLLO:
• Primero: 2^3 × 2^2 = 2^(3+2) = 2^5
• Luego: 2^5 ÷ 2^4 = 2^(5−4) = 2^1
• 2^1 = 2

✅ RESPUESTA: (2^3 × 2^2) ÷ 2^4 = 2

🔍 VERIFICACIÓN: (8×4)÷16=32÷16=2 ✓`
    },
    {
      q: '⚡ Potencias 15: Simplifica 5^3 × 5^(−1).',
      a: `📝 DESARROLLO:
• Regla: a^m × a^n = a^(m+n)
• 5^3 × 5^(−1) = 5^(3 + (−1)) = 5^2
• 5^2 = 25

✅ RESPUESTA: 5^3 × 5^(−1) = 25

🔍 VERIFICACIÓN: 5^3=125 y 5^(−1)=1/5; 125×(1/5)=25 ✓`
    }
  ],

  // =====================================================================
  // DERIVADAS (CÁLCULO DIFERENCIAL)
  // =====================================================================
  'derivadas': [
    {
      q: '📈 Derivadas 1: Calcula d/dx (x^5).',
      a: `📝 DESARROLLO:
• Regla de la potencia: d/dx(x^n) = n·x^(n−1)
• Aquí n = 5
• d/dx(x^5) = 5·x^(5−1) = 5x^4

✅ RESPUESTA: d/dx(x^5) = 5x^4

🔍 VERIFICACIÓN: Si f(x)=x^5, entonces f'(x)=5x^4 (regla estándar) ✓`
    },
    {
      q: '📈 Derivadas 2: Calcula d/dx (3x^4).',
      a: `📝 DESARROLLO:
• Regla: d/dx(c·f(x)) = c·f'(x)
• f(x)=x^4 ⇒ f'(x)=4x^3
• Entonces d/dx(3x^4)=3·4x^3=12x^3

✅ RESPUESTA: d/dx(3x^4) = 12x^3

🔍 VERIFICACIÓN: Constante 3 se mantiene y se deriva x^4 ✓`
    },
    {
      q: '📈 Derivadas 3: Calcula d/dx (x^3 + x^2).',
      a: `📝 DESARROLLO:
• Regla de la suma: (f+g)' = f' + g'
• d/dx(x^3)=3x^2
• d/dx(x^2)=2x
• Sumamos: 3x^2 + 2x

✅ RESPUESTA: d/dx(x^3 + x^2) = 3x^2 + 2x

🔍 VERIFICACIÓN: Derivar término a término ✓`
    },
    {
      q: '📈 Derivadas 4: Calcula d/dx (5x^2 − 7x).',
      a: `📝 DESARROLLO:
• d/dx(5x^2)=5·2x=10x
• d/dx(−7x)=−7
• Entonces: 10x − 7

✅ RESPUESTA: d/dx(5x^2 − 7x) = 10x − 7

🔍 VERIFICACIÓN: d/dx(ax)=a ✓`
    },
    {
      q: '📈 Derivadas 5: Calcula d/dx (2x^3 + 4).',
      a: `📝 DESARROLLO:
• d/dx(2x^3)=2·3x^2=6x^2
• d/dx(4)=0 (constante)
• Resultado: 6x^2

✅ RESPUESTA: d/dx(2x^3 + 4) = 6x^2

🔍 VERIFICACIÓN: Las constantes derivan 0 ✓`
    },
    {
      q: '📈 Derivadas 6: Calcula d/dx (x^(−2)).',
      a: `📝 DESARROLLO:
• Regla potencia: d/dx(x^n)=n·x^(n−1)
• n = −2
• d/dx(x^(−2)) = (−2)·x^(−3)

✅ RESPUESTA: d/dx(x^(−2)) = −2x^(−3)

🔍 VERIFICACIÓN: x^(−2)=1/x^2; su derivada es −2/x^3 ✓`
    },
    {
      q: '📈 Derivadas 7: Calcula d/dx (√x).',
      a: `📝 DESARROLLO:
• √x = x^(1/2)
• d/dx(x^(1/2)) = (1/2)·x^(−1/2)
• x^(−1/2) = 1/√x
• Entonces: (1/2)·1/√x = 1/(2√x)

✅ RESPUESTA: d/dx(√x) = 1/(2√x)

🔍 VERIFICACIÓN: Regla de potencia con exponente 1/2 ✓`
    },
    {
      q: '📈 Derivadas 8: Calcula d/dx (1/x).',
      a: `📝 DESARROLLO:
• 1/x = x^(−1)
• d/dx(x^(−1)) = (−1)·x^(−2)
• x^(−2)=1/x^2
• Entonces: −1/x^2

✅ RESPUESTA: d/dx(1/x) = −1/x^2

🔍 VERIFICACIÓN: Derivada estándar de 1/x ✓`
    },
    {
      q: '📈 Derivadas 9: Calcula d/dx (x^4 − 2x^2 + x).',
      a: `📝 DESARROLLO:
• d/dx(x^4)=4x^3
• d/dx(−2x^2)=−2·2x=−4x
• d/dx(x)=1
• Resultado: 4x^3 − 4x + 1

✅ RESPUESTA: d/dx(x^4 − 2x^2 + x) = 4x^3 − 4x + 1

🔍 VERIFICACIÓN: Derivar término a término ✓`
    },
    {
      q: '📈 Derivadas 10: Calcula d/dx (7).',
      a: `📝 DESARROLLO:
• La derivada de una constante es 0
• d/dx(7)=0

✅ RESPUESTA: d/dx(7) = 0

🔍 VERIFICACIÓN: La función es una recta horizontal, pendiente 0 ✓`
    },
    {
      q: '📈 Derivadas 11: Calcula d/dx (x^2 + 2x + 1).',
      a: `📝 DESARROLLO:
• d/dx(x^2)=2x
• d/dx(2x)=2
• d/dx(1)=0
• Resultado: 2x + 2

✅ RESPUESTA: d/dx(x^2 + 2x + 1) = 2x + 2

🔍 VERIFICACIÓN: Derivar cada término ✓`
    },
    {
      q: '📈 Derivadas 12: Si f(x)=x^3, calcula f\'(2).',
      a: `📝 DESARROLLO:
• Primero derivamos: f(x)=x^3 ⇒ f'(x)=3x^2
• Evaluamos en x=2: f'(2)=3·(2^2)
• 2^2=4
• 3·4=12

✅ RESPUESTA: f'(2) = 12

🔍 VERIFICACIÓN: Pendiente de la tangente en x=2 para x^3 ✓`
    },
    {
      q: '📈 Derivadas 13: Calcula d/dx (x^6 + 3x^2 − 5).',
      a: `📝 DESARROLLO:
• d/dx(x^6)=6x^5
• d/dx(3x^2)=3·2x=6x
• d/dx(−5)=0
• Resultado: 6x^5 + 6x

✅ RESPUESTA: d/dx(x^6 + 3x^2 − 5) = 6x^5 + 6x

🔍 VERIFICACIÓN: Constantes derivan 0 ✓`
    },
    {
      q: '📈 Derivadas 14: Calcula d/dx (x^2) y explica qué representa.',
      a: `📝 DESARROLLO:
• Aplicamos regla de potencia: d/dx(x^2)=2x
• Interpretación: 2x es la pendiente de la recta tangente a y=x^2 en cada punto x

✅ RESPUESTA: d/dx(x^2) = 2x

🔍 VERIFICACIÓN: En x=1, pendiente 2; en x=0, pendiente 0 ✓`
    },
    {
      q: '📈 Derivadas 15: Calcula d/dx (4x^3 − x^4).',
      a: `📝 DESARROLLO:
• d/dx(4x^3)=4·3x^2=12x^2
• d/dx(−x^4)=−4x^3
• Resultado: 12x^2 − 4x^3

✅ RESPUESTA: d/dx(4x^3 − x^4) = 12x^2 − 4x^3

🔍 VERIFICACIÓN: Factor común: 4x^2(3−x) ✓`
    }
  ]
};

// Alias: reutilizar exactamente el mismo set para términos equivalentes
mathProblemBanks['raiz cuadrada'] = mathProblemBanks['raices cuadradas'];
mathProblemBanks['raices'] = mathProblemBanks['raices cuadradas'];
mathProblemBanks['raiz'] = mathProblemBanks['raices cuadradas'];
mathProblemBanks['radicales'] = mathProblemBanks['raices cuadradas'];
mathProblemBanks['radical'] = mathProblemBanks['raices cuadradas'];

mathProblemBanks['potencia'] = mathProblemBanks['potencias'];
mathProblemBanks['exponente'] = mathProblemBanks['potencias'];
mathProblemBanks['exponentes'] = mathProblemBanks['potencias'];

mathProblemBanks['derivada'] = mathProblemBanks['derivadas'];

// =====================================================================
// ECUACIONES CUADRÁTICAS
// =====================================================================
mathProblemBanks['ecuaciones cuadraticas'] = [
  {
    q: '📐 Ecuación Cuadrática 1: Resuelve x² - 5x + 6 = 0',
    a: `📝 DESARROLLO:
• Identificamos: a=1, b=-5, c=6
• Buscamos dos números que multiplicados den 6 y sumados den -5
• Esos números son -2 y -3
• Factorizamos: (x - 2)(x - 3) = 0
• Entonces: x - 2 = 0 → x = 2
•           x - 3 = 0 → x = 3

✅ RESPUESTA: x = 2 y x = 3

🔍 VERIFICACIÓN: 
• Para x=2: 2² - 5(2) + 6 = 4 - 10 + 6 = 0 ✓
• Para x=3: 3² - 5(3) + 6 = 9 - 15 + 6 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 2: Resuelve x² + 4x + 4 = 0',
    a: `📝 DESARROLLO:
• Identificamos: a=1, b=4, c=4
• Es un trinomio cuadrado perfecto: (x + 2)²
• (x + 2)² = 0
• x + 2 = 0
• x = -2

✅ RESPUESTA: x = -2 (raíz doble)

🔍 VERIFICACIÓN: (-2)² + 4(-2) + 4 = 4 - 8 + 4 = 0 ✓

💡 CONCEPTO: Cuando el discriminante b² - 4ac = 0, hay una raíz doble`
  },
  {
    q: '📐 Ecuación Cuadrática 3: Resuelve x² - 9 = 0',
    a: `📝 DESARROLLO:
• Es una diferencia de cuadrados
• x² = 9
• x = ±√9
• x = ±3

✅ RESPUESTA: x = 3 y x = -3

🔍 VERIFICACIÓN: 
• Para x=3: 3² - 9 = 9 - 9 = 0 ✓
• Para x=-3: (-3)² - 9 = 9 - 9 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 4: Resuelve 2x² - 8 = 0',
    a: `📝 DESARROLLO:
• Despejamos x²: 2x² = 8
• x² = 8/2 = 4
• x = ±√4
• x = ±2

✅ RESPUESTA: x = 2 y x = -2

🔍 VERIFICACIÓN: 
• Para x=2: 2(2²) - 8 = 2(4) - 8 = 8 - 8 = 0 ✓
• Para x=-2: 2(-2)² - 8 = 2(4) - 8 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 5: Usa la fórmula cuadrática para resolver x² - 4x + 3 = 0',
    a: `📝 DESARROLLO:
• Fórmula: x = (-b ± √(b² - 4ac)) / 2a
• a=1, b=-4, c=3
• Discriminante: b² - 4ac = 16 - 12 = 4
• x = (4 ± √4) / 2 = (4 ± 2) / 2
• x₁ = (4 + 2) / 2 = 6/2 = 3
• x₂ = (4 - 2) / 2 = 2/2 = 1

✅ RESPUESTA: x = 3 y x = 1

🔍 VERIFICACIÓN: 
• Para x=3: 9 - 12 + 3 = 0 ✓
• Para x=1: 1 - 4 + 3 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 6: Resuelve x² + 2x - 15 = 0',
    a: `📝 DESARROLLO:
• Buscamos dos números que multiplicados den -15 y sumados den 2
• Esos números son 5 y -3 (5 × -3 = -15, 5 + (-3) = 2)
• Factorizamos: (x + 5)(x - 3) = 0
• x = -5 o x = 3

✅ RESPUESTA: x = -5 y x = 3

🔍 VERIFICACIÓN: 
• Para x=-5: 25 + (-10) - 15 = 0 ✓
• Para x=3: 9 + 6 - 15 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 7: Resuelve 3x² - 12x = 0',
    a: `📝 DESARROLLO:
• Factorizamos el factor común: 3x(x - 4) = 0
• Entonces: 3x = 0 → x = 0
•           x - 4 = 0 → x = 4

✅ RESPUESTA: x = 0 y x = 4

🔍 VERIFICACIÓN: 
• Para x=0: 3(0)² - 12(0) = 0 ✓
• Para x=4: 3(16) - 48 = 48 - 48 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 8: Calcula el discriminante de x² + 3x + 5 = 0 y determina el tipo de raíces',
    a: `📝 DESARROLLO:
• Discriminante: Δ = b² - 4ac
• a=1, b=3, c=5
• Δ = 9 - 20 = -11

✅ RESPUESTA: Δ = -11 (discriminante negativo)
• Como Δ < 0, la ecuación NO tiene soluciones reales
• Las soluciones son números complejos

💡 CONCEPTO: 
• Δ > 0: dos raíces reales distintas
• Δ = 0: una raíz real doble
• Δ < 0: no hay raíces reales (raíces complejas)`
  },
  {
    q: '📐 Ecuación Cuadrática 9: Resuelve x² - 6x + 9 = 0',
    a: `📝 DESARROLLO:
• Reconocemos: es (x - 3)² = 0
• También: a=1, b=-6, c=9
• Δ = 36 - 36 = 0 → raíz doble
• x - 3 = 0
• x = 3

✅ RESPUESTA: x = 3 (raíz doble)

🔍 VERIFICACIÓN: 3² - 6(3) + 9 = 9 - 18 + 9 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 10: Resuelve x² = 16',
    a: `📝 DESARROLLO:
• Despejamos: x² = 16
• x = ±√16
• x = ±4

✅ RESPUESTA: x = 4 y x = -4

🔍 VERIFICACIÓN: 
• 4² = 16 ✓
• (-4)² = 16 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 11: Resuelve x² - x - 12 = 0',
    a: `📝 DESARROLLO:
• Buscamos dos números que multiplicados den -12 y sumados den -1
• Esos números son -4 y 3 (-4 × 3 = -12, -4 + 3 = -1)
• Factorizamos: (x - 4)(x + 3) = 0
• x = 4 o x = -3

✅ RESPUESTA: x = 4 y x = -3

🔍 VERIFICACIÓN: 
• Para x=4: 16 - 4 - 12 = 0 ✓
• Para x=-3: 9 + 3 - 12 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 12: Resuelve 2x² + 5x - 3 = 0',
    a: `📝 DESARROLLO:
• Usamos fórmula cuadrática: a=2, b=5, c=-3
• Δ = 25 + 24 = 49
• x = (-5 ± √49) / 4 = (-5 ± 7) / 4
• x₁ = (-5 + 7) / 4 = 2/4 = 1/2
• x₂ = (-5 - 7) / 4 = -12/4 = -3

✅ RESPUESTA: x = 1/2 y x = -3

🔍 VERIFICACIÓN: 
• Para x=1/2: 2(1/4) + 5(1/2) - 3 = 0.5 + 2.5 - 3 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 13: Resuelve x² + 6x + 5 = 0',
    a: `📝 DESARROLLO:
• Buscamos dos números que multiplicados den 5 y sumados den 6
• Esos números son 5 y 1 (5 × 1 = 5, 5 + 1 = 6)
• Factorizamos: (x + 5)(x + 1) = 0
• x = -5 o x = -1

✅ RESPUESTA: x = -5 y x = -1

🔍 VERIFICACIÓN: 
• Para x=-5: 25 - 30 + 5 = 0 ✓
• Para x=-1: 1 - 6 + 5 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 14: Completa el cuadrado para resolver x² + 4x - 5 = 0',
    a: `📝 DESARROLLO:
• x² + 4x = 5
• Completamos el cuadrado: (b/2)² = (4/2)² = 4
• x² + 4x + 4 = 5 + 4
• (x + 2)² = 9
• x + 2 = ±3
• x = -2 + 3 = 1  o  x = -2 - 3 = -5

✅ RESPUESTA: x = 1 y x = -5

🔍 VERIFICACIÓN: 
• Para x=1: 1 + 4 - 5 = 0 ✓
• Para x=-5: 25 - 20 - 5 = 0 ✓`
  },
  {
    q: '📐 Ecuación Cuadrática 15: Resuelve x² - 7x + 10 = 0',
    a: `📝 DESARROLLO:
• Buscamos dos números que multiplicados den 10 y sumados den -7
• Esos números son -5 y -2 (-5 × -2 = 10, -5 + (-2) = -7)
• Factorizamos: (x - 5)(x - 2) = 0
• x = 5 o x = 2

✅ RESPUESTA: x = 5 y x = 2

🔍 VERIFICACIÓN: 
• Para x=5: 25 - 35 + 10 = 0 ✓
• Para x=2: 4 - 14 + 10 = 0 ✓`
  }
];
// Aliases para ecuaciones cuadráticas
mathProblemBanks['ecuacion cuadratica'] = mathProblemBanks['ecuaciones cuadraticas'];
mathProblemBanks['ecuaciones cuadráticas'] = mathProblemBanks['ecuaciones cuadraticas'];
mathProblemBanks['ecuación cuadrática'] = mathProblemBanks['ecuaciones cuadraticas'];
mathProblemBanks['cuadraticas'] = mathProblemBanks['ecuaciones cuadraticas'];

// =====================================================================
// GEOMETRÍA BÁSICA
// =====================================================================
mathProblemBanks['geometria basica'] = [
  {
    q: '📐 Problema de Geometría 1: Un rectángulo tiene 8 cm de largo y 5 cm de ancho. ¿Cuál es su área?',
    a: `📝 DESARROLLO:
• Fórmula del área del rectángulo: A = largo × ancho
• A = 8 cm × 5 cm
• A = 40 cm²

✅ RESPUESTA: El área es 40 cm²

🔍 VERIFICACIÓN: 8 × 5 = 40 ✓`
  },
  {
    q: '📐 Problema de Geometría 2: Un cuadrado tiene un lado de 6 cm. ¿Cuál es su perímetro?',
    a: `📝 DESARROLLO:
• Fórmula del perímetro del cuadrado: P = 4 × lado
• P = 4 × 6 cm
• P = 24 cm

✅ RESPUESTA: El perímetro es 24 cm

🔍 VERIFICACIÓN: 6 + 6 + 6 + 6 = 24 ✓`
  },
  {
    q: '📐 Problema de Geometría 3: Un triángulo tiene base de 10 cm y altura de 6 cm. ¿Cuál es su área?',
    a: `📝 DESARROLLO:
• Fórmula del área del triángulo: A = (base × altura) / 2
• A = (10 cm × 6 cm) / 2
• A = 60 / 2 = 30 cm²

✅ RESPUESTA: El área es 30 cm²

🔍 VERIFICACIÓN: (10 × 6) / 2 = 60 / 2 = 30 ✓`
  },
  {
    q: '📐 Problema de Geometría 4: Un círculo tiene radio de 7 cm. ¿Cuál es su área? (usa π ≈ 3.14)',
    a: `📝 DESARROLLO:
• Fórmula del área del círculo: A = π × r²
• A = 3.14 × 7²
• A = 3.14 × 49 = 153.86 cm²

✅ RESPUESTA: El área es aproximadamente 153.86 cm²

💡 CONCEPTO: El área del círculo depende del cuadrado del radio`
  },
  {
    q: '📐 Problema de Geometría 5: Un rectángulo tiene un área de 48 cm² y un largo de 8 cm. ¿Cuál es el ancho?',
    a: `📝 DESARROLLO:
• Fórmula: A = largo × ancho → ancho = A / largo
• ancho = 48 cm² / 8 cm
• ancho = 6 cm

✅ RESPUESTA: El ancho es 6 cm

🔍 VERIFICACIÓN: 8 × 6 = 48 cm² ✓`
  },
  {
    q: '📐 Problema de Geometría 6: Un triángulo equilátero tiene un perímetro de 27 cm. ¿Cuánto mide cada lado?',
    a: `📝 DESARROLLO:
• En un triángulo equilátero los 3 lados son iguales
• Perímetro = 3 × lado → lado = Perímetro / 3
• lado = 27 cm / 3 = 9 cm

✅ RESPUESTA: Cada lado mide 9 cm

🔍 VERIFICACIÓN: 9 + 9 + 9 = 27 cm ✓`
  },
  {
    q: '📐 Problema de Geometría 7: ¿Cuál es el perímetro de un rectángulo con largo 12 cm y ancho 5 cm?',
    a: `📝 DESARROLLO:
• Fórmula del perímetro del rectángulo: P = 2 × (largo + ancho)
• P = 2 × (12 + 5)
• P = 2 × 17 = 34 cm

✅ RESPUESTA: El perímetro es 34 cm

🔍 VERIFICACIÓN: 12 + 5 + 12 + 5 = 34 ✓`
  },
  {
    q: '📐 Problema de Geometría 8: Un cuadrado tiene un área de 81 cm². ¿Cuánto mide cada lado?',
    a: `📝 DESARROLLO:
• Fórmula: A = lado² → lado = √A
• lado = √81
• lado = 9 cm

✅ RESPUESTA: Cada lado mide 9 cm

🔍 VERIFICACIÓN: 9² = 81 cm² ✓`
  },
  {
    q: '📐 Problema de Geometría 9: ¿Cuántos grados suman los ángulos interiores de un triángulo?',
    a: `📝 DESARROLLO:
• Propiedad fundamental: La suma de los ángulos interiores de un triángulo siempre es 180°
• Esto aplica a todo tipo de triángulo (equilátero, isósceles, escaleno)

✅ RESPUESTA: Los ángulos interiores suman 180°

💡 CONCEPTO: Esta propiedad se usa para encontrar ángulos desconocidos`
  },
  {
    q: '📐 Problema de Geometría 10: Un triángulo tiene ángulos de 60° y 80°. ¿Cuánto mide el tercer ángulo?',
    a: `📝 DESARROLLO:
• Suma de ángulos = 180°
• Tercer ángulo = 180° - 60° - 80°
• Tercer ángulo = 40°

✅ RESPUESTA: El tercer ángulo mide 40°

🔍 VERIFICACIÓN: 60° + 80° + 40° = 180° ✓`
  },
  {
    q: '📐 Problema de Geometría 11: ¿Cuál es la circunferencia de un círculo con radio 5 cm? (usa π ≈ 3.14)',
    a: `📝 DESARROLLO:
• Fórmula de la circunferencia: C = 2 × π × r
• C = 2 × 3.14 × 5
• C = 31.4 cm

✅ RESPUESTA: La circunferencia es 31.4 cm

💡 CONCEPTO: La circunferencia es el perímetro del círculo`
  },
  {
    q: '📐 Problema de Geometría 12: Un rombo tiene diagonales de 6 cm y 8 cm. ¿Cuál es su área?',
    a: `📝 DESARROLLO:
• Fórmula del área del rombo: A = (d₁ × d₂) / 2
• A = (6 × 8) / 2
• A = 48 / 2 = 24 cm²

✅ RESPUESTA: El área del rombo es 24 cm²

🔍 VERIFICACIÓN: (6 × 8) / 2 = 24 ✓`
  },
  {
    q: '📐 Problema de Geometría 13: Un trapecio tiene bases de 10 cm y 6 cm, y altura de 4 cm. ¿Cuál es su área?',
    a: `📝 DESARROLLO:
• Fórmula del área del trapecio: A = [(b₁ + b₂) × h] / 2
• A = [(10 + 6) × 4] / 2
• A = [16 × 4] / 2 = 64 / 2 = 32 cm²

✅ RESPUESTA: El área del trapecio es 32 cm²

🔍 VERIFICACIÓN: (16 × 4) / 2 = 32 ✓`
  },
  {
    q: '📐 Problema de Geometría 14: Un hexágono regular tiene 6 lados de 5 cm cada uno. ¿Cuál es su perímetro?',
    a: `📝 DESARROLLO:
• Perímetro = número de lados × longitud de cada lado
• P = 6 × 5 cm
• P = 30 cm

✅ RESPUESTA: El perímetro del hexágono es 30 cm

🔍 VERIFICACIÓN: 5 + 5 + 5 + 5 + 5 + 5 = 30 ✓`
  },
  {
    q: '📐 Problema de Geometría 15: Un paralelogramo tiene base de 9 cm y altura de 7 cm. ¿Cuál es su área?',
    a: `📝 DESARROLLO:
• Fórmula del área del paralelogramo: A = base × altura
• A = 9 cm × 7 cm
• A = 63 cm²

✅ RESPUESTA: El área del paralelogramo es 63 cm²

🔍 VERIFICACIÓN: 9 × 7 = 63 ✓`
  }
];
// Aliases para geometría
mathProblemBanks['geometria'] = mathProblemBanks['geometria basica'];
mathProblemBanks['geometría'] = mathProblemBanks['geometria basica'];
mathProblemBanks['geometría básica'] = mathProblemBanks['geometria basica'];

// =====================================================================
// TRIGONOMETRÍA
// =====================================================================
mathProblemBanks['trigonometria'] = [
  {
    q: '📐 Problema de Trigonometría 1: En un triángulo rectángulo, el cateto opuesto mide 3 y el cateto adyacente mide 4. ¿Cuánto vale tan(θ)?',
    a: `📝 DESARROLLO:
• Fórmula: tan(θ) = cateto opuesto / cateto adyacente
• tan(θ) = 3 / 4
• tan(θ) = 0.75

✅ RESPUESTA: tan(θ) = 0.75

💡 CONCEPTO: La tangente es la razón entre el cateto opuesto y el adyacente`
  },
  {
    q: '📐 Problema de Trigonometría 2: Si sen(θ) = 0.5, ¿cuál es el ángulo θ en grados?',
    a: `📝 DESARROLLO:
• Buscamos θ tal que sen(θ) = 0.5
• Usando valores conocidos: sen(30°) = 0.5
• θ = 30°

✅ RESPUESTA: θ = 30°

🔍 VERIFICACIÓN: sen(30°) = 1/2 = 0.5 ✓`
  },
  {
    q: '📐 Problema de Trigonometría 3: En un triángulo rectángulo, la hipotenusa mide 10 y un cateto mide 6. ¿Cuánto mide el otro cateto?',
    a: `📝 DESARROLLO:
• Teorema de Pitágoras: a² + b² = c²
• 6² + b² = 10²
• 36 + b² = 100
• b² = 64
• b = 8

✅ RESPUESTA: El otro cateto mide 8

🔍 VERIFICACIÓN: 6² + 8² = 36 + 64 = 100 = 10² ✓`
  },
  {
    q: '📐 Problema de Trigonometría 4: ¿Cuál es el valor de cos(60°)?',
    a: `📝 DESARROLLO:
• Valor conocido de la tabla trigonométrica
• cos(60°) = 1/2 = 0.5

✅ RESPUESTA: cos(60°) = 0.5

💡 CONCEPTO: Valores notables - cos(60°) = sen(30°) = 0.5`
  },
  {
    q: '📐 Problema de Trigonometría 5: Si cos(θ) = 0.8 y la hipotenusa es 10, ¿cuánto mide el cateto adyacente?',
    a: `📝 DESARROLLO:
• Fórmula: cos(θ) = cateto adyacente / hipotenusa
• 0.8 = cateto adyacente / 10
• cateto adyacente = 0.8 × 10 = 8

✅ RESPUESTA: El cateto adyacente mide 8

🔍 VERIFICACIÓN: 8 / 10 = 0.8 ✓`
  },
  {
    q: '📐 Problema de Trigonometría 6: ¿Cuál es el valor de sen(90°)?',
    a: `📝 DESARROLLO:
• Valor conocido de la tabla trigonométrica
• sen(90°) = 1

✅ RESPUESTA: sen(90°) = 1

💡 CONCEPTO: En 90°, el cateto opuesto es igual a la hipotenusa`
  },
  {
    q: '📐 Problema de Trigonometría 7: Calcula: sen²(30°) + cos²(30°)',
    a: `📝 DESARROLLO:
• Identidad trigonométrica fundamental: sen²(θ) + cos²(θ) = 1
• Por lo tanto: sen²(30°) + cos²(30°) = 1

✅ RESPUESTA: sen²(30°) + cos²(30°) = 1

💡 CONCEPTO: Esta identidad siempre es igual a 1 para cualquier ángulo`
  },
  {
    q: '📐 Problema de Trigonometría 8: Si tan(θ) = 1, ¿cuánto vale θ?',
    a: `📝 DESARROLLO:
• Buscamos θ tal que tan(θ) = 1
• Esto ocurre cuando cateto opuesto = cateto adyacente
• tan(45°) = 1
• θ = 45°

✅ RESPUESTA: θ = 45°

🔍 VERIFICACIÓN: tan(45°) = sen(45°)/cos(45°) = 1 ✓`
  },
  {
    q: '📐 Problema de Trigonometría 9: En un triángulo rectángulo, si θ = 30° y la hipotenusa = 12, ¿cuánto mide el cateto opuesto?',
    a: `📝 DESARROLLO:
• Fórmula: sen(θ) = cateto opuesto / hipotenusa
• sen(30°) = cateto opuesto / 12
• 0.5 = cateto opuesto / 12
• cateto opuesto = 0.5 × 12 = 6

✅ RESPUESTA: El cateto opuesto mide 6

🔍 VERIFICACIÓN: 6 / 12 = 0.5 = sen(30°) ✓`
  },
  {
    q: '📐 Problema de Trigonometría 10: ¿Cuál es el valor de cos(0°)?',
    a: `📝 DESARROLLO:
• Valor conocido de la tabla trigonométrica
• cos(0°) = 1

✅ RESPUESTA: cos(0°) = 1

💡 CONCEPTO: En 0°, el cateto adyacente es igual a la hipotenusa`
  },
  {
    q: '📐 Problema de Trigonometría 11: Convierte 180° a radianes.',
    a: `📝 DESARROLLO:
• Fórmula: radianes = grados × (π / 180°)
• 180° × (π / 180°)
• = π radianes

✅ RESPUESTA: 180° = π radianes

💡 CONCEPTO: 180° equivale a media vuelta, que es π radianes`
  },
  {
    q: '📐 Problema de Trigonometría 12: Si sen(θ) = 3/5, ¿cuál es cos(θ)?',
    a: `📝 DESARROLLO:
• Usamos: sen²(θ) + cos²(θ) = 1
• (3/5)² + cos²(θ) = 1
• 9/25 + cos²(θ) = 1
• cos²(θ) = 1 - 9/25 = 16/25
• cos(θ) = 4/5

✅ RESPUESTA: cos(θ) = 4/5 = 0.8

🔍 VERIFICACIÓN: (3/5)² + (4/5)² = 9/25 + 16/25 = 25/25 = 1 ✓`
  },
  {
    q: '📐 Problema de Trigonometría 13: ¿Cuál es el valor de tan(0°)?',
    a: `📝 DESARROLLO:
• Fórmula: tan(θ) = sen(θ) / cos(θ)
• tan(0°) = sen(0°) / cos(0°) = 0 / 1 = 0

✅ RESPUESTA: tan(0°) = 0

💡 CONCEPTO: En 0°, el cateto opuesto es 0, por lo que tan(0°) = 0`
  },
  {
    q: '📐 Problema de Trigonometría 14: Convierte π/4 radianes a grados.',
    a: `📝 DESARROLLO:
• Fórmula: grados = radianes × (180° / π)
• (π/4) × (180° / π)
• = 180° / 4 = 45°

✅ RESPUESTA: π/4 radianes = 45°

🔍 VERIFICACIÓN: 45° × (π/180°) = π/4 ✓`
  },
  {
    q: '📐 Problema de Trigonometría 15: Una escalera de 5 m forma un ángulo de 60° con el suelo. ¿A qué altura llega?',
    a: `📝 DESARROLLO:
• La escalera es la hipotenusa, la altura es el cateto opuesto
• sen(60°) = altura / 5
• √3/2 ≈ 0.866 = altura / 5
• altura = 5 × 0.866 ≈ 4.33 m

✅ RESPUESTA: La escalera llega a aproximadamente 4.33 m de altura

💡 CONCEPTO: Aplicación práctica del seno en problemas reales`
  }
];
// Aliases para trigonometría
mathProblemBanks['trigonometría'] = mathProblemBanks['trigonometria'];

// =====================================================================
// ESTADÍSTICA
// =====================================================================
mathProblemBanks['estadistica'] = [
  {
    q: '📊 Problema de Estadística 1: Calcula la media de los datos: 4, 7, 9, 12, 8',
    a: `📝 DESARROLLO:
• Fórmula: Media = suma de datos / cantidad de datos
• Suma = 4 + 7 + 9 + 12 + 8 = 40
• Cantidad = 5
• Media = 40 / 5 = 8

✅ RESPUESTA: La media es 8

🔍 VERIFICACIÓN: (4+7+9+12+8)/5 = 40/5 = 8 ✓`
  },
  {
    q: '📊 Problema de Estadística 2: Encuentra la mediana de: 3, 7, 2, 9, 5',
    a: `📝 DESARROLLO:
• Primero ordenamos: 2, 3, 5, 7, 9
• La mediana es el valor central (posición 3)
• Mediana = 5

✅ RESPUESTA: La mediana es 5

💡 CONCEPTO: Para datos impares, la mediana es el valor central ordenado`
  },
  {
    q: '📊 Problema de Estadística 3: ¿Cuál es la moda de: 2, 5, 3, 5, 7, 5, 8?',
    a: `📝 DESARROLLO:
• Contamos frecuencias: 2(1), 3(1), 5(3), 7(1), 8(1)
• El valor que más se repite es 5 (aparece 3 veces)

✅ RESPUESTA: La moda es 5

💡 CONCEPTO: La moda es el dato que aparece con mayor frecuencia`
  },
  {
    q: '📊 Problema de Estadística 4: Calcula el rango de: 15, 8, 22, 11, 19',
    a: `📝 DESARROLLO:
• Rango = valor máximo - valor mínimo
• Máximo = 22, Mínimo = 8
• Rango = 22 - 8 = 14

✅ RESPUESTA: El rango es 14

🔍 VERIFICACIÓN: 22 - 8 = 14 ✓`
  },
  {
    q: '📊 Problema de Estadística 5: Encuentra la mediana de: 4, 8, 2, 6',
    a: `📝 DESARROLLO:
• Ordenamos: 2, 4, 6, 8
• Hay 4 datos (par), tomamos los dos centrales: 4 y 6
• Mediana = (4 + 6) / 2 = 5

✅ RESPUESTA: La mediana es 5

💡 CONCEPTO: Para datos pares, la mediana es el promedio de los dos centrales`
  },
  {
    q: '📊 Problema de Estadística 6: En una clase, las notas fueron: 6, 5, 7, 6, 8, 6, 7. ¿Cuál es la media?',
    a: `📝 DESARROLLO:
• Suma = 6 + 5 + 7 + 6 + 8 + 6 + 7 = 45
• Cantidad = 7
• Media = 45 / 7 ≈ 6.43

✅ RESPUESTA: La media es aproximadamente 6.43

🔍 VERIFICACIÓN: 45 / 7 = 6.428... ≈ 6.43 ✓`
  },
  {
    q: '📊 Problema de Estadística 7: ¿Cuántas modas tiene: 1, 2, 2, 3, 3, 4?',
    a: `📝 DESARROLLO:
• Frecuencias: 1(1), 2(2), 3(2), 4(1)
• Tanto 2 como 3 aparecen 2 veces
• Hay DOS modas (bimodal)

✅ RESPUESTA: Hay 2 modas (2 y 3). Es bimodal.

💡 CONCEPTO: Un conjunto puede tener más de una moda`
  },
  {
    q: '📊 Problema de Estadística 8: Calcula la media ponderada: 7 (peso 2), 8 (peso 3), 9 (peso 1)',
    a: `📝 DESARROLLO:
• Media ponderada = Σ(valor × peso) / Σpesos
• = (7×2 + 8×3 + 9×1) / (2+3+1)
• = (14 + 24 + 9) / 6
• = 47 / 6 ≈ 7.83

✅ RESPUESTA: La media ponderada es aproximadamente 7.83

🔍 VERIFICACIÓN: 47 / 6 = 7.833... ✓`
  },
  {
    q: '📊 Problema de Estadística 9: Los datos son: 10, 12, 14, 16, 18. ¿Cuál es la media?',
    a: `📝 DESARROLLO:
• Suma = 10 + 12 + 14 + 16 + 18 = 70
• Cantidad = 5
• Media = 70 / 5 = 14

✅ RESPUESTA: La media es 14

💡 NOTA: En una secuencia aritmética, la media es igual al valor central`
  },
  {
    q: '📊 Problema de Estadística 10: ¿Cuál es el rango de las edades: 12, 15, 11, 18, 14?',
    a: `📝 DESARROLLO:
• Edad máxima = 18
• Edad mínima = 11
• Rango = 18 - 11 = 7

✅ RESPUESTA: El rango de edades es 7 años

🔍 VERIFICACIÓN: 18 - 11 = 7 ✓`
  },
  {
    q: '📊 Problema de Estadística 11: Calcula la varianza de: 2, 4, 6 (media = 4)',
    a: `📝 DESARROLLO:
• Varianza = Σ(xi - media)² / n
• = [(2-4)² + (4-4)² + (6-4)²] / 3
• = [4 + 0 + 4] / 3
• = 8 / 3 ≈ 2.67

✅ RESPUESTA: La varianza es aproximadamente 2.67

💡 CONCEPTO: La varianza mide la dispersión de los datos respecto a la media`
  },
  {
    q: '📊 Problema de Estadística 12: Si la varianza es 16, ¿cuál es la desviación estándar?',
    a: `📝 DESARROLLO:
• Desviación estándar = √varianza
• σ = √16 = 4

✅ RESPUESTA: La desviación estándar es 4

💡 CONCEPTO: La desviación estándar es la raíz cuadrada de la varianza`
  },
  {
    q: '📊 Problema de Estadística 13: En un conjunto, Q1=25, Q2=40, Q3=55. ¿Cuál es el rango intercuartílico?',
    a: `📝 DESARROLLO:
• Rango intercuartílico (IQR) = Q3 - Q1
• IQR = 55 - 25 = 30

✅ RESPUESTA: El rango intercuartílico es 30

💡 CONCEPTO: El IQR contiene el 50% central de los datos`
  },
  {
    q: '📊 Problema de Estadística 14: Las frecuencias son: A(5), B(8), C(12), D(5). ¿Cuál es la frecuencia total?',
    a: `📝 DESARROLLO:
• Frecuencia total = suma de todas las frecuencias
• = 5 + 8 + 12 + 5 = 30

✅ RESPUESTA: La frecuencia total es 30

🔍 VERIFICACIÓN: 5 + 8 + 12 + 5 = 30 ✓`
  },
  {
    q: '📊 Problema de Estadística 15: Calcula la frecuencia relativa de C si su frecuencia es 12 y el total es 30.',
    a: `📝 DESARROLLO:
• Frecuencia relativa = frecuencia / total
• = 12 / 30 = 0.4 = 40%

✅ RESPUESTA: La frecuencia relativa de C es 0.4 (o 40%)

🔍 VERIFICACIÓN: 12 / 30 = 0.4 ✓`
  }
];
// Aliases para estadística
mathProblemBanks['estadística'] = mathProblemBanks['estadistica'];

// =====================================================================
// PROBABILIDAD
// =====================================================================
mathProblemBanks['probabilidad'] = [
  {
    q: '🎲 Problema de Probabilidad 1: Al lanzar un dado, ¿cuál es la probabilidad de sacar un 6?',
    a: `📝 DESARROLLO:
• Casos favorables = 1 (solo el 6)
• Casos posibles = 6 (1, 2, 3, 4, 5, 6)
• P(6) = 1/6 ≈ 0.167

✅ RESPUESTA: P(6) = 1/6 ≈ 16.7%

💡 CONCEPTO: P(evento) = casos favorables / casos posibles`
  },
  {
    q: '🎲 Problema de Probabilidad 2: Al lanzar una moneda, ¿cuál es la probabilidad de obtener cara?',
    a: `📝 DESARROLLO:
• Casos favorables = 1 (cara)
• Casos posibles = 2 (cara o cruz)
• P(cara) = 1/2 = 0.5

✅ RESPUESTA: P(cara) = 1/2 = 50%

🔍 VERIFICACIÓN: Es un evento equiprobable ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 3: En una urna hay 3 bolas rojas y 7 azules. ¿Cuál es la probabilidad de sacar una roja?',
    a: `📝 DESARROLLO:
• Bolas rojas = 3 (casos favorables)
• Total de bolas = 3 + 7 = 10 (casos posibles)
• P(roja) = 3/10 = 0.3

✅ RESPUESTA: P(roja) = 3/10 = 30%

🔍 VERIFICACIÓN: 3/10 = 0.3 = 30% ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 4: Al lanzar un dado, ¿cuál es la probabilidad de sacar un número par?',
    a: `📝 DESARROLLO:
• Números pares en un dado: 2, 4, 6 (3 casos favorables)
• Casos posibles = 6
• P(par) = 3/6 = 1/2

✅ RESPUESTA: P(par) = 1/2 = 50%

🔍 VERIFICACIÓN: 3 de 6 resultados son pares ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 5: Si P(A) = 0.7, ¿cuál es P(no A)?',
    a: `📝 DESARROLLO:
• P(A) + P(no A) = 1 (eventos complementarios)
• P(no A) = 1 - P(A)
• P(no A) = 1 - 0.7 = 0.3

✅ RESPUESTA: P(no A) = 0.3 = 30%

💡 CONCEPTO: La suma de probabilidades complementarias es 1`
  },
  {
    q: '🎲 Problema de Probabilidad 6: En una baraja de 52 cartas, ¿cuál es la probabilidad de sacar un as?',
    a: `📝 DESARROLLO:
• Ases en la baraja = 4 (uno de cada palo)
• Total de cartas = 52
• P(as) = 4/52 = 1/13 ≈ 0.077

✅ RESPUESTA: P(as) = 1/13 ≈ 7.7%

🔍 VERIFICACIÓN: 4/52 = 1/13 ≈ 0.077 ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 7: Al lanzar dos dados, ¿cuántos resultados posibles hay?',
    a: `📝 DESARROLLO:
• Primer dado: 6 resultados posibles
• Segundo dado: 6 resultados posibles
• Total = 6 × 6 = 36 resultados

✅ RESPUESTA: Hay 36 resultados posibles

💡 CONCEPTO: Principio de multiplicación para eventos independientes`
  },
  {
    q: '🎲 Problema de Probabilidad 8: Si se lanzan dos monedas, ¿cuál es la probabilidad de obtener dos caras?',
    a: `📝 DESARROLLO:
• Resultados posibles: CC, CX, XC, XX (4 total)
• Casos favorables (CC) = 1
• P(dos caras) = 1/4 = 0.25

✅ RESPUESTA: P(dos caras) = 1/4 = 25%

🔍 VERIFICACIÓN: 1/4 = 0.25 = 25% ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 9: La probabilidad de lluvia es 0.3. ¿Cuál es la probabilidad de que NO llueva?',
    a: `📝 DESARROLLO:
• P(lluvia) + P(no lluvia) = 1
• P(no lluvia) = 1 - 0.3 = 0.7

✅ RESPUESTA: P(no lluvia) = 0.7 = 70%

💡 CONCEPTO: Eventos complementarios`
  },
  {
    q: '🎲 Problema de Probabilidad 10: En una ruleta con números del 1 al 10, ¿cuál es la probabilidad de sacar un número mayor que 7?',
    a: `📝 DESARROLLO:
• Números mayores que 7: 8, 9, 10 (3 casos)
• Total de números = 10
• P(>7) = 3/10 = 0.3

✅ RESPUESTA: P(mayor que 7) = 3/10 = 30%

🔍 VERIFICACIÓN: Solo 8, 9, 10 son mayores que 7 ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 11: Al lanzar un dado, ¿cuál es la probabilidad de sacar un número menor o igual a 4?',
    a: `📝 DESARROLLO:
• Números ≤ 4: 1, 2, 3, 4 (4 casos favorables)
• Casos posibles = 6
• P(≤4) = 4/6 = 2/3 ≈ 0.67

✅ RESPUESTA: P(≤4) = 2/3 ≈ 66.7%

🔍 VERIFICACIÓN: 4/6 = 2/3 ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 12: Si P(A) = 0.4 y P(B) = 0.3, y A y B son independientes, ¿cuál es P(A y B)?',
    a: `📝 DESARROLLO:
• Para eventos independientes: P(A y B) = P(A) × P(B)
• P(A y B) = 0.4 × 0.3 = 0.12

✅ RESPUESTA: P(A y B) = 0.12 = 12%

💡 CONCEPTO: Para eventos independientes, las probabilidades se multiplican`
  },
  {
    q: '🎲 Problema de Probabilidad 13: ¿Cuál es la probabilidad de sacar un rey de corazones de una baraja?',
    a: `📝 DESARROLLO:
• Solo hay 1 rey de corazones en la baraja
• Total de cartas = 52
• P(rey de corazones) = 1/52 ≈ 0.019

✅ RESPUESTA: P(rey de corazones) = 1/52 ≈ 1.9%

🔍 VERIFICACIÓN: Es un único evento de 52 posibles ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 14: En una bolsa hay 5 canicas verdes, 3 rojas y 2 azules. ¿Probabilidad de NO sacar verde?',
    a: `📝 DESARROLLO:
• Total = 5 + 3 + 2 = 10
• Canicas NO verdes = 3 + 2 = 5
• P(no verde) = 5/10 = 1/2

✅ RESPUESTA: P(no verde) = 1/2 = 50%

🔍 VERIFICACIÓN: 5 de 10 canicas no son verdes ✓`
  },
  {
    q: '🎲 Problema de Probabilidad 15: Al lanzar un dado, ¿cuál es la probabilidad de sacar 1 ó 6?',
    a: `📝 DESARROLLO:
• Casos favorables: 1 y 6 (2 casos)
• Casos posibles = 6
• P(1 ó 6) = 2/6 = 1/3 ≈ 0.33

✅ RESPUESTA: P(1 ó 6) = 1/3 ≈ 33.3%

💡 CONCEPTO: Para eventos mutuamente excluyentes, las probabilidades se suman`
  }
];

// =====================================================================
// ÁLGEBRA
// =====================================================================
mathProblemBanks['algebra'] = [
  {
    q: '🔢 Problema de Álgebra 1: Simplifica la expresión: 3x + 5x - 2x',
    a: `📝 DESARROLLO:
• Agrupamos términos semejantes (todos tienen x)
• 3x + 5x - 2x = (3 + 5 - 2)x = 6x

✅ RESPUESTA: 3x + 5x - 2x = 6x

💡 CONCEPTO: Suma de términos semejantes`
  },
  {
    q: '🔢 Problema de Álgebra 2: Resuelve: 2x + 7 = 15',
    a: `📝 DESARROLLO:
• Restamos 7 de ambos lados: 2x = 15 - 7 = 8
• Dividimos por 2: x = 8 / 2 = 4

✅ RESPUESTA: x = 4

🔍 VERIFICACIÓN: 2(4) + 7 = 8 + 7 = 15 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 3: Factoriza: x² - 9',
    a: `📝 DESARROLLO:
• Reconocemos diferencia de cuadrados: a² - b²
• x² - 9 = x² - 3²
• Fórmula: a² - b² = (a+b)(a-b)
• = (x + 3)(x - 3)

✅ RESPUESTA: x² - 9 = (x + 3)(x - 3)

🔍 VERIFICACIÓN: (x+3)(x-3) = x² - 3x + 3x - 9 = x² - 9 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 4: Si f(x) = 2x + 3, encuentra f(5)',
    a: `📝 DESARROLLO:
• Sustituimos x = 5 en la función
• f(5) = 2(5) + 3
• f(5) = 10 + 3 = 13

✅ RESPUESTA: f(5) = 13

🔍 VERIFICACIÓN: 2(5) + 3 = 13 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 5: Expande: (x + 4)²',
    a: `📝 DESARROLLO:
• Fórmula: (a + b)² = a² + 2ab + b²
• (x + 4)² = x² + 2(x)(4) + 4²
• = x² + 8x + 16

✅ RESPUESTA: (x + 4)² = x² + 8x + 16

🔍 VERIFICACIÓN: (x+4)(x+4) = x² + 4x + 4x + 16 = x² + 8x + 16 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 6: Resuelve: 3(x - 2) = 12',
    a: `📝 DESARROLLO:
• Dividimos por 3: x - 2 = 4
• Sumamos 2: x = 6

✅ RESPUESTA: x = 6

🔍 VERIFICACIÓN: 3(6 - 2) = 3(4) = 12 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 7: Simplifica: (4x²y) / (2xy)',
    a: `📝 DESARROLLO:
• Dividimos coeficientes: 4/2 = 2
• Restamos exponentes de x: x²/x = x
• Restamos exponentes de y: y/y = 1
• Resultado: 2x

✅ RESPUESTA: (4x²y) / (2xy) = 2x

💡 CONCEPTO: División de expresiones algebraicas`
  },
  {
    q: '🔢 Problema de Álgebra 8: Si 5x - 3 = 2x + 9, encuentra x',
    a: `📝 DESARROLLO:
• Restamos 2x: 3x - 3 = 9
• Sumamos 3: 3x = 12
• Dividimos por 3: x = 4

✅ RESPUESTA: x = 4

🔍 VERIFICACIÓN: 5(4) - 3 = 17, 2(4) + 9 = 17 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 9: Factoriza: 6x + 12',
    a: `📝 DESARROLLO:
• Encontramos el factor común: 6
• 6x + 12 = 6(x + 2)

✅ RESPUESTA: 6x + 12 = 6(x + 2)

🔍 VERIFICACIÓN: 6(x + 2) = 6x + 12 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 10: Resuelve: x/3 = 7',
    a: `📝 DESARROLLO:
• Multiplicamos ambos lados por 3
• x = 7 × 3 = 21

✅ RESPUESTA: x = 21

🔍 VERIFICACIÓN: 21/3 = 7 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 11: Expande: (2x - 3)(x + 5)',
    a: `📝 DESARROLLO:
• Usamos FOIL: (a+b)(c+d) = ac + ad + bc + bd
• = 2x(x) + 2x(5) + (-3)(x) + (-3)(5)
• = 2x² + 10x - 3x - 15
• = 2x² + 7x - 15

✅ RESPUESTA: (2x - 3)(x + 5) = 2x² + 7x - 15

🔍 VERIFICACIÓN: Multiplicando término a término ✓`
  },
  {
    q: '🔢 Problema de Álgebra 12: Resuelve: -2x + 8 = 0',
    a: `📝 DESARROLLO:
• Restamos 8: -2x = -8
• Dividimos por -2: x = 4

✅ RESPUESTA: x = 4

🔍 VERIFICACIÓN: -2(4) + 8 = -8 + 8 = 0 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 13: Si a = 3 y b = -2, calcula a² - 2ab + b²',
    a: `📝 DESARROLLO:
• a² = 3² = 9
• 2ab = 2(3)(-2) = -12
• b² = (-2)² = 4
• a² - 2ab + b² = 9 - (-12) + 4 = 9 + 12 + 4 = 25

✅ RESPUESTA: a² - 2ab + b² = 25

💡 NOTA: Esto es igual a (a - b)² = (3 - (-2))² = 5² = 25`
  },
  {
    q: '🔢 Problema de Álgebra 14: Simplifica: 5(2x - 1) - 3(x + 4)',
    a: `📝 DESARROLLO:
• Distribuimos: 10x - 5 - 3x - 12
• Agrupamos: (10x - 3x) + (-5 - 12)
• = 7x - 17

✅ RESPUESTA: 5(2x - 1) - 3(x + 4) = 7x - 17

🔍 VERIFICACIÓN: 10x - 5 - 3x - 12 = 7x - 17 ✓`
  },
  {
    q: '🔢 Problema de Álgebra 15: Resuelve: (x + 2)(x - 2) = 0',
    a: `📝 DESARROLLO:
• Por la propiedad del producto cero:
• x + 2 = 0 → x = -2
• x - 2 = 0 → x = 2

✅ RESPUESTA: x = -2 o x = 2

🔍 VERIFICACIÓN: (-2+2)(-2-2) = 0(-4) = 0 ✓, (2+2)(2-2) = 4(0) = 0 ✓`
  }
];
// Aliases para álgebra
mathProblemBanks['álgebra'] = mathProblemBanks['algebra'];

// =====================================================================
// FUNCIÓN PARA GENERAR PROBLEMAS DINÁMICOS ESPECÍFICOS DEL TEMA
// =====================================================================
function generateDynamicMathProblems(topic: string, topicCap: string): Array<{ q: string; a: string }> {
  const topicNorm = normalizeForMatch(topic);
  
  // Detectar tipo de tema y generar problemas apropiados
  // GEOMETRÍA - debe ir primero antes de otros matches
  if (topicNorm.includes('geometr') || topicNorm.includes('area') || topicNorm.includes('perimetro') || 
      topicNorm.includes('triangulo') || topicNorm.includes('rectangulo') || topicNorm.includes('circulo') ||
      topicNorm.includes('cuadrado') || topicNorm.includes('figura')) {
    if (mathProblemBanks['geometria basica'] && mathProblemBanks['geometria basica'].length > 0) {
      console.log('[generate-quiz] Usando banco de GEOMETRÍA para:', topic);
      return mathProblemBanks['geometria basica'];
    }
  }
  
  // TRIGONOMETRÍA
  if (topicNorm.includes('trigonometr') || topicNorm.includes('seno') || topicNorm.includes('coseno') || 
      topicNorm.includes('tangente') || topicNorm.includes('angulo') || topicNorm.includes('pitagoras')) {
    if (mathProblemBanks['trigonometria'] && mathProblemBanks['trigonometria'].length > 0) {
      console.log('[generate-quiz] Usando banco de TRIGONOMETRÍA para:', topic);
      return mathProblemBanks['trigonometria'];
    }
  }
  
  // ESTADÍSTICA
  if (topicNorm.includes('estadist') || topicNorm.includes('media') || topicNorm.includes('mediana') || 
      topicNorm.includes('moda') || topicNorm.includes('varianza') || topicNorm.includes('desviacion')) {
    if (mathProblemBanks['estadistica'] && mathProblemBanks['estadistica'].length > 0) {
      console.log('[generate-quiz] Usando banco de ESTADÍSTICA para:', topic);
      return mathProblemBanks['estadistica'];
    }
  }
  
  // PROBABILIDAD
  if (topicNorm.includes('probabilidad') || topicNorm.includes('azar') || topicNorm.includes('dado') || 
      topicNorm.includes('moneda') || topicNorm.includes('aleatorio')) {
    if (mathProblemBanks['probabilidad'] && mathProblemBanks['probabilidad'].length > 0) {
      console.log('[generate-quiz] Usando banco de PROBABILIDAD para:', topic);
      return mathProblemBanks['probabilidad'];
    }
  }
  
  // ÁLGEBRA
  if (topicNorm.includes('algebra') || topicNorm.includes('expresion') || topicNorm.includes('simplif') ||
      topicNorm.includes('factori') || topicNorm.includes('binomio')) {
    if (mathProblemBanks['algebra'] && mathProblemBanks['algebra'].length > 0) {
      console.log('[generate-quiz] Usando banco de ÁLGEBRA para:', topic);
      return mathProblemBanks['algebra'];
    }
  }
  
  if (topicNorm.includes('potencia') || topicNorm.includes('exponente')) {
    // Si llegamos aquí, es porque el banco de potencias no se encontró
    // Devolver el banco de potencias directamente
    if (mathProblemBanks['potencias'] && mathProblemBanks['potencias'].length > 0) {
      return mathProblemBanks['potencias'];
    }
  }
  
  if (topicNorm.includes('ecuacion') && topicNorm.includes('cuadrat')) {
    if (mathProblemBanks['ecuaciones cuadraticas'] && mathProblemBanks['ecuaciones cuadraticas'].length > 0) {
      return mathProblemBanks['ecuaciones cuadraticas'];
    }
  }
  
  if (topicNorm.includes('deriv')) {
    if (mathProblemBanks['derivadas'] && mathProblemBanks['derivadas'].length > 0) {
      return mathProblemBanks['derivadas'];
    }
  }
  
  if (topicNorm.includes('raiz') || topicNorm.includes('radical')) {
    if (mathProblemBanks['raices cuadradas'] && mathProblemBanks['raices cuadradas'].length > 0) {
      return mathProblemBanks['raices cuadradas'];
    }
  }
  
  if (topicNorm.includes('fraccion')) {
    if (mathProblemBanks['fracciones'] && mathProblemBanks['fracciones'].length > 0) {
      return mathProblemBanks['fracciones'];
    }
  }
  
  if (topicNorm.includes('ecuacion') && !topicNorm.includes('cuadrat')) {
    if (mathProblemBanks['ecuaciones'] && mathProblemBanks['ecuaciones'].length > 0) {
      return mathProblemBanks['ecuaciones'];
    }
  }
  
  // Para cualquier otro tema, generar problemas genéricos PERO con referencia al tema
  console.log('[generate-quiz] Generando problemas genéricos con referencia a:', topic);
  return [
    { 
      q: `🔢 Problema de ${topicCap} 1: Aplica los conceptos de ${topic} para resolver el siguiente ejercicio. Si x = 5, calcula 2x + 3.`, 
      a: `📝 DESARROLLO:
• Sustituimos x = 5 en la expresión
• 2(5) + 3 = 10 + 3 = 13

✅ RESPUESTA: 2x + 3 = 13 cuando x = 5

💡 CONCEPTO: Sustitución de valores en expresiones algebraicas relacionadas con ${topic}` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 2: En el contexto de ${topic}, resuelve: Si y = 3x y x = 4, ¿cuánto vale y?`, 
      a: `📝 DESARROLLO:
• Dado: y = 3x y x = 4
• Sustituimos: y = 3(4) = 12

✅ RESPUESTA: y = 12

🔍 VERIFICACIÓN: 3 × 4 = 12 ✓` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 3: Aplicando ${topic}, calcula el valor de 4² + 3².`, 
      a: `📝 DESARROLLO:
• 4² = 16
• 3² = 9
• 4² + 3² = 16 + 9 = 25

✅ RESPUESTA: 4² + 3² = 25

💡 NOTA: Observa que 25 = 5² (relación con teorema de Pitágoras)` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 4: En ${topic}, si a = 7 y b = 3, calcula a² - b².`, 
      a: `📝 DESARROLLO:
• a² - b² = 7² - 3² = 49 - 9 = 40
• También: a² - b² = (a+b)(a-b) = (10)(4) = 40

✅ RESPUESTA: a² - b² = 40

💡 CONCEPTO: Diferencia de cuadrados: a² - b² = (a+b)(a-b)` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 5: Resuelve aplicando ${topic}: x + 7 = 15. ¿Cuánto vale x?`, 
      a: `📝 DESARROLLO:
• Ecuación: x + 7 = 15
• Restamos 7 de ambos lados
• x = 15 - 7 = 8

✅ RESPUESTA: x = 8

🔍 VERIFICACIÓN: 8 + 7 = 15 ✓` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 6: En el estudio de ${topic}, calcula √144.`, 
      a: `📝 DESARROLLO:
• Buscamos un número que multiplicado por sí mismo dé 144
• 12 × 12 = 144

✅ RESPUESTA: √144 = 12

🔍 VERIFICACIÓN: 12² = 144 ✓` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 7: Aplicando conceptos de ${topic}, si un cuadrado tiene lado 6 cm, ¿cuál es su área?`, 
      a: `📝 DESARROLLO:
• Fórmula: Área = lado²
• Área = 6² = 36 cm²

✅ RESPUESTA: El área es 36 cm²

💡 CONCEPTO: Área de cuadrado = lado × lado = lado²` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 8: En ${topic}, simplifica la expresión 3x + 2x - 4x.`, 
      a: `📝 DESARROLLO:
• Agrupamos términos semejantes
• (3 + 2 - 4)x = 1x = x

✅ RESPUESTA: 3x + 2x - 4x = x

💡 CONCEPTO: Suma de términos semejantes` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 9: Usando ${topic}, resuelve 2x = 18. ¿Cuánto vale x?`, 
      a: `📝 DESARROLLO:
• Ecuación: 2x = 18
• Dividimos ambos lados entre 2
• x = 18 ÷ 2 = 9

✅ RESPUESTA: x = 9

🔍 VERIFICACIÓN: 2 × 9 = 18 ✓` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 10: Aplica ${topic} para calcular 5³.`, 
      a: `📝 DESARROLLO:
• 5³ = 5 × 5 × 5
• = 25 × 5
• = 125

✅ RESPUESTA: 5³ = 125

💡 TRUCO: 5³ significa "5 al cubo" o "5 multiplicado por sí mismo 3 veces"` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 11: En el contexto de ${topic}, ¿cuál es el 25% de 80?`, 
      a: `📝 DESARROLLO:
• 25% = 25/100 = 0.25 = 1/4
• 25% de 80 = 80 ÷ 4 = 20

✅ RESPUESTA: El 25% de 80 es 20

💡 TRUCO: 25% es igual a dividir entre 4` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 12: Usando conceptos de ${topic}, resuelve x - 9 = 21.`, 
      a: `📝 DESARROLLO:
• Ecuación: x - 9 = 21
• Sumamos 9 a ambos lados
• x = 21 + 9 = 30

✅ RESPUESTA: x = 30

🔍 VERIFICACIÓN: 30 - 9 = 21 ✓` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 13: En ${topic}, calcula el perímetro de un rectángulo de 8 cm × 5 cm.`, 
      a: `📝 DESARROLLO:
• Fórmula: Perímetro = 2(largo + ancho)
• P = 2(8 + 5) = 2(13) = 26 cm

✅ RESPUESTA: El perímetro es 26 cm

💡 CONCEPTO: Perímetro = suma de todos los lados` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 14: Aplicando ${topic}, si 3x + 5 = 20, ¿cuánto vale x?`, 
      a: `📝 DESARROLLO:
• 3x + 5 = 20
• 3x = 20 - 5 = 15
• x = 15 ÷ 3 = 5

✅ RESPUESTA: x = 5

🔍 VERIFICACIÓN: 3(5) + 5 = 15 + 5 = 20 ✓` 
    },
    { 
      q: `🔢 Problema de ${topicCap} 15: En el estudio de ${topic}, calcula 2⁴ × 2².`, 
      a: `📝 DESARROLLO:
• Usamos la regla: aᵐ × aⁿ = aᵐ⁺ⁿ
• 2⁴ × 2² = 2⁴⁺² = 2⁶
• 2⁶ = 64

✅ RESPUESTA: 2⁴ × 2² = 2⁶ = 64

💡 CONCEPTO: Al multiplicar potencias con la misma base, se suman los exponentes` 
    }
  ];
}

// Banco de contenido educativo por tema para generar cuestionarios específicos
const topicQuestionBanks: Record<string, Array<{ q: string; a: string }>> = {
  'sistema respiratorio': [
    { q: '¿Cuál es la función principal del sistema respiratorio?', a: 'La función principal del sistema respiratorio es permitir el intercambio de gases: incorporar oxígeno (O₂) del aire hacia la sangre y eliminar dióxido de carbono (CO₂) del cuerpo hacia el exterior.' },
    { q: '¿Cuáles son los órganos principales que componen el sistema respiratorio?', a: 'Los órganos principales son: nariz, faringe, laringe, tráquea, bronquios y pulmones. También incluye estructuras como los alvéolos pulmonares y el diafragma.' },
    { q: '¿Qué son los alvéolos y cuál es su función?', a: 'Los alvéolos son pequeños sacos de aire ubicados al final de los bronquiolos en los pulmones. Su función es realizar el intercambio gaseoso: el oxígeno pasa a la sangre y el CO₂ pasa al aire para ser exhalado.' },
    { q: '¿Cómo funciona el proceso de inhalación?', a: 'Durante la inhalación, el diafragma se contrae y desciende, los músculos intercostales elevan las costillas, aumentando el volumen de la cavidad torácica. Esto crea una presión negativa que hace que el aire entre a los pulmones.' },
    { q: '¿Cómo funciona el proceso de exhalación?', a: 'Durante la exhalación, el diafragma se relaja y sube, los músculos intercostales se relajan y las costillas bajan. El volumen torácico disminuye, aumentando la presión interna y expulsando el aire de los pulmones.' },
    { q: '¿Qué función cumple la nariz en el sistema respiratorio?', a: 'La nariz filtra, calienta y humedece el aire que respiramos. Los vellos nasales y el moco atrapan partículas de polvo, bacterias y otros contaminantes, protegiendo los pulmones.' },
    { q: '¿Cuál es la función de la tráquea?', a: 'La tráquea es un tubo formado por anillos de cartílago que conecta la laringe con los bronquios. Su función es conducir el aire hacia los pulmones y mantener la vía aérea abierta.' },
    { q: '¿Qué es el diafragma y por qué es importante para la respiración?', a: 'El diafragma es un músculo con forma de cúpula ubicado debajo de los pulmones. Es el músculo principal de la respiración; su contracción y relajación permiten la entrada y salida de aire de los pulmones.' },
    { q: '¿Cuál es la diferencia entre respiración pulmonar y respiración celular?', a: 'La respiración pulmonar es el intercambio de gases en los pulmones (O₂ entra, CO₂ sale). La respiración celular ocurre en las células, donde se usa el O₂ para obtener energía de los nutrientes y se produce CO₂ como desecho.' },
    { q: '¿Qué enfermedades pueden afectar al sistema respiratorio?', a: 'Algunas enfermedades comunes son: asma (inflamación de las vías respiratorias), bronquitis (inflamación de los bronquios), neumonía (infección de los pulmones), gripe y resfriado común.' },
    { q: '¿Por qué es importante respirar por la nariz y no por la boca?', a: 'Respirar por la nariz es importante porque el aire se filtra, calienta y humedece antes de llegar a los pulmones. La boca no tiene estas funciones protectoras, lo que puede causar irritación o infecciones.' },
    { q: '¿Cómo se relaciona el sistema respiratorio con el sistema circulatorio?', a: 'Ambos sistemas trabajan juntos: el sistema respiratorio capta el O₂ y lo transfiere a la sangre en los alvéolos. El sistema circulatorio transporta ese O₂ a todas las células del cuerpo y recoge el CO₂ para eliminarlo por los pulmones.' },
    { q: '¿Qué ocurre si no respiramos correctamente durante varios minutos?', a: 'Si no respiramos, las células no reciben oxígeno y no pueden producir energía. Esto causa daño celular, especialmente en el cerebro, y puede provocar pérdida de consciencia y, si se prolonga, la muerte.' },
    { q: '¿Qué hábitos ayudan a mantener sano el sistema respiratorio?', a: 'Hábitos saludables incluyen: no fumar, hacer ejercicio regularmente, evitar la contaminación del aire, lavarse las manos frecuentemente para prevenir infecciones y mantener buena ventilación en espacios cerrados.' },
    { q: '¿Cuántas veces aproximadamente respiramos por minuto en reposo?', a: 'Un adulto en reposo respira aproximadamente entre 12 y 20 veces por minuto. Los niños respiran más rápido, entre 20 y 30 veces por minuto. Durante el ejercicio, la frecuencia respiratoria aumenta.' },
  ],
  'célula': [
    { q: '¿Qué es una célula?', a: 'La célula es la unidad básica estructural y funcional de todos los seres vivos. Es la parte más pequeña de un organismo que puede realizar todas las funciones vitales como nutrición, relación y reproducción.' },
    { q: '¿Cuáles son las partes principales de una célula?', a: 'Las partes principales son: membrana celular (protege y regula el paso de sustancias), citoplasma (gel donde flotan los orgánulos) y núcleo (contiene el material genético ADN). Las células vegetales también tienen pared celular y cloroplastos.' },
    { q: '¿Cuál es la diferencia entre célula animal y célula vegetal?', a: 'La célula vegetal tiene pared celular (rigidez), cloroplastos (fotosíntesis) y una gran vacuola central. La célula animal no tiene estas estructuras, pero posee centriolos y vacuolas más pequeñas.' },
    { q: '¿Qué función cumple el núcleo de la célula?', a: 'El núcleo es el centro de control de la célula. Contiene el ADN con la información genética que dirige todas las actividades celulares y permite la reproducción celular.' },
    { q: '¿Qué es la membrana celular y cuál es su función?', a: 'La membrana celular es una capa delgada que rodea la célula. Su función es proteger la célula y controlar qué sustancias entran y salen, actuando como una barrera selectiva.' },
    { q: '¿Qué son las mitocondrias y para qué sirven?', a: 'Las mitocondrias son orgánulos llamados "centrales de energía" de la célula. Realizan la respiración celular, transformando los nutrientes en energía (ATP) que la célula puede usar.' },
    { q: '¿Qué función cumplen los cloroplastos?', a: 'Los cloroplastos son orgánulos presentes solo en células vegetales. Contienen clorofila y realizan la fotosíntesis, convirtiendo luz solar, agua y CO₂ en glucosa y oxígeno.' },
    { q: '¿Qué es el citoplasma?', a: 'El citoplasma es una sustancia gelatinosa que llena el interior de la célula, entre la membrana y el núcleo. En él flotan los orgánulos y ocurren muchas reacciones químicas importantes.' },
    { q: '¿Qué tipos de células existen según su complejidad?', a: 'Existen células procariotas (simples, sin núcleo definido, como las bacterias) y células eucariotas (más complejas, con núcleo y orgánulos, como las de animales, plantas y hongos).' },
    { q: '¿Cómo se reproducen las células?', a: 'Las células se reproducen por división celular. La mitosis produce dos células hijas idénticas a la original. La meiosis (en células reproductoras) produce células con la mitad del material genético.' },
    { q: '¿Por qué se dice que la célula es la unidad de vida?', a: 'Porque todos los seres vivos están formados por células. Incluso los organismos más simples tienen al menos una célula. Además, las células realizan todas las funciones vitales necesarias para la vida.' },
    { q: '¿Qué es el ADN y dónde se encuentra?', a: 'El ADN (ácido desoxirribonucleico) es la molécula que contiene la información genética. Se encuentra en el núcleo de las células eucariotas, organizado en estructuras llamadas cromosomas.' },
    { q: '¿Qué función cumple el retículo endoplasmático?', a: 'El retículo endoplasmático es una red de membranas en el citoplasma. El RE rugoso (con ribosomas) sintetiza proteínas; el RE liso sintetiza lípidos y ayuda a eliminar toxinas.' },
    { q: '¿Qué son los ribosomas?', a: 'Los ribosomas son pequeños orgánulos que fabrican proteínas. Leen las instrucciones del ADN (copiadas en el ARN) y ensamblan los aminoácidos para formar las proteínas que la célula necesita.' },
    { q: '¿Qué es el aparato de Golgi?', a: 'El aparato de Golgi es un orgánulo formado por sacos aplanados. Recibe proteínas del RE, las modifica, empaqueta y las envía a su destino final dentro o fuera de la célula.' },
  ],
  'fotosíntesis': [
    { q: '¿Qué es la fotosíntesis?', a: 'La fotosíntesis es el proceso mediante el cual las plantas, algas y algunas bacterias transforman la energía luminosa del sol en energía química (glucosa), utilizando agua y dióxido de carbono, y liberando oxígeno.' },
    { q: '¿Cuál es la ecuación general de la fotosíntesis?', a: 'La ecuación es: 6CO₂ + 6H₂O + luz solar → C₆H₁₂O₆ + 6O₂. Es decir, seis moléculas de dióxido de carbono más seis de agua, con luz, producen una molécula de glucosa y seis de oxígeno.' },
    { q: '¿Dónde ocurre la fotosíntesis en las plantas?', a: 'La fotosíntesis ocurre principalmente en las hojas, dentro de orgánulos llamados cloroplastos. Los cloroplastos contienen clorofila, el pigmento verde que captura la luz solar.' },
    { q: '¿Qué es la clorofila y cuál es su función?', a: 'La clorofila es un pigmento verde presente en los cloroplastos. Su función es absorber la luz solar (principalmente luz roja y azul) y convertirla en energía química para la fotosíntesis.' },
    { q: '¿Cuáles son los reactivos (ingredientes) de la fotosíntesis?', a: 'Los reactivos son: dióxido de carbono (CO₂), que entra por los estomas de las hojas; agua (H₂O), que sube por las raíces y el tallo; y luz solar, que es captada por la clorofila.' },
    { q: '¿Cuáles son los productos de la fotosíntesis?', a: 'Los productos son: glucosa (C₆H₁₂O₆), un azúcar que la planta usa como fuente de energía y para construir estructuras; y oxígeno (O₂), que se libera a la atmósfera por los estomas.' },
    { q: '¿Por qué la fotosíntesis es importante para la vida en la Tierra?', a: 'Es importante porque produce el oxígeno que respiran la mayoría de los seres vivos y es la base de las cadenas alimenticias, ya que las plantas producen el alimento que luego consumen los animales.' },
    { q: '¿Qué son los estomas?', a: 'Los estomas son pequeños poros en la superficie de las hojas. Permiten el intercambio de gases: el CO₂ entra para la fotosíntesis y el O₂ y vapor de agua salen. Se abren y cierran según las condiciones.' },
    { q: '¿Qué factores afectan la velocidad de la fotosíntesis?', a: 'Los factores principales son: intensidad de la luz (más luz, más fotosíntesis hasta un límite), concentración de CO₂, temperatura (óptima entre 25-35°C) y disponibilidad de agua.' },
    { q: '¿Cuál es la diferencia entre la fase luminosa y la fase oscura de la fotosíntesis?', a: 'La fase luminosa ocurre en presencia de luz, en los tilacoides, donde se capta energía y se produce ATP y O₂. La fase oscura (ciclo de Calvin) ocurre en el estroma y usa ATP para fijar CO₂ y formar glucosa.' },
    { q: '¿Qué pasaría si no existiera la fotosíntesis?', a: 'Sin fotosíntesis no habría oxígeno en la atmósfera para respirar, ni alimentos para los herbívoros. La vida como la conocemos no podría existir, ya que la fotosíntesis sostiene las cadenas tróficas.' },
    { q: '¿Las plantas también respiran?', a: 'Sí, las plantas respiran todo el tiempo (día y noche), consumiendo O₂ y liberando CO₂. La fotosíntesis solo ocurre con luz y produce más O₂ del que consumen, por eso liberan oxígeno durante el día.' },
    { q: '¿Por qué las hojas son generalmente verdes?', a: 'Las hojas son verdes porque la clorofila refleja la luz verde y absorbe las luces roja y azul. El color verde que vemos es la luz que no se utiliza para la fotosíntesis.' },
    { q: '¿Pueden hacer fotosíntesis organismos que no son plantas?', a: 'Sí, las algas y algunas bacterias (cianobacterias) también realizan fotosíntesis. Estos organismos también tienen clorofila u otros pigmentos fotosintéticos y contribuyen significativamente al oxígeno atmosférico.' },
    { q: '¿Qué rol juegan las hojas en la fotosíntesis?', a: 'Las hojas son el órgano principal de la fotosíntesis. Su forma plana maximiza la captura de luz, los estomas permiten el intercambio de gases, y las nervaduras transportan agua y nutrientes.' },
  ],
  'fracciones': [
    { q: '¿Qué es una fracción?', a: 'Una fracción es una forma de representar partes de un todo. Se escribe con dos números separados por una línea: el numerador (arriba) indica cuántas partes tenemos, y el denominador (abajo) indica en cuántas partes se dividió el todo.' },
    { q: '¿Cuáles son las partes de una fracción?', a: 'Las partes son: el numerador (número superior, indica las partes que se toman) y el denominador (número inferior, indica en cuántas partes iguales se divide la unidad). Por ejemplo, en 3/4, el 3 es el numerador y el 4 es el denominador.' },
    { q: '¿Qué significa la fracción 1/2?', a: 'La fracción 1/2 (un medio) significa que un todo se dividió en 2 partes iguales y se toma 1 de esas partes. Es equivalente a la mitad del total, o al 50%.' },
    { q: '¿Cómo se comparan dos fracciones con el mismo denominador?', a: 'Cuando dos fracciones tienen el mismo denominador, se comparan sus numeradores. La fracción con mayor numerador es la mayor. Por ejemplo: 5/8 > 3/8 porque 5 > 3.' },
    { q: '¿Cómo se suman fracciones con el mismo denominador?', a: 'Para sumar fracciones con igual denominador, se suman los numeradores y se mantiene el mismo denominador. Ejemplo: 2/5 + 1/5 = 3/5.' },
    { q: '¿Cómo se restan fracciones con el mismo denominador?', a: 'Para restar fracciones con igual denominador, se restan los numeradores y se mantiene el denominador. Ejemplo: 4/7 - 2/7 = 2/7.' },
    { q: '¿Qué son fracciones equivalentes?', a: 'Las fracciones equivalentes son fracciones que representan la misma cantidad aunque tengan números diferentes. Por ejemplo: 1/2 = 2/4 = 4/8. Se obtienen multiplicando o dividiendo numerador y denominador por el mismo número.' },
    { q: '¿Cómo se simplifica una fracción?', a: 'Para simplificar una fracción, se divide el numerador y el denominador por el mismo número (su máximo común divisor). Ejemplo: 6/8 se simplifica dividiendo ambos entre 2, quedando 3/4.' },
    { q: '¿Qué es una fracción propia?', a: 'Una fracción propia es aquella donde el numerador es menor que el denominador. Su valor es menor que 1. Ejemplos: 1/2, 3/4, 2/5.' },
    { q: '¿Qué es una fracción impropia?', a: 'Una fracción impropia es aquella donde el numerador es mayor o igual que el denominador. Su valor es mayor o igual a 1. Ejemplo: 5/3 (que equivale a 1 entero y 2/3).' },
    { q: '¿Qué es un número mixto?', a: 'Un número mixto combina un número entero con una fracción propia. Ejemplo: 2 1/4 significa 2 enteros más 1/4. Se puede convertir a fracción impropia: 2 1/4 = 9/4.' },
    { q: '¿Cómo se convierte una fracción impropia a número mixto?', a: 'Se divide el numerador entre el denominador. El cociente es la parte entera, el residuo es el nuevo numerador, y el denominador se mantiene. Ejemplo: 11/4 = 2 3/4 (11÷4=2 con residuo 3).' },
    { q: '¿Cómo se multiplican dos fracciones?', a: 'Para multiplicar fracciones, se multiplican los numeradores entre sí y los denominadores entre sí. Ejemplo: 2/3 × 4/5 = (2×4)/(3×5) = 8/15.' },
    { q: '¿Cómo se representa una fracción en una recta numérica?', a: 'Primero se divide el segmento entre 0 y 1 en partes iguales según el denominador. Luego se cuenta desde 0 tantas partes como indica el numerador. Ejemplo: 3/4 está en la tercera marca de un segmento dividido en 4.' },
    { q: 'Da un ejemplo de fracción en la vida cotidiana.', a: 'Ejemplos cotidianos: una pizza dividida en 8 pedazos (cada pedazo es 1/8), media hora es 1/2 de hora, un cuarto de litro de leche es 1/4 de litro.' },
  ],
  'animales': [
    { q: '¿Cómo se clasifican los animales según su alimentación?', a: 'Según su alimentación, los animales se clasifican en: herbívoros (comen plantas), carnívoros (comen otros animales) y omnívoros (comen plantas y animales).' },
    { q: '¿Qué características distinguen a los animales vertebrados de los invertebrados?', a: 'Los vertebrados tienen columna vertebral y esqueleto interno (peces, anfibios, reptiles, aves, mamíferos). Los invertebrados no tienen columna vertebral (insectos, arañas, gusanos, moluscos, medusas).' },
    { q: '¿Cuáles son los cinco grupos de animales vertebrados?', a: 'Los cinco grupos son: peces (acuáticos, respiran por branquias), anfibios (piel húmeda, metamorfosis), reptiles (piel escamosa, huevos en tierra), aves (plumas, ponen huevos) y mamíferos (pelo, amamantan a sus crías).' },
    { q: '¿Qué son los animales ovíparos y cuáles son vivíparos?', a: 'Los ovíparos nacen de huevos puestos fuera del cuerpo de la madre (aves, reptiles, peces). Los vivíparos nacen del vientre de la madre y se alimentaron a través de la placenta (la mayoría de mamíferos).' },
    { q: '¿Cómo respiran los peces?', a: 'Los peces respiran por branquias. El agua entra por la boca, pasa por las branquias donde el oxígeno disuelto pasa a la sangre, y el agua sale por las aberturas branquiales.' },
    { q: '¿Qué es la metamorfosis en los animales?', a: 'La metamorfosis es el proceso de transformación física que sufren algunos animales desde que nacen hasta ser adultos. Por ejemplo, la rana pasa de huevo a renacuajo (con cola y branquias) a rana adulta (con patas y pulmones).' },
    { q: '¿Por qué las aves pueden volar?', a: 'Las aves pueden volar gracias a: huesos huecos y livianos, alas con plumas especializadas, músculos pectorales fuertes, y un sistema respiratorio muy eficiente con sacos aéreos.' },
    { q: '¿Qué características tienen los mamíferos?', a: 'Los mamíferos tienen: pelo o pelaje, glándulas mamarias que producen leche para alimentar a sus crías, son de sangre caliente, respiran por pulmones, y la mayoría son vivíparos.' },
    { q: '¿Qué son los animales de sangre fría y cuáles de sangre caliente?', a: 'Los de sangre fría (poiquilotermos) como peces, anfibios y reptiles, dependen del ambiente para regular su temperatura. Los de sangre caliente (homeotermos) como aves y mamíferos mantienen temperatura corporal constante.' },
    { q: '¿Cuáles son algunos ejemplos de animales invertebrados?', a: 'Ejemplos de invertebrados: insectos (hormigas, mariposas), arácnidos (arañas, escorpiones), moluscos (caracoles, pulpos), crustáceos (cangrejos, camarones), gusanos y medusas.' },
    { q: '¿Cómo se desplazan los diferentes animales?', a: 'Los animales se desplazan de diversas formas: caminando o corriendo (perros, caballos), volando (aves, murciélagos, insectos), nadando (peces, delfines), reptando (serpientes), saltando (ranas, canguros).' },
    { q: '¿Qué son los animales domésticos y los silvestres?', a: 'Los animales domésticos viven con los humanos y dependen de ellos (perros, gatos, vacas). Los animales silvestres viven en la naturaleza sin depender de humanos (leones, águilas, tiburones).' },
    { q: '¿Por qué algunos animales están en peligro de extinción?', a: 'Las principales causas son: destrucción de su hábitat, caza excesiva, contaminación, cambio climático e introducción de especies invasoras. Ejemplos: panda, tigre, rinoceronte.' },
    { q: '¿Qué es un ecosistema y qué rol cumplen los animales?', a: 'Un ecosistema es un sistema formado por seres vivos y su ambiente. Los animales cumplen roles como consumidores (herbívoros y carnívoros), descomponedores, polinizadores, y dispersores de semillas.' },
    { q: '¿Cómo se reproducen los animales?', a: 'La mayoría de animales se reproduce sexualmente (unión de gametos masculino y femenino). Pueden ser ovíparos (huevos), vivíparos (crías vivas) u ovovivíparos (huevos que eclosionan dentro de la madre).' },
  ],
  'plantas': [
    { q: '¿Cuáles son las partes principales de una planta?', a: 'Las partes principales son: raíz (absorbe agua y nutrientes, ancla la planta), tallo (sostiene la planta y transporta sustancias), hojas (realizan fotosíntesis), flores (reproducción), frutos y semillas (dispersión).' },
    { q: '¿Qué función cumple la raíz de una planta?', a: 'La raíz absorbe agua y sales minerales del suelo, ancla la planta al sustrato, y en algunas plantas almacena nutrientes (como en la zanahoria o la remolacha).' },
    { q: '¿Qué función cumple el tallo?', a: 'El tallo sostiene las hojas, flores y frutos, transporta agua y nutrientes desde las raíces hacia las hojas (xilema) y los azúcares de las hojas al resto de la planta (floema).' },
    { q: '¿Qué función cumplen las hojas?', a: 'Las hojas realizan la fotosíntesis (producen alimento usando luz solar), la respiración (intercambio de gases) y la transpiración (liberación de vapor de agua).' },
    { q: '¿Cómo se reproducen las plantas con flores?', a: 'Las plantas con flores se reproducen sexualmente: el polen (gameto masculino) fertiliza el óvulo (gameto femenino) en la flor. Esto produce semillas dentro del fruto, que al germinar dan nuevas plantas.' },
    { q: '¿Qué es la germinación?', a: 'La germinación es el proceso por el cual una semilla se desarrolla hasta convertirse en una plántula. Requiere agua, temperatura adecuada y oxígeno. La semilla absorbe agua, se hincha, rompe su cubierta y emerge la raíz y el tallo.' },
    { q: '¿Qué necesitan las plantas para vivir?', a: 'Las plantas necesitan: luz solar (para fotosíntesis), agua (para transporte y reacciones químicas), dióxido de carbono (para fotosíntesis), nutrientes del suelo (sales minerales) y temperatura adecuada.' },
    { q: '¿Por qué las plantas son importantes para el planeta?', a: 'Las plantas producen el oxígeno que respiramos, son la base de las cadenas alimenticias, regulan el clima, previenen la erosión del suelo, y proporcionan alimentos, medicinas y materiales.' },
    { q: '¿Qué diferencia hay entre plantas terrestres y acuáticas?', a: 'Las plantas terrestres tienen raíces desarrolladas, tallos rígidos y sistemas para evitar pérdida de agua. Las acuáticas tienen tejidos menos rígidos, raíces pequeñas o ausentes, y estructuras flotantes.' },
    { q: '¿Qué es la polinización?', a: 'La polinización es el transporte del polen desde los estambres (parte masculina) hasta el pistilo (parte femenina) de una flor. Puede ser por viento, agua, insectos, aves u otros animales.' },
    { q: '¿Qué son las plantas angiospermas y gimnospermas?', a: 'Las angiospermas producen flores y frutos que protegen las semillas (manzanos, rosales). Las gimnospermas tienen semillas desnudas, sin fruto, generalmente en conos (pinos, abetos).' },
    { q: '¿Cómo se adaptan las plantas al desierto?', a: 'Las plantas del desierto (xerófitas) tienen: hojas pequeñas o espinas para reducir pérdida de agua, tallos que almacenan agua (cactus), raíces profundas o extensas, y cutículas gruesas.' },
    { q: '¿Qué es la savia y qué tipos existen?', a: 'La savia es el líquido que circula por la planta. La savia bruta (agua y minerales) sube por el xilema desde las raíces. La savia elaborada (azúcares de la fotosíntesis) baja por el floema a toda la planta.' },
    { q: '¿Qué son los tropismos en las plantas?', a: 'Los tropismos son movimientos de crecimiento de la planta en respuesta a estímulos. Fototropismo: hacia la luz. Geotropismo: las raíces hacia abajo (gravedad). Hidrotropismo: hacia el agua.' },
    { q: '¿Qué utilidades tienen las plantas para el ser humano?', a: 'Las plantas nos proporcionan: alimentos (frutas, verduras, cereales), medicinas, madera, papel, fibras textiles (algodón), oxígeno, combustibles, y embellecen el ambiente.' },
  ],
};

// Obtener preguntas específicas por tema o usar genéricas
function getTopicQuestions(topic: string, isSpanish: boolean, bookTitle?: string): Array<{ q: string; a: string }> {
  const topicLower = topic.toLowerCase().trim();
  const topicNorm = normalizeForMatch(topic);
  
  // PRIMERO: Verificar si es matemáticas y hay problemas específicos
  if (isMathSubject(bookTitle || '', topic)) {
    // Buscar en el banco de problemas matemáticos con múltiples estrategias de coincidencia
    // 1. Coincidencia exacta primero
    if (mathProblemBanks[topicLower] && mathProblemBanks[topicLower].length > 0) {
      console.log('[generate-quiz] ✅ Coincidencia EXACTA en banco de matemáticas para:', topicLower);
      return mathProblemBanks[topicLower];
    }
    
    // 2. Buscar por coincidencia normalizada
    for (const [key, problems] of Object.entries(mathProblemBanks)) {
      if (!problems || problems.length === 0) continue;
      const keyNorm = normalizeForMatch(key);
      // Coincidencia exacta normalizada
      if (topicNorm === keyNorm) {
        console.log('[generate-quiz] ✅ Coincidencia normalizada en banco de matemáticas para:', key);
        return problems;
      }
    }
    
    // 3. Buscar por contenido parcial (más flexible)
    for (const [key, problems] of Object.entries(mathProblemBanks)) {
      if (!problems || problems.length === 0) continue;
      const keyNorm = normalizeForMatch(key);
      // El tema contiene la clave o viceversa (pero evitar coincidencias muy cortas)
      if (keyNorm.length >= 4 && (topicNorm.includes(keyNorm) || keyNorm.includes(topicNorm))) {
        console.log('[generate-quiz] ✅ Coincidencia parcial en banco de matemáticas para:', key);
        return problems;
      }
    }
    
    // 4. Buscar por palabras clave del tema
    const topicWords = topicNorm.split(/\s+/).filter(w => w.length >= 4);
    for (const [key, problems] of Object.entries(mathProblemBanks)) {
      if (!problems || problems.length === 0) continue;
      const keyNorm = normalizeForMatch(key);
      for (const word of topicWords) {
        if (keyNorm.includes(word) || word.includes(keyNorm)) {
          console.log('[generate-quiz] ✅ Coincidencia por palabra clave en banco de matemáticas:', key, '(palabra:', word, ')');
          return problems;
        }
      }
    }
    
    // FALLBACK PARA MATEMÁTICAS: Generar problemas ESPECÍFICOS del tema solicitado
    // NO usar problemas genéricos mezclados - crear problemas dinámicos del tema
    console.log('[generate-quiz] ⚠️ No hay banco específico para:', topic, '- Generando problemas dinámicos del tema');
    const topicCap = capitalizeFirstLetter(topic);
    
    // Generar problemas específicos según el tema detectado
    return generateDynamicMathProblems(topic, topicCap);
  }
  
  // SEGUNDO: Buscar coincidencia exacta o parcial en banco general
  for (const [key, questions] of Object.entries(topicQuestionBanks)) {
    const keyNorm = normalizeForMatch(key);
    if (topicNorm.includes(keyNorm) || keyNorm.includes(topicNorm)) {
      return questions;
    }
  }
  
  // Si no hay tema específico, generar preguntas genéricas mejoradas
  const topicCap = capitalizeFirstLetter(topic);
  return isSpanish ? [
    { q: `¿Qué es ${topic} y por qué es importante estudiarlo?`, a: `${topicCap} es un tema fundamental que permite comprender conceptos esenciales. Su estudio desarrolla habilidades de análisis y comprensión del mundo que nos rodea.` },
    { q: `¿Cuáles son los conceptos principales de ${topic}?`, a: `Los conceptos principales incluyen las definiciones básicas, las características distintivas, los ejemplos más representativos y las aplicaciones prácticas en situaciones reales.` },
    { q: `¿Cómo se relaciona ${topic} con la vida cotidiana?`, a: `${topicCap} tiene aplicaciones directas en la vida diaria. Comprender este tema nos ayuda a tomar mejores decisiones y entender fenómenos que observamos regularmente.` },
    { q: `Describe las características más importantes de ${topic}.`, a: `Las características más importantes incluyen sus propiedades fundamentales, cómo se identifica, sus componentes principales y qué lo diferencia de conceptos similares.` },
    { q: `Menciona y explica tres ejemplos relacionados con ${topic}.`, a: `Ejemplos relevantes pueden incluir casos del entorno escolar, situaciones familiares y fenómenos naturales observables, cada uno demostrando aspectos diferentes del tema.` },
    { q: `¿Por qué es importante conocer sobre ${topic}?`, a: `Conocer sobre ${topic} es importante porque desarrolla el pensamiento crítico, permite resolver problemas reales y facilita la comprensión de temas más avanzados relacionados.` },
    { q: `¿Cómo explicarías ${topic} a alguien que no lo conoce?`, a: `Para explicar ${topic} de forma clara, se debe partir de ideas simples, usar ejemplos concretos y cotidianos, y relacionarlo con experiencias que la persona ya conoce.` },
    { q: `¿Qué preguntas te surgen al estudiar ${topic}?`, a: `Al estudiar este tema pueden surgir preguntas sobre su origen, cómo funciona, para qué sirve, cómo se aplica, y cómo se relaciona con otros conocimientos previos.` },
    { q: `Compara ${topic} con otro tema que hayas estudiado.`, a: `Al comparar temas se pueden identificar similitudes en sus principios básicos, diferencias en sus aplicaciones, y conexiones que enriquecen la comprensión de ambos.` },
    { q: `¿Cuál es la idea más importante que aprendiste sobre ${topic}?`, a: `La idea más importante es comprender los fundamentos del tema, reconocer su utilidad práctica y ser capaz de aplicar este conocimiento en situaciones nuevas.` },
    { q: `¿Cómo puedes aplicar lo aprendido sobre ${topic}?`, a: `Este conocimiento se puede aplicar en actividades escolares, proyectos personales, resolución de problemas cotidianos y en la comprensión de noticias o información relacionada.` },
    { q: `Resume con tus propias palabras qué es ${topic}.`, a: `Un buen resumen debe incluir una definición clara, las características principales, por qué es importante y uno o dos ejemplos que ilustren el concepto.` },
    { q: `¿Qué dificultades encontraste al estudiar ${topic}?`, a: `Las dificultades comunes incluyen entender la terminología nueva, conectar diferentes conceptos entre sí, y visualizar cómo se aplica el conocimiento en la práctica.` },
    { q: `¿Qué más te gustaría aprender sobre ${topic}?`, a: `Se puede profundizar estudiando casos especiales, investigando la historia del tema, explorando aplicaciones avanzadas y descubriendo temas relacionados.` },
    { q: `Crea un ejemplo original relacionado con ${topic}.`, a: `Un buen ejemplo original debe demostrar comprensión del tema, ser relevante y aplicable, y mostrar correctamente los conceptos aprendidos en una situación nueva.` },
  ] : [
    { q: `What is ${topic} and why is it important to study?`, a: `${topicCap} is a fundamental topic that helps understand essential concepts. Studying it develops analysis skills and understanding of the world around us.` },
    { q: `What are the main concepts of ${topic}?`, a: `The main concepts include basic definitions, distinctive characteristics, representative examples, and practical applications in real situations.` },
    { q: `How does ${topic} relate to everyday life?`, a: `${topicCap} has direct applications in daily life. Understanding this topic helps us make better decisions and comprehend phenomena we observe regularly.` },
    { q: `Describe the most important characteristics of ${topic}.`, a: `The most important characteristics include its fundamental properties, how it is identified, its main components, and what differentiates it from similar concepts.` },
    { q: `Mention and explain three examples related to ${topic}.`, a: `Relevant examples can include cases from school, family situations, and observable natural phenomena, each demonstrating different aspects of the topic.` },
    { q: `Why is it important to know about ${topic}?`, a: `Knowing about ${topic} is important because it develops critical thinking, allows solving real problems, and facilitates understanding of related advanced topics.` },
    { q: `How would you explain ${topic} to someone unfamiliar with it?`, a: `To explain ${topic} clearly, start with simple ideas, use concrete everyday examples, and relate it to experiences the person already knows.` },
    { q: `What questions arise when studying ${topic}?`, a: `When studying this topic, questions may arise about its origin, how it works, what it is used for, how it is applied, and how it relates to prior knowledge.` },
    { q: `Compare ${topic} with another topic you have studied.`, a: `When comparing topics, you can identify similarities in basic principles, differences in applications, and connections that enrich understanding of both.` },
    { q: `What is the most important idea you learned about ${topic}?`, a: `The most important idea is understanding the fundamentals, recognizing practical utility, and being able to apply this knowledge in new situations.` },
    { q: `How can you apply what you learned about ${topic}?`, a: `This knowledge can be applied in school activities, personal projects, solving everyday problems, and understanding related news or information.` },
    { q: `Summarize in your own words what ${topic} is.`, a: `A good summary should include a clear definition, main characteristics, why it is important, and one or two examples that illustrate the concept.` },
    { q: `What difficulties did you encounter when studying ${topic}?`, a: `Common difficulties include understanding new terminology, connecting different concepts, and visualizing how knowledge applies in practice.` },
    { q: `What else would you like to learn about ${topic}?`, a: `You can go deeper by studying special cases, researching the topic's history, exploring advanced applications, and discovering related topics.` },
    { q: `Create an original example related to ${topic}.`, a: `A good original example should demonstrate understanding of the topic, be relevant and applicable, and correctly show learned concepts in a new situation.` },
  ];
}

function buildFallbackQuizHtml(input: GenerateQuizInput, _pdfContext: string): string {
  const isSpanish = input.language === 'es';
  const isMath = isMathSubject(input.bookTitle || '', input.topic || '');
  const titlePrefix = isMath 
    ? (isSpanish ? 'PROBLEMAS DE MATEMÁTICAS' : 'MATH PROBLEMS')
    : (isSpanish ? 'CUESTIONARIO' : 'QUIZ');
  const topicUpper = (input.topic || '').toUpperCase();
  const topic = input.topic?.trim() || (isSpanish ? 'el tema' : 'the topic');

  // Obtener preguntas específicas del tema (con soporte para problemas matemáticos)
  const topicQuestions = getTopicQuestions(topic, isSpanish, input.bookTitle);
  
  // Mezclar las preguntas para variar
  const shuffled = [...topicQuestions].sort(() => Math.random() - 0.5);
  
  // Tomar las primeras 15
  const selectedQuestions = shuffled.slice(0, 15);

  let formattedQuizHtml = `<h2>${titlePrefix} - ${topicUpper}</h2>`;
  formattedQuizHtml += `<p><strong>${isSpanish ? 'Libro:' : 'Book:'}</strong> ${input.bookTitle}</p>`;
  formattedQuizHtml += `<p><strong>${isSpanish ? 'Curso:' : 'Course:'}</strong> ${input.courseName}</p>`;
  formattedQuizHtml += `<br /><br />`;

  selectedQuestions.forEach((item, index) => {
    formattedQuizHtml += `<p style="margin-bottom: 1em;"><strong>${index + 1}. ${item.q}</strong></p>`;
    // Para matemáticas usar "Desarrollo y Respuesta", para otros "Respuesta esperada"
    const answerLabel = isMath 
      ? (isSpanish ? 'Desarrollo y Respuesta' : 'Solution and Answer')
      : (isSpanish ? 'Respuesta esperada' : 'Expected answer');
    formattedQuizHtml += `<p style="margin-top: 0.5em; margin-bottom: 0.5em;"><strong>${answerLabel}:</strong></p>`;
    const formattedAnswer = capitalizeFirstLetter(String(item.a || '').replace(/\n/g, '<br />'));
    formattedQuizHtml += `<p style="margin-top: 0.25em; margin-bottom: 2em; text-align: justify;">${formattedAnswer}</p>`;
    if (index < 14) {
      formattedQuizHtml += '<hr style="margin-top: 1rem; margin-bottom: 1.5rem; border-top: 1px solid #e5e7eb;" />';
    }
  });

  return formattedQuizHtml;
}

// PDF processing (server-side)
// PDF.js in Node.js is unreliable; we skip it entirely and rely on fallback content.
// This function is kept as a stub that always returns empty to avoid breaking the flow.
async function extractTextFromPdfBuffer(_buf: ArrayBuffer): Promise<string[]> {
  // PDF.js worker setup fails in Node.js/Edge environments consistently.
  // Rather than fight with worker configuration, we skip PDF extraction entirely
  // and rely on the fallback quiz generator which produces reasonable content.
  console.log('[generate-quiz] PDF extraction disabled in server environment, using fallback');
  return [];
}

function toDriveDownloadUrl(entry: { pdfUrl?: string; driveId?: string }): string | null {
  if (entry?.driveId) return `https://drive.google.com/uc?export=download&id=${entry.driveId}`;
  if (entry?.pdfUrl) {
    // Convert /file/d/<id>/view?usp=... to direct download
    const m = entry.pdfUrl.match(/\/file\/d\/([^/]+)\/view/);
    if (m && m[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
    return entry.pdfUrl;
  }
  return null;
}

async function fetchPdfArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch (e) {
    console.warn('[generate-quiz] fetch PDF failed:', e);
    return null;
  }
}

// Función optimizada para obtener páginas de PDF con caché
async function getPdfPagesWithCache(url: string): Promise<string[]> {
  // Verificar caché
  const cached = pdfContentCache.get(url);
  if (cached) {
    const ttl = cached.pages.length > 0 ? PDF_CACHE_TTL : PDF_FAILURE_TTL;
    if (Date.now() - cached.timestamp < ttl) {
      console.log('[generate-quiz] Usando PDF desde caché:', url.substring(0, 50));
      return cached.pages;
    }
  }
  
  // Descargar y extraer
  const buf = await fetchPdfArrayBuffer(url);
  if (!buf) {
    // Caché negativa para evitar reintentos continuos
    pdfContentCache.set(url, { pages: [], timestamp: Date.now() });
    return [];
  }
  
  const pages = await extractTextFromPdfBuffer(buf);
  
  // Guardar en caché
  // Limpiar entradas antiguas si hay más de 5
  if (pdfContentCache.size > 5) {
    const oldestKey = pdfContentCache.keys().next().value;
    if (oldestKey) pdfContentCache.delete(oldestKey);
  }
  // Guardar también páginas vacías (caché negativa) para evitar repetir descargas cuando pdfjs falla
  pdfContentCache.set(url, { pages, timestamp: Date.now() });
  
  return pages;
}

function selectRelevantContext(pages: string[], topic: string, subjectHint?: string, maxChars = 8000): { context: string; usedPageIndexes: number[] } {
  if (!pages?.length) return { context: '', usedPageIndexes: [] };
  const terms = (topic.toLowerCase().split(/[^a-záéíóúñü0-9]+/i).filter(Boolean));
  const subjectTerms = subjectHint ? subjectHint.toLowerCase().split(/[^a-záéíóúñü0-9]+/i).filter(Boolean) : [];
  const scorePage = (txt: string) => {
    const low = txt.toLowerCase();
    let s = 0;
    terms.forEach(t => { if (t && low.includes(t)) s += 3; });
    subjectTerms.forEach(t => { if (t && low.includes(t)) s += 1; });
    return s + Math.min(2, txt.length / 5000); // tiny length prior
  };
  const scored = pages.map((t, idx) => ({ idx, s: scorePage(t), t }));
  scored.sort((a, b) => b.s - a.s);
  const chunks: string[] = [];
  const used: number[] = [];
  let acc = 0;
  for (const it of scored) {
    if (!it.t || it.t.length < 100) continue;
    chunks.push(`(p.${it.idx + 1}) ${it.t}`);
    used.push(it.idx);
    acc += it.t.length;
    if (acc >= maxChars) break;
    if (chunks.length >= 12) break; // cap pages
  }
  return { context: chunks.join('\n\n'), usedPageIndexes: used };
}

async function collectContextForInput(input: GenerateQuizInput): Promise<{ context: string; references: string[] }> {
  // Generar clave de caché para el contexto
  const contextKey = `${input.courseName}_${input.bookTitle}_${input.topic.toLowerCase().trim()}`;
  
  // Verificar caché de contexto (incluye caché negativa)
  const cachedContext = contextCache.get(contextKey);
  if (cachedContext) {
    const ttl = cachedContext.context ? CONTEXT_CACHE_TTL : 2 * 60 * 1000; // 2 min para caché negativa
    if (Date.now() - cachedContext.timestamp < ttl) {
      console.log('[generate-quiz] Usando contexto desde caché para:', input.topic);
      return { context: cachedContext.context, references: cachedContext.references };
    }
  }
  
  // Identify PDFs by course and subject/book
  const course = input.courseName;
  const hint = input.bookTitle;
  const candidates = bookPDFs.filter(b => b.course === course && (b.title === hint || b.subject === hint));
  const refs: string[] = [];
  let combinedContext = '';
  
  for (const b of candidates) {
    const url = toDriveDownloadUrl(b);
    if (!url) continue;
    
    // Usar función con caché en lugar de descargar directamente
    const pages = await getPdfPagesWithCache(url);
    if (!pages.length) continue;
    
    const { context } = selectRelevantContext(pages, input.topic, b.subject, 6000);
    if (context) {
      combinedContext += (combinedContext ? '\n\n' : '') + `Fuente: ${b.title} (${b.subject})\n` + context;
      refs.push(b.title);
    }
    if (combinedContext.length > 14_000) break; // cap total
  }
  
  // Guardar en caché de contexto (incluye caché negativa cuando no hay contexto)
  if (contextCache.size > 20) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey) contextCache.delete(oldestKey);
  }
  contextCache.set(contextKey, { context: combinedContext, references: refs, timestamp: Date.now() });
  
  return { context: combinedContext, references: refs };
}

const GenerateQuizInputSchema = z.object({
  topic: z.string().describe('The topic for the quiz.'),
  topicDescription: z.string().optional().describe('A description of the topic that provides orientation and context for the quiz.'),
  bookTitle: z.string().describe('The title of the book.'),
  courseName: z.string().describe('The name of the course (used for context and age-appropriate content).'),
  language: z.enum(['es', 'en']).describe('The language for the quiz content (e.g., "es" for Spanish, "en" for English).'),
});
export type GenerateQuizInput = z.infer<typeof GenerateQuizInputSchema>;

// Schema for the structured output expected from the AI prompt
const QuestionSchema = z.object({
  questionText: z.string().describe('The text of the open-ended question.'),
  expectedAnswer: z.string().describe('A comprehensive ideal answer to the open-ended question, based on the book content. This should be detailed enough for a student to understand the topic thoroughly.'),
});

const AiPromptOutputSchema = z.object({
  quizTitle: z.string().describe('The title of the quiz, formatted as "CUESTIONARIO - [TOPIC_NAME_IN_UPPERCASE]" if language is "es", or "QUIZ - [TOPIC_NAME_IN_UPPERCASE]" if language is "en".'),
  questions: z.array(QuestionSchema).length(15).describe('An array of exactly 15 open-ended quiz questions.'),
});

// Schema for the final output of the flow (formatted HTML string)
const GenerateQuizOutputSchema = z.object({
  quiz: z.string().describe('The generated quiz as a formatted HTML string.'),
});
export type GenerateQuizOutput = z.infer<typeof GenerateQuizOutputSchema>;

// Helper function to capitalize the first letter of a string
function capitalizeFirstLetter(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}


export async function generateQuiz(input: GenerateQuizInput): Promise<GenerateQuizOutput> {
  const cacheKey = makeQuizCacheKey(input);
  const isMath = isMathSubject(input.bookTitle || '', input.topic || '');
  const scienceType = isScienceWithCalculations(input.bookTitle || '', input.topic || '');
  const hasCalculations = isMath || scienceType !== null;
  
  // Para matemáticas y ciencias con cálculos, NO usar caché para asegurar que se generen problemas del tema específico
  if (!hasCalculations) {
    const cachedOut = quizOutputCache.get(cacheKey);
    if (cachedOut && Date.now() - cachedOut.timestamp < QUIZ_OUTPUT_TTL) {
      console.log('[generate-quiz] Usando quiz HTML desde caché para:', input.topic);
      return cachedOut.output;
    }
  } else {
    console.log(`[generate-quiz] 📐 ${isMath ? 'Matemáticas' : scienceType?.toUpperCase()} detectada - saltando caché para tema:`, input.topic);
  }

  const inFlight = quizInFlight.get(cacheKey);
  if (inFlight) {
    console.log('[generate-quiz] Esperando request en vuelo para:', input.topic);
    return inFlight;
  }

  const work = (async (): Promise<GenerateQuizOutput> => {
    try {
      const isSpanish = input.language === 'es';
      // Determinar el título según el tipo de asignatura
      const getTitlePrefix = () => {
        if (isMath) return isSpanish ? 'PROBLEMAS DE MATEMÁTICAS' : 'MATH PROBLEMS';
        if (scienceType === 'fisica') return isSpanish ? 'CUESTIONARIO Y PROBLEMAS DE FÍSICA' : 'PHYSICS QUIZ AND PROBLEMS';
        if (scienceType === 'quimica') return isSpanish ? 'CUESTIONARIO Y PROBLEMAS DE QUÍMICA' : 'CHEMISTRY QUIZ AND PROBLEMS';
        if (scienceType === 'biologia') return isSpanish ? 'CUESTIONARIO Y PROBLEMAS DE BIOLOGÍA' : 'BIOLOGY QUIZ AND PROBLEMS';
        return isSpanish ? 'CUESTIONARIO' : 'QUIZ';
      };
      const titlePrefix = getTitlePrefix();
      const topicUpper = input.topic.toUpperCase();
      
      // Obtener instrucciones especiales para ciencias con cálculos
      const scienceInstructions = scienceType ? getScienceCalculationInstructions(scienceType, isSpanish ? 'es' : 'en') : '';
      
      // Obtener contexto de generación basado en el curso
      const courseContext = input.courseName ? getContentGenerationContext(input.courseName) : null;
      const adaptationInstructions = courseContext ? generateAIPromptInstructions(courseContext, input.language) : '';
      
      // Construir contexto del tema si hay descripción
      const topicGuidance = input.topicDescription 
        ? (isSpanish 
            ? `\n📋 ORIENTACIÓN DEL TEMA:\n${input.topicDescription}\nUsa esta descripción para enfocar las preguntas.`
            : `\n📋 TOPIC GUIDANCE:\n${input.topicDescription}\nUse this description to focus the questions.`)
        : '';
      
      // =====================================================================
      // PRIORIDAD 1: OpenRouter (más confiable y económico)
      // =====================================================================
      if (hasOpenRouterApiKey()) {
        console.log('[generate-quiz] 🚀 Intentando con OpenRouter primero...');
        const openRouterClient = getOpenRouterClient();
        
        if (openRouterClient) {
          try {
            const systemPrompt = isSpanish 
              ? `Eres un experto educador y diseñador curricular. Genera cuestionarios educativos de alta calidad ADAPTADOS AL NIVEL DEL ESTUDIANTE.
              
${adaptationInstructions}`
              : `You are an expert educator and curriculum designer. Generate high-quality educational quizzes ADAPTED TO THE STUDENT'S LEVEL.
              
${adaptationInstructions}`;
            
            // Función para generar el prompt según el tipo de asignatura
            const getUserPrompt = (): string => {
              // Para Matemáticas puras
              if (isMath) {
                return isSpanish 
                  ? `Genera un cuestionario de 15 PROBLEMAS DE MATEMÁTICAS sobre "${input.topic}" para ${input.courseName}.${topicGuidance}

${courseContext ? `⚠️ IMPORTANTE: El estudiante tiene aproximadamente ${courseContext.approximateAge} años. Adapta la dificultad de los problemas a su nivel.` : ''}

Cada problema debe tener:
1. Un enunciado claro (questionText) con emojis como 🔢, ➕, ➖, ✖️, ➗
2. Una respuesta detallada (expectedAnswer) con:
   - 📝 DESARROLLO: paso a paso
   - ✅ RESPUESTA: resultado final
   - 🔍 VERIFICACIÓN: comprobación

Responde en JSON con formato:
{
  "quizTitle": "${titlePrefix} - ${topicUpper}",
  "questions": [
    {"questionText": "🔢 Problema 1: ...", "expectedAnswer": "📝 DESARROLLO:\\n...\\n✅ RESPUESTA: ..."}
  ]
}

Responde SOLO con JSON válido.`
                  : `Generate a quiz with 15 MATH PROBLEMS about "${input.topic}" for ${input.courseName}.${topicGuidance}

${courseContext ? `⚠️ IMPORTANT: The student is approximately ${courseContext.approximateAge} years old. Adapt the difficulty of the problems to their level.` : ''}

Each problem must have:
1. A clear statement (questionText) with emojis like 🔢, ➕, ➖, ✖️, ➗
2. A detailed answer (expectedAnswer) with step-by-step solution

Respond in JSON format:
{
  "quizTitle": "${titlePrefix} - ${topicUpper}",
  "questions": [
    {"questionText": "🔢 Problem 1: ...", "expectedAnswer": "📝 SOLUTION:\\n...\\n✅ ANSWER: ..."}
  ]
}

Respond ONLY with valid JSON.`;
              }
              
              // Para Física, Química, Biología (ciencias con cálculos)
              if (scienceType) {
                const subjectEmoji = scienceType === 'fisica' ? '⚡' : scienceType === 'quimica' ? '🧪' : '🧬';
                return isSpanish 
                  ? `Genera un cuestionario de 15 preguntas sobre "${input.topic}" para ${input.courseName}.${topicGuidance}

${scienceInstructions}

${courseContext ? `⚠️ IMPORTANTE: El estudiante tiene aproximadamente ${courseContext.approximateAge} años. Adapta la dificultad al nivel del estudiante.` : ''}

DISTRIBUCIÓN DE PREGUNTAS:
- 8 preguntas TEÓRICAS (conceptos, definiciones, explicaciones)
- 7 preguntas PRÁCTICAS (problemas con cálculos, aplicación de fórmulas)

Para preguntas TEÓRICAS:
- Usar emojis como 📚, 🔬, 💡
- Respuestas explicativas y conceptuales

Para preguntas PRÁCTICAS/CÁLCULOS:
- Usar emojis como ${subjectEmoji}, 🔢, 📊
- Incluir en la respuesta:
  📝 DATOS: identificación de variables
  📐 FÓRMULA: ecuación a usar
  🔄 DESARROLLO: paso a paso
  ✅ RESPUESTA: resultado con unidades
  🔍 VERIFICACIÓN: comprobación

Responde en JSON con formato:
{
  "quizTitle": "${titlePrefix} - ${topicUpper}",
  "questions": [
    {"questionText": "${subjectEmoji} Pregunta/Problema 1: ...", "expectedAnswer": "Respuesta detallada..."}
  ]
}

Responde SOLO con JSON válido.`
                  : `Generate a quiz with 15 questions about "${input.topic}" for ${input.courseName}.${topicGuidance}

${scienceInstructions}

${courseContext ? `⚠️ IMPORTANT: The student is approximately ${courseContext.approximateAge} years old. Adapt difficulty to the student's level.` : ''}

QUESTION DISTRIBUTION:
- 8 THEORETICAL questions (concepts, definitions, explanations)
- 7 PRACTICAL questions (problems with calculations, formula application)

For THEORETICAL questions:
- Use emojis like 📚, 🔬, 💡
- Explanatory and conceptual answers

For PRACTICAL/CALCULATION questions:
- Use emojis like ${subjectEmoji}, 🔢, 📊
- Include in the answer:
  📝 DATA: variable identification
  📐 FORMULA: equation to use
  🔄 SOLUTION: step by step
  ✅ ANSWER: result with units
  🔍 VERIFICATION: check

Respond in JSON format:
{
  "quizTitle": "${titlePrefix} - ${topicUpper}",
  "questions": [
    {"questionText": "${subjectEmoji} Question/Problem 1: ...", "expectedAnswer": "Detailed answer..."}
  ]
}

Respond ONLY with valid JSON.`;
              }
              
              // Para otras asignaturas (sin cálculos)
              return isSpanish 
              ? `Genera un cuestionario educativo de 15 preguntas abiertas sobre "${input.topic}" del libro "${input.bookTitle}" para ${input.courseName}.${topicGuidance}

${courseContext ? `⚠️ IMPORTANTE: El estudiante tiene aproximadamente ${courseContext.approximateAge} años. Adapta las preguntas y respuestas a su nivel cognitivo.` : ''}

Cada pregunta debe:
1. Ser clara y específica sobre el tema
2. Estar adaptada al nivel del estudiante
3. Tener una respuesta esperada detallada y educativa

Responde en JSON con formato:
{
  "quizTitle": "${titlePrefix} - ${topicUpper}",
  "questions": [
    {"questionText": "1. ¿Pregunta sobre el tema?", "expectedAnswer": "Respuesta detallada y educativa..."}
  ]
}

Responde SOLO con JSON válido.`
              : `Generate an educational quiz with 15 open-ended questions about "${input.topic}" from the book "${input.bookTitle}" for ${input.courseName}.${topicGuidance}

${courseContext ? `⚠️ IMPORTANT: The student is approximately ${courseContext.approximateAge} years old. Adapt questions and answers to their cognitive level.` : ''}

Each question must:
1. Be clear and specific about the topic
2. Be adapted to the student's level
3. Have a detailed and educational expected answer

Respond in JSON format:
{
  "quizTitle": "${titlePrefix} - ${topicUpper}",
  "questions": [
    {"questionText": "1. Question about the topic?", "expectedAnswer": "Detailed educational answer..."}
  ]
}

Respond ONLY with valid JSON.`;
            };
            
            const userPrompt = getUserPrompt();
            
            const response = await openRouterClient.generateText(systemPrompt, userPrompt, {
              model: OPENROUTER_MODELS.GPT_4O_MINI,
              temperature: 0.7,
              maxTokens: 6000,
            });
            
            // Parsear JSON
            let jsonStr = response.trim();
            if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
            if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
            if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
            jsonStr = jsonStr.trim();
            
            const parsed = JSON.parse(jsonStr);
            
            if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
              console.log('[generate-quiz] ✅ OpenRouter generó', parsed.questions.length, 'preguntas exitosamente');
              
              // Formatear como HTML
              let formattedQuizHtml = `<h2>${parsed.quizTitle || `${titlePrefix} - ${topicUpper}`}</h2>`;
              formattedQuizHtml += `<p><strong>${isSpanish ? 'Libro:' : 'Book:'}</strong> ${input.bookTitle}</p>`;
              formattedQuizHtml += `<p><strong>${isSpanish ? 'Curso:' : 'Course:'}</strong> ${input.courseName}</p>`;
              formattedQuizHtml += `<br /><br />`;
              
              parsed.questions.forEach((q: any, index: number) => {
                formattedQuizHtml += `<p style="margin-bottom: 1em;"><strong>${index + 1}. ${q.questionText}</strong></p>`;
                // Para matemáticas y ciencias con cálculos usar "Desarrollo y Respuesta"
                const answerLabel = hasCalculations 
                  ? (isSpanish ? 'Desarrollo y Respuesta' : 'Solution and Answer')
                  : (isSpanish ? 'Respuesta esperada' : 'Expected answer');
                formattedQuizHtml += `<p style="margin-top: 0.5em; margin-bottom: 0.5em;"><strong>${answerLabel}:</strong></p>`;
                const formattedAnswer = capitalizeFirstLetter(String(q.expectedAnswer || '').replace(/\n/g, '<br />'));
                formattedQuizHtml += `<p style="margin-top: 0.25em; margin-bottom: 2em; text-align: justify;">${formattedAnswer}</p>`;
                if (index < parsed.questions.length - 1) {
                  formattedQuizHtml += '<hr style="margin-top: 1rem; margin-bottom: 1.5rem; border-top: 1px solid #e5e7eb;" />';
                }
              });
              
              return { quiz: formattedQuizHtml };
            }
          } catch (openRouterErr) {
            console.warn('[generate-quiz] ⚠️ OpenRouter falló:', openRouterErr);
            // Continuar con Google Gemini como fallback
          }
        }
      }
      
      // =====================================================================
      // PRIORIDAD 2: Google Gemini (fallback)
      // =====================================================================
      const hasGoogleKey = !!(process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY);
      
      if (hasGoogleKey) {
        console.log('[generate-quiz] 🔄 Intentando con Google Gemini como fallback...');
        
        // MATEMÁTICAS y CIENCIAS CON CÁLCULOS: Usar la IA con prompt especializado
        if (hasCalculations) {
          console.log(`📐 [generate-quiz] Detectada asignatura con CÁLCULOS (${isMath ? 'Matemáticas' : scienceType}) - Usando IA con prompt especializado para:`, input.topic);
          
          try {
            const result = await generateQuizFlow({ ...input, _pdfContext: '', _pdfRefs: [] });
            console.log('✅ [generate-quiz] Quiz con cálculos generado con Google AI exitosamente');
            return result;
          } catch (mathErr) {
            console.warn('[generate-quiz] Error generando quiz de matemáticas con Google AI:', mathErr);
          }
        } else {
          // Gather PDF context before calling the AI flow
          let context = '';
          let references: string[] = [];
          try {
            const ctx = await collectContextForInput(input);
            context = ctx.context;
            references = ctx.references;
          } catch (ctxErr) {
            console.warn('[generate-quiz] Context collection failed, continuing with empty context:', ctxErr);
          }

          try {
            return await generateQuizFlow({ ...input, _pdfContext: context, _pdfRefs: references });
          } catch (err) {
            const isRateLimited = isLikelyRateLimitError(err);
            console.warn('[generate-quiz] Google AI quiz generation failed' + (isRateLimited ? ' (rate limited)' : '') + ':', err);
          }
        }
      }
      
      // =====================================================================
      // FALLBACK: Generar quiz desde banco de preguntas local
      // =====================================================================
      console.log('[generate-quiz] ⚠️ Usando fallback con banco de preguntas local');
      
      if (isMath) {
        const quizHtml = buildMathFallbackForTopic(input);
        return { quiz: quizHtml };
      }
      
      return { quiz: buildFallbackQuizHtml(input, '') };
      
    } catch (unexpected) {
      console.warn('[generate-quiz] Unexpected error, using fallback quiz:', unexpected);
      return { quiz: buildFallbackQuizHtml(input, '') };
    }
  })();

  quizInFlight.set(cacheKey, work);
  try {
    const out = await work;
    quizOutputCache.set(cacheKey, { output: out, timestamp: Date.now() });
    return out;
  } catch (finalErr) {
    // Ultimate fallback: if even the work promise rejects, return a basic quiz
    console.error('[generate-quiz] Final catch triggered, returning emergency fallback:', finalErr);
    return { quiz: buildFallbackQuizHtml(input, '') };
  } finally {
    quizInFlight.delete(cacheKey);
  }
}

const generateQuizPrompt = ai.definePrompt({
  name: 'generateQuizPrompt',
  input: { schema: GenerateQuizInputSchema.extend({
    topic_uppercase: z.string(),
    title_prefix: z.string(),
    _pdfContext: z.string().optional(),
    _pdfRefs: z.array(z.string()).optional(),
  })},
  output: {schema: AiPromptOutputSchema},
  prompt: `You are an expert educator and curriculum designer.
Your task is to generate a comprehensive quiz STRICTLY based on the provided PDF context extracted from the book(s) related to "{{bookTitle}}" and topic "{{topic}}".

Important rules:
- Use ONLY the following extracted PDF context to craft the questions and expected answers.
- If the context is insufficient, prefer concise, general high-level questions but DO NOT invent detailed facts not present in the context.
- Keep all content in {{{language}}}.

PDF CONTEXT (may be partial and noisy, includes page markers like (p.12)):
"""
{{_pdfContext}}
"""

The quiz MUST adhere to the following structure:
1.  **Quiz Title**: The title must be exactly "{{title_prefix}} - {{topic_uppercase}}".
2.  **Number of Questions**: Generate exactly 15 unique open-ended questions.
3.  **For each question, provide**:
    *   \`questionText\`: The clear and concise text of the open-ended question.
    *   \`expectedAnswer\`: A comprehensive ideal answer to the question, referencing concepts from the book "{{bookTitle}}" where possible. This answer should be detailed and clear, suitable for study and understanding.

All content (title, questions, answers) should be directly relevant to the topic "{{topic}}" as covered in the provided PDF context for "{{bookTitle}}". Ensure the language of all generated content is {{{language}}}.
  `,
});

// =============================================================================
// PROMPT ESPECIAL PARA PROBLEMAS DE MATEMÁTICAS
// =============================================================================
const generateMathQuizPrompt = ai.definePrompt({
  name: 'generateMathQuizPrompt',
  input: { schema: GenerateQuizInputSchema.extend({
    topic_uppercase: z.string(),
    title_prefix: z.string(),
    _pdfContext: z.string().optional(),
  })},
  output: {schema: AiPromptOutputSchema},
  prompt: `Eres un profesor experto en matemáticas. Tu tarea es generar PROBLEMAS DE MATEMÁTICAS sobre el tema "{{topic}}" para estudiantes del curso "{{courseName}}".

IMPORTANTE - REGLAS PARA PROBLEMAS DE MATEMÁTICAS:
1. Cada problema debe ser un ejercicio PRÁCTICO de matemáticas (no preguntas teóricas genéricas)
2. Cada respuesta DEBE incluir el DESARROLLO PASO A PASO mostrando cómo llegar a la solución
3. Usa el siguiente formato EXACTO para cada respuesta:

📝 DESARROLLO:
• [Paso 1: identificar datos y operación]
• [Paso 2: plantear la solución]
• [Paso 3: realizar los cálculos]
• [Pasos adicionales si es necesario]

✅ RESPUESTA: [Resultado final claro]

🔍 VERIFICACIÓN: [Cómo comprobar que el resultado es correcto]

TIPOS DE PROBLEMAS A GENERAR SEGÚN EL TEMA "{{topic}}":
- Si es sobre ecuaciones: resolver ecuaciones paso a paso (x + 5 = 12, 2x - 3 = 7, etc.)
- Si es sobre derivadas: calcular derivadas mostrando reglas aplicadas
- Si es sobre integrales: resolver integrales mostrando el proceso
- Si es sobre fracciones: operaciones con fracciones con desarrollo
- Si es sobre porcentajes: problemas de porcentaje con cálculos
- Si es sobre geometría: cálculos de áreas, perímetros, volúmenes
- Si es sobre potencias / exponentes: calcular y simplificar potencias, aplicar leyes de exponentes (producto, cociente, potencia de una potencia), y notación científica cuando corresponda
- Si es sobre raíces cuadradas / radicales: calcular raíces cuadradas (√) de cuadrados perfectos, identificar cuadrados perfectos y usar raíz para encontrar un lado a partir del área (cuando corresponda al nivel)
- Si es sobre trigonometría: cálculos con seno, coseno, tangente
- Si es sobre álgebra: factorización, simplificación, sistemas de ecuaciones
- Si es sobre funciones: evaluación, dominio, rango, gráficas
- Si es sobre límites: cálculo de límites paso a paso
- Si es sobre probabilidad: cálculos de probabilidad con desarrollo
- Si es sobre estadística: cálculos de media, mediana, moda, desviación
- Para cualquier otro tema matemático: genera problemas apropiados con desarrollo

NIVEL: Adapta la dificultad al curso "{{courseName}}":
- Básico (1ro-4to): operaciones simples, problemas con contexto cotidiano
- Medio (5to-8vo): ecuaciones, fracciones, geometría básica
- Secundaria (1ro-4to Medio): álgebra, funciones, trigonometría, cálculo

ESTRUCTURA REQUERIDA:
1. **Título**: "PROBLEMAS DE MATEMÁTICAS - {{topic_uppercase}}"
2. **Cantidad**: Exactamente 15 problemas únicos
3. **Formato**:
   - questionText: El enunciado del problema matemático (puede incluir emojis como 🔢, ➗, ✖️, ➕, ➖)
   - expectedAnswer: El desarrollo COMPLETO paso a paso usando el formato indicado arriba

Genera problemas variados y progresivos en dificultad. Todo el contenido debe estar en español.

REGLA DE ADHERENCIA AL TEMA (OBLIGATORIA):
- Cada problema debe evaluar directamente "{{topic}}".
- Si el tema contiene "raíz", "raíces" o "radical", entonces cada enunciado debe incluir el símbolo √ o la frase "raíz"/"raíz cuadrada".
- Si el tema contiene "potencia", "potencias", "exponente" o "exponentes", entonces cada enunciado debe incluir notación de exponente (por ejemplo ^, ², ³) o la palabra "exponente"/"potencia".
- Si el tema contiene "derivada" o "derivadas", entonces cada enunciado debe incluir notación de derivadas (por ejemplo d/dx, f'(x), y') o la palabra "derivada".
- Si el tema contiene "integral" o "integrales", entonces cada enunciado debe incluir el símbolo ∫ o la palabra "integral".
`,
});

function validateMathQuestionsMatchTopic(topic: string, questions: Array<{ questionText: string }>): boolean {
  const topicNorm = normalizeForMatch(topic);
  if (!questions?.length) return false;

  const text = (q: { questionText: string }) => String(q.questionText || '');
  const ratioOk = (re: RegExp) => {
    const matches = questions.filter(q => re.test(text(q))).length;
    return matches >= Math.ceil(questions.length * 0.8);
  };

  // Caso específico: raíces/radicales
  if (/(\braiz\b|\braices\b|radical)/.test(topicNorm)) {
    return ratioOk(/(√|ra[ií]z|radical)/i);
  }

  // Potencias / exponentes
  if (/(\bpotenc|\bexponent)/.test(topicNorm)) {
    // Exigimos al menos una señal clara de potencias en la mayoría de los enunciados.
    return ratioOk(/(\^|[²³⁴⁵⁶⁷⁸⁹]|\bpotenc\w*\b|\bexponent\w*\b)/i);
  }

  // Derivadas
  if (/(\bderivad)/.test(topicNorm)) {
    return ratioOk(/(d\s*\/\s*dx|f\s*'\s*\(|\by'\b|\bderivad\w*\b)/i);
  }

  // Integrales
  if (/(\bintegral)/.test(topicNorm)) {
    return ratioOk(/(∫|\bintegral\w*\b)/i);
  }

  // Fracciones
  if (/(\bfracci)/.test(topicNorm)) {
    return ratioOk(/(\d+\s*\/\s*\d+|\bfracci\w*\b)/i);
  }

  // Por defecto no invalidamos otros temas para evitar falsos negativos.
  return true;
}

function buildMathFallbackForTopic(input: GenerateQuizInput): string {
  // Reutiliza el fallback general, que ya respeta bancos matemáticos por tema.
  return buildFallbackQuizHtml(input, '');
}

const generateQuizFlow = ai.defineFlow(
  {
    name: 'generateQuizFlow',
    // Extend input schema at runtime for internal fields
    inputSchema: GenerateQuizInputSchema.extend({ _pdfContext: z.string().optional(), _pdfRefs: z.array(z.string()).optional() }),
    outputSchema: GenerateQuizOutputSchema, // Flow returns the HTML string
  },
  async (input: GenerateQuizInput & { _pdfContext?: string; _pdfRefs?: string[] }) => {
    const isSpanish = input.language === 'es';
    const isMath = isMathSubject(input.bookTitle || '', input.topic || '');
    
    // Seleccionar título y prompt según si es matemáticas o no
    const titlePrefix = isMath 
      ? (isSpanish ? 'PROBLEMAS DE MATEMÁTICAS' : 'MATH PROBLEMS')
      : (isSpanish ? 'CUESTIONARIO' : 'QUIZ');
    
    const promptInput = {
      ...input,
      topic_uppercase: input.topic.toUpperCase(),
      title_prefix: titlePrefix,
      _pdfContext: input._pdfContext || '',
    };
    
    // Usar prompt de matemáticas o prompt general según corresponda
    let output;
    if (isMath) {
      console.log('[generate-quiz] Usando prompt de MATEMÁTICAS para:', input.topic);
      const result = await generateMathQuizPrompt(promptInput);
      output = result.output;

      if (!output?.questions || !validateMathQuestionsMatchTopic(input.topic, output.questions)) {
        console.warn('[generate-quiz] Quiz de matemáticas no coincide con el tema. Forzando fallback por tema:', input.topic);
        throw new Error('Math quiz questions did not match requested topic');
      }
    } else {
      const result = await generateQuizPrompt(promptInput);
      output = result.output;
    }

    if (!output || !output.questions || output.questions.length === 0) {
      throw new Error('AI failed to generate quiz questions.');
    }

    let formattedQuizHtml = `<h2>${output.quizTitle}</h2>`;
    formattedQuizHtml += `<p><strong>${isSpanish ? 'Libro:' : 'Book:'}</strong> ${input.bookTitle}</p>`;
    formattedQuizHtml += `<p><strong>${isSpanish ? 'Curso:' : 'Course:'}</strong> ${input.courseName}</p>`;
    formattedQuizHtml += `<br /><br />`;
    
    output.questions.forEach((q, index) => {
      formattedQuizHtml += `<p style="margin-bottom: 1em;"><strong>${index + 1}. ${q.questionText}</strong></p>`;
      // Para matemáticas usar "Desarrollo y Respuesta", para otros "Respuesta esperada"
      const answerLabel = isMath 
        ? (isSpanish ? 'Desarrollo y Respuesta' : 'Solution and Answer')
        : (isSpanish ? 'Respuesta esperada' : 'Expected answer');
      formattedQuizHtml += `<p style="margin-top: 0.5em; margin-bottom: 0.5em;"><strong>${answerLabel}:</strong></p>`;
      // Format the expected answer for better readability, e.g., convert newlines to <br>
      const formattedAnswer = capitalizeFirstLetter(q.expectedAnswer.replace(/\n/g, '<br />'));
      formattedQuizHtml += `<p style="margin-top: 0.25em; margin-bottom: 2em; text-align: justify;">${formattedAnswer}</p>`;
      
      if (index < output.questions.length - 1) {
        formattedQuizHtml += '<hr style="margin-top: 1rem; margin-bottom: 1.5rem; border-top: 1px solid #e5e7eb;" />';
      }
    });

    // Append references if available
    if (Array.isArray(input._pdfRefs) && input._pdfRefs.length) {
      formattedQuizHtml += `<hr style="margin-top: 1rem; margin-bottom: 1rem; border-top: 1px solid #e5e7eb;" />`;
      const refsTitle = isSpanish ? 'Referencias (PDF)' : 'References (PDF)';
      formattedQuizHtml += `<p><strong>${refsTitle}:</strong> ${input._pdfRefs.join('; ')}</p>`;
    }

    return { quiz: formattedQuizHtml };
  }
);
