import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Verificar OpenRouter primero (proveedor preferido)
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const hasOpenRouter = !!(openRouterKey && openRouterKey.length >= 30);

    // Luego verificar Google AI
    const googleApiKey = process.env.GOOGLE_AI_API_KEY
      || process.env.GOOGLE_API_KEY
      || process.env.GEMINI_API_KEY
      || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    const hasGoogleAI = !!(googleApiKey && googleApiKey !== 'your_google_api_key_here' && googleApiKey.length >= 30);

    console.log('🔍 Checking AI status...');
    console.log('🌐 OpenRouter configured:', hasOpenRouter ? 'Yes' : 'No');
    console.log('📊 Google AI configured:', hasGoogleAI ? 'Yes' : 'No');

    // Si tiene OpenRouter, está activo
    if (hasOpenRouter) {
      const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
      console.log('✅ AI is active via OpenRouter');
      return NextResponse.json({ 
        isActive: true,
        provider: 'openrouter',
        reason: 'IA configurada via OpenRouter',
        model,
        timestamp: new Date().toISOString(),
        features: [
          'Generación de resúmenes',
          'Creación de mapas mentales', 
          'Generación de cuestionarios',
          'Contenido de evaluaciones'
        ]
      });
    }

    // Si tiene Google AI, está activo
    if (hasGoogleAI) {
      console.log('✅ AI is active via Google AI');
      return NextResponse.json({ 
        isActive: true,
        provider: 'google',
        reason: 'IA configurada via Google AI',
        model: 'gemini-2.0-flash',
        keyLength: googleApiKey!.length,
        timestamp: new Date().toISOString(),
        features: [
          'Generación de resúmenes',
          'Creación de mapas mentales', 
          'Generación de cuestionarios',
          'Contenido de evaluaciones'
        ]
      });
    }

    // No hay API configurada
    const reason = 'No se encontró OPENROUTER_API_KEY ni GOOGLE_API_KEY configuradas';
    console.log('❌ AI inactive:', reason);
    return NextResponse.json({
      isActive: false,
      reason,
      instructions: 'Configura OPENROUTER_API_KEY (recomendado) o GOOGLE_API_KEY en .env.local o en Vercel.',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('💥 Error checking AI status:', error);
    const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 0);
    const hasGoogleAI = !!(process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    
    return NextResponse.json({
      isActive: hasOpenRouter || hasGoogleAI,
      reason: hasOpenRouter ? 'IA via OpenRouter (modo respaldo)' : hasGoogleAI ? 'IA via Google (modo respaldo)' : 'Error de configuración',
      error: error instanceof Error ? error.message : 'Error desconocido',
      timestamp: new Date().toISOString()
    });
  }
}
