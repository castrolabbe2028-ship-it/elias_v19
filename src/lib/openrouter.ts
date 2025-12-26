/**
 * Cliente de OpenRouter para generación de contenido con IA
 * OpenRouter proporciona acceso a múltiples modelos de IA a través de una API unificada
 */

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterChoice {
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
  index: number;
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  siteUrl?: string;
  siteName?: string;
}

class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private siteUrl: string;
  private siteName: string;

  constructor(config: OpenRouterConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.defaultModel = config.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    this.siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    this.siteName = config.siteName || 'ELIVAS Education Platform';
  }

  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  async chat(
    messages: OpenRouterMessage[],
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      responseFormat?: { type: 'json_object' | 'text' };
    } = {}
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env.local');
    }

    const model = options.model || this.defaultModel;
    
    console.log(`[OpenRouter] Sending request to model: ${model}`);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.siteUrl,
        'X-Title': this.siteName,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.responseFormat && { response_format: options.responseFormat }),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OpenRouter] API Error: ${response.status} - ${errorText}`);
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data: OpenRouterResponse = await response.json();
    
    if (!data.choices || data.choices.length === 0) {
      throw new Error('No response from OpenRouter');
    }

    console.log(`[OpenRouter] Response received. Tokens used: ${data.usage?.total_tokens || 'unknown'}`);

    return data.choices[0].message.content;
  }

  async generateContent(prompt: string, options: {
    model?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  } = {}): Promise<string> {
    const messages: OpenRouterMessage[] = [];

    if (options.systemPrompt) {
      messages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    messages.push({
      role: 'user',
      content: prompt,
    });

    return this.chat(messages, {
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      responseFormat: options.jsonMode ? { type: 'json_object' } : undefined,
    });
  }

  async generateJSON<T = unknown>(
    prompt: string,
    options: {
      model?: string;
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<T> {
    const systemPrompt = options.systemPrompt 
      ? `${options.systemPrompt}\n\nIMPORTANT: Always respond with valid JSON only. No markdown, no explanations, just the JSON.`
      : 'You are a helpful assistant that always responds with valid JSON. No markdown, no explanations, just the JSON.';

    const response = await this.generateContent(prompt, {
      ...options,
      systemPrompt,
      jsonMode: true,
    });

    // Intentar parsear el JSON
    try {
      // Limpiar posibles marcadores de código
      let cleanJson = response.trim();
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.slice(7);
      }
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.slice(3);
      }
      if (cleanJson.endsWith('```')) {
        cleanJson = cleanJson.slice(0, -3);
      }
      cleanJson = cleanJson.trim();

      return JSON.parse(cleanJson) as T;
    } catch (e) {
      console.error('[OpenRouter] Failed to parse JSON response:', response);
      throw new Error('Failed to parse JSON response from OpenRouter');
    }
  }

  // Métodos de conveniencia para diferentes casos de uso
  async generateEvaluation(topic: string, options: {
    questionCount?: number;
    language?: 'es' | 'en';
    bookTitle?: string;
  } = {}): Promise<string> {
    const { questionCount = 15, language = 'es', bookTitle = '' } = options;
    
    const systemPrompt = language === 'es' 
      ? 'Eres un profesor experto en crear evaluaciones educativas de alta calidad en español.'
      : 'You are an expert teacher in creating high-quality educational evaluations in English.';

    const prompt = language === 'es'
      ? `Genera una evaluación de ${questionCount} preguntas sobre el tema "${topic}"${bookTitle ? ` basándote en el libro "${bookTitle}"` : ''}.
         
         La evaluación debe incluir una mezcla de:
         - Preguntas de verdadero/falso
         - Preguntas de selección múltiple (4 opciones)
         - Preguntas de selección múltiple con varias respuestas correctas
         
         Para cada pregunta, incluye una explicación breve de la respuesta correcta.`
      : `Generate an evaluation of ${questionCount} questions about the topic "${topic}"${bookTitle ? ` based on the book "${bookTitle}"` : ''}.
         
         The evaluation should include a mix of:
         - True/false questions
         - Multiple choice questions (4 options)
         - Multiple selection questions with several correct answers
         
         For each question, include a brief explanation of the correct answer.`;

    return this.generateContent(prompt, {
      systemPrompt,
      temperature: 0.7,
      maxTokens: 4096,
    });
  }

  async generateSummary(topic: string, options: {
    content?: string;
    language?: 'es' | 'en';
    maxLength?: number;
  } = {}): Promise<string> {
    const { content, language = 'es', maxLength = 500 } = options;
    
    const systemPrompt = language === 'es'
      ? 'Eres un experto en crear resúmenes educativos claros y concisos en español.'
      : 'You are an expert in creating clear and concise educational summaries in English.';

    const prompt = content
      ? `Resume el siguiente contenido sobre "${topic}" en máximo ${maxLength} palabras:\n\n${content}`
      : `Crea un resumen educativo sobre "${topic}" en máximo ${maxLength} palabras.`;

    return this.generateContent(prompt, {
      systemPrompt,
      temperature: 0.5,
      maxTokens: 2048,
    });
  }

  async generateSlideContent(topic: string, options: {
    slideCount?: number;
    subject?: string;
    language?: 'es' | 'en';
  } = {}): Promise<string> {
    const { slideCount = 10, subject = '', language = 'es' } = options;
    
    const systemPrompt = language === 'es'
      ? 'Eres un experto en crear presentaciones educativas atractivas y bien estructuradas en español.'
      : 'You are an expert in creating engaging and well-structured educational presentations in English.';

    const prompt = language === 'es'
      ? `Crea el contenido para una presentación de ${slideCount} diapositivas sobre "${topic}"${subject ? ` para la asignatura de ${subject}` : ''}.
         
         Para cada diapositiva incluye:
         - Título
         - Puntos clave (3-5 bullets)
         - Sugerencia de imagen o diagrama`
      : `Create content for a ${slideCount}-slide presentation about "${topic}"${subject ? ` for the ${subject} subject` : ''}.
         
         For each slide include:
         - Title
         - Key points (3-5 bullets)
         - Image or diagram suggestion`;

    return this.generateContent(prompt, {
      systemPrompt,
      temperature: 0.7,
      maxTokens: 4096,
    });
  }
}

// Exportar una instancia singleton
export const openrouter = new OpenRouterClient();

// También exportar la clase para crear instancias personalizadas
export { OpenRouterClient };
export type { OpenRouterMessage, OpenRouterResponse, OpenRouterConfig };
