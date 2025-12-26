import {genkit} from 'genkit';
import {googleAI} from '@genkit-ai/googleai';
import { openrouter } from '@/lib/openrouter';

// Determinar si usar OpenRouter o Google AI
const useOpenRouter = !!process.env.OPENROUTER_API_KEY;

// Configurar Genkit con Google AI (para compatibilidad con código existente)
export const ai = genkit({
  plugins: [googleAI({
    apiKey: process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
  })],
  model: 'googleai/gemini-2.0-flash',
});

// Exportar OpenRouter para uso directo
export { openrouter, useOpenRouter };

// Helper para generar contenido usando el proveedor configurado
export async function generateWithAI(prompt: string, options: {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
} = {}): Promise<string> {
  if (useOpenRouter) {
    console.log('[AI] Using OpenRouter');
    return openrouter.generateContent(prompt, options);
  }
  
  // Fallback a Genkit/Google AI
  console.log('[AI] Using Google AI (Genkit)');
  const result = await ai.generate({
    prompt: options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt,
    config: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4096,
    },
  });
  return result.text;
}
