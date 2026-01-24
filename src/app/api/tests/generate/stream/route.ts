import { NextResponse } from 'next/server'
import { generateEvaluationContent } from '@/ai/flows/generate-evaluation-content'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const topic = searchParams.get('topic') || ''
    const bookTitle = searchParams.get('bookTitle') || ''
    const language = (searchParams.get('language') === 'en' ? 'en' : 'es') as 'es' | 'en'
    const questionCount = Number(searchParams.get('questionCount') || '15') || 15
    const timeLimit = Number(searchParams.get('timeLimit') || '120') || 120
    
    // Cantidades específicas por tipo de pregunta
    const tfCount = Number(searchParams.get('tfCount') || '0')
    const mcCount = Number(searchParams.get('mcCount') || '0')
    const msCount = Number(searchParams.get('msCount') || '0')
    const desCount = Number(searchParams.get('desCount') || '0')

    if (!topic || !bookTitle) {
      return new Response('Missing topic or bookTitle', { status: 400 })
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: any) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }

        // Phase 1: preparing
        send('progress', { percent: 10, phase: 'phase1' })

        // Phase 2: querying AI (announce, then run)
        send('progress', { percent: 25, phase: 'phase2' })

        let result: any
        try {
          result = await generateEvaluationContent({
            topic,
            bookTitle,
            language,
            questionCount,
            timeLimit,
            // Pasar cantidades específicas si están definidas
            tfCount: tfCount || undefined,
            mcCount: mcCount || undefined,
            msCount: msCount || undefined,
          })
        } catch (e: any) {
          send('error', { message: e?.message || 'generation failed' })
          controller.close()
          return
        }

        // Phase 3: received content
        send('progress', { percent: 60, phase: 'phase3' })

        // Phase 4: assembling
        send('progress', { percent: 85, phase: 'phase4' })

        // Done
        send('done', { ok: true, data: result })
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    console.error('[API/tests/generate/stream] Error:', err)
    return NextResponse.json({ ok: false, error: err?.message || 'Internal error' }, { status: 500 })
  }
}
