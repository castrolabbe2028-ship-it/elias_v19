# Configuración de OpenRouter para ELIVAS

## ✅ Estado: Configurado y Funcionando

OpenRouter ha sido configurado exitosamente en tu proyecto.

## Archivos Creados/Modificados

1. **`.env.local`** - Variables de entorno con tu API key de OpenRouter
2. **`src/lib/openrouter.ts`** - Cliente de OpenRouter con métodos para:
   - `generateContent()` - Generar contenido de texto
   - `generateJSON()` - Generar y parsear JSON automáticamente
   - `generateEvaluation()` - Generar evaluaciones educativas
   - `generateSummary()` - Generar resúmenes
   - `generateSlideContent()` - Generar contenido para diapositivas

3. **`src/ai/genkit.ts`** - Actualizado para soportar OpenRouter como proveedor principal
4. **`src/app/api/generate-questions/route.ts`** - Actualizado para usar OpenRouter
5. **`src/app/api/test-ai/route.ts`** - Endpoint de prueba

## Cómo Probar

Visita esta URL para verificar que OpenRouter funciona:
```
http://localhost:9002/api/test-ai
```

## Modelos Disponibles en OpenRouter

Puedes cambiar el modelo en `.env.local` modificando `OPENROUTER_MODEL`:

| Modelo | Descripción | Costo aproximado |
|--------|-------------|------------------|
| `openai/gpt-4o-mini` | Rápido y económico (default) | $0.15/1M tokens |
| `openai/gpt-4o` | Más capaz | $2.50/1M tokens |
| `anthropic/claude-3.5-sonnet` | Claude más reciente | $3/1M tokens |
| `google/gemini-pro` | Google Gemini | $0.25/1M tokens |
| `meta-llama/llama-3.1-70b-instruct` | Open source | $0.60/1M tokens |

## Uso en el Código

```typescript
import { openrouter } from '@/lib/openrouter';

// Generar contenido simple
const response = await openrouter.generateContent('Tu prompt aquí');

// Generar JSON estructurado
const data = await openrouter.generateJSON<MiTipo>('Tu prompt aquí');

// Generar evaluación
const evaluation = await openrouter.generateEvaluation('Fotosíntesis', {
  questionCount: 10,
  language: 'es'
});
```

## Prioridad de Proveedores

El sistema usa este orden de prioridad:
1. **OpenRouter** (si `OPENROUTER_API_KEY` está configurado)
2. **Google AI / Gemini** (si `GOOGLE_API_KEY` está configurado)
3. **Fallback local** (genera contenido básico si no hay APIs)

## Tu API Key

Tu API key de OpenRouter está configurada en `.env.local`:
```
OPENROUTER_API_KEY=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
```

> ⚠️ **Importante**: No compartas esta API key públicamente. Está incluida en `.gitignore` automáticamente.
