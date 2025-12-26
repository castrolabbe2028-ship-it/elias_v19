// API Route para probar la conexión con OpenRouter
import { NextResponse } from "next/server";
import { openrouter } from "@/lib/openrouter";

export async function GET() {
  try {
    // Verificar si OpenRouter está configurado
    if (!openrouter.isConfigured()) {
      return NextResponse.json({
        success: false,
        provider: 'none',
        error: 'OpenRouter API key not configured',
        hint: 'Set OPENROUTER_API_KEY in .env.local'
      }, { status: 400 });
    }

    console.log('[Test AI] Testing OpenRouter connection...');
    
    // Hacer una petición simple para verificar que funciona
    const response = await openrouter.generateContent(
      'Responde solo con "OK" si puedes leer este mensaje.',
      {
        systemPrompt: 'Eres un asistente de prueba. Responde de forma muy breve.',
        temperature: 0,
        maxTokens: 10,
      }
    );

    return NextResponse.json({
      success: true,
      provider: 'openrouter',
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      response: response.trim(),
      message: '✅ OpenRouter está configurado y funcionando correctamente'
    });

  } catch (error: any) {
    console.error('[Test AI] Error:', error);
    
    return NextResponse.json({
      success: false,
      provider: 'openrouter',
      error: error.message || 'Unknown error',
      hint: 'Verifica que tu API key de OpenRouter sea válida'
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { prompt, model } = await request.json();

    if (!openrouter.isConfigured()) {
      return NextResponse.json({
        success: false,
        error: 'OpenRouter not configured'
      }, { status: 400 });
    }

    const response = await openrouter.generateContent(prompt || 'Hola, ¿cómo estás?', {
      model: model || undefined,
      temperature: 0.7,
      maxTokens: 1000,
    });

    return NextResponse.json({
      success: true,
      provider: 'openrouter',
      model: model || process.env.OPENROUTER_MODEL,
      response,
    });

  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
