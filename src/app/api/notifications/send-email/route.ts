import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

/**
 * API para enviar notificaciones por email
 * POST /api/notifications/send-email
 * 
 * Correo de envío: notificaciones@smartstudent.cl
 * 
 * Usando Sender.net SMTP (15,000 emails/mes gratis) - PRINCIPAL
 * Fallback: Resend API (3,000 emails/mes gratis)
 */

// Configuración de Sender.net SMTP
const SENDER_SMTP_USER = process.env.SENDER_SMTP_USER || '';
const SENDER_SMTP_PASS = process.env.SENDER_SMTP_PASS || '';
// Configuración de Resend (fallback)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.EMAIL_FROM || 'notificaciones@smartstudent.cl';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Smart Student';

// Crear transporter de nodemailer para Sender.net SMTP
const createSenderTransporter = () => {
  return nodemailer.createTransport({
    host: 'smtp.sender.net',
    port: 587,
    secure: false, // TLS
    auth: {
      user: SENDER_SMTP_USER,
      pass: SENDER_SMTP_PASS,
    },
  });
};

/**
 * Envía un email usando Sender.net SMTP
 */
const sendWithSenderNet = async (emailData: {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  subject: string;
  html: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> => {
  try {
    console.log('📧 [SENDER.NET SMTP] Sending to:', emailData.to);
    
    if (!SENDER_SMTP_USER || !SENDER_SMTP_PASS) {
      console.warn('⚠️ [SENDER.NET] SMTP credentials not configured, trying Resend...');
      return { success: false, error: 'Sender.net SMTP credentials not configured' };
    }

    const transporter = createSenderTransporter();
    
    const info = await transporter.sendMail({
      from: `"${emailData.fromName}" <${emailData.from}>`,
      to: emailData.to,
      subject: emailData.subject,
      html: emailData.html,
    });

    console.log('✅ [SENDER.NET SMTP] Email sent successfully:', info.messageId);
    return { 
      success: true, 
      messageId: info.messageId 
    };
  } catch (error) {
    console.error('❌ [SENDER.NET SMTP] Exception:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

/**
 * Envía un email usando Resend API (fallback)
 */
const sendWithResend = async (emailData: {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  subject: string;
  html: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> => {
  try {
    console.log('📧 [RESEND] Sending to:', emailData.to);
    
    if (!RESEND_API_KEY) {
      console.error('❌ [RESEND] API key not configured');
      return { 
        success: false, 
        error: 'Resend API key not configured. Set RESEND_API_KEY in .env.local' 
      };
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${emailData.fromName} <${emailData.from}>`,
        to: [emailData.to],
        subject: emailData.subject,
        html: emailData.html,
      }),
    });

    const responseText = await response.text();
    console.log('📧 [RESEND] Response status:', response.status);
    console.log('📧 [RESEND] Response:', responseText);

    if (response.ok) {
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        result = { id: 'sent' };
      }
      console.log('✅ [RESEND] Email sent successfully:', result.id);
      return { 
        success: true, 
        messageId: result.id || 'sent' 
      };
    } else {
      console.error('❌ [RESEND] API error:', responseText);
      return { 
        success: false, 
        error: `Resend API error: ${response.status} - ${responseText}` 
      };
    }
  } catch (error) {
    console.error('❌ [RESEND] Exception:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

interface EmailRequestBody {
  from: string;
  to: string;
  toName: string;
  subject: string;
  type: string;
  title: string;
  content: string;
  metadata?: {
    taskTitle?: string;
    courseName?: string;
    sectionName?: string;
    senderName?: string;
    grade?: number;
    feedback?: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: EmailRequestBody = await request.json();
    
    const { from, to, toName, subject, type, title, content, metadata } = body;

    // Validar campos requeridos
    if (!to || !subject || !content) {
      return NextResponse.json(
        { error: 'Missing required fields: to, subject, content' },
        { status: 400 }
      );
    }

    const senderEmail = FROM_EMAIL;

    console.log('📧 [EMAIL] Processing email request:', {
      from: senderEmail,
      to,
      subject,
      type,
      provider: SENDER_SMTP_USER ? 'sender.net-smtp' : 'resend'
    });

    // Generar HTML del email
    const htmlContent = generateEmailHtml({
      type,
      title,
      content,
      senderName: metadata?.senderName,
      courseName: metadata?.courseName,
      sectionName: metadata?.sectionName,
      taskTitle: metadata?.taskTitle,
      grade: metadata?.grade,
      feedback: metadata?.feedback
    });

    const emailPayload = {
      from: senderEmail,
      fromName: FROM_NAME,
      to: to,
      toName: toName || 'Usuario',
      subject: subject,
      html: htmlContent
    };

    // 🆕 Intentar primero con Sender.net, fallback a Resend
    let result = await sendWithSenderNet(emailPayload);
    let usedProvider = 'sender.net';
    
    if (!result.success && RESEND_API_KEY) {
      console.log('📧 [EMAIL] Sender.net failed, trying Resend as fallback...');
      result = await sendWithResend(emailPayload);
      usedProvider = 'resend';
    }

    if (result.success) {
      console.log(`✅ [EMAIL] Email sent successfully via ${usedProvider}:`, result.messageId);
      return NextResponse.json({
        success: true,
        message: `Email sent successfully via ${usedProvider}`,
        messageId: result.messageId,
        provider: usedProvider
      });
    } else {
      console.error(`❌ [EMAIL] Failed to send email:`, result.error);
      return NextResponse.json(
        { 
          success: false,
          error: 'Failed to send email', 
          details: result.error
        },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('❌ [EMAIL API] Error processing email request:', error);
    
    return NextResponse.json(
      { 
        error: 'Error sending email', 
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

/**
 * Genera el HTML del email
 */
function generateEmailHtml(data: {
  type: string;
  title: string;
  content: string;
  senderName?: string;
  courseName?: string;
  sectionName?: string;
  taskTitle?: string;
  grade?: number;
  feedback?: string;
}): string {
  const typeConfig: Record<string, { label: string; emoji: string; gradient: string }> = {
    'communication': { label: 'Nueva Comunicación', emoji: '📢', gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
    'task_assigned': { label: 'Nueva Tarea Asignada', emoji: '📝', gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
    'task_graded': { label: '¡Tarea Calificada!', emoji: '🎉', gradient: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' },
    'task_comment': { label: 'Nuevo Comentario', emoji: '💬', gradient: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)' },
    'grade_published': { label: 'Calificación Publicada', emoji: '📊', gradient: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)' },
    'evaluation_result': { label: 'Resultado de Evaluación', emoji: '📋', gradient: 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)' },
    'general': { label: 'Notificación', emoji: '🔔', gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }
  };

  const config = typeConfig[data.type] || typeConfig['general'];

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 30px 15px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);">
          <!-- Header con gradiente y logo -->
          <tr>
            <td style="background: ${config.gradient}; padding: 40px 30px; text-align: center;">
              <div style="font-size: 60px; margin-bottom: 10px;">🎓</div>
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                Smart Student
              </h1>
              <div style="margin-top: 20px; padding: 12px 28px; background: rgba(255,255,255,0.25); border-radius: 30px; display: inline-block;">
                <span style="color: #ffffff; font-size: 15px; font-weight: 600;">
                  ${config.emoji} ${config.label}
                </span>
              </div>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 35px 40px;">
              <h2 style="color: #1a1a2e; margin: 0 0 25px 0; font-size: 22px; font-weight: 700; line-height: 1.3;">
                ${data.title}
              </h2>
              
              ${data.senderName || data.courseName ? `
              <div style="background: linear-gradient(135deg, #f8f9ff 0%, #f0f4ff 100%); padding: 18px 20px; border-radius: 12px; margin-bottom: 25px;">
                ${data.senderName ? `
                <p style="color: #4a5568; margin: 0 0 8px 0; font-size: 14px;">
                  <span style="color: #718096;">👤 De:</span> <strong style="color: #2d3748;">${data.senderName}</strong>
                </p>
                ` : ''}
                ${data.courseName ? `
                <p style="color: #4a5568; margin: 0; font-size: 14px;">
                  <span style="color: #718096;">📚 Curso:</span> <strong style="color: #2d3748;">${data.courseName}</strong>
                </p>
                ` : ''}
              </div>
              ` : ''}
              
              <div style="background: #ffffff; border: 2px solid #e8ecf4; border-radius: 12px; padding: 25px; margin: 20px 0;">
                <p style="color: #374151; margin: 0; font-size: 15px; line-height: 1.7;">
                  ${data.content}
                </p>
              </div>
              
              ${data.grade !== undefined ? `
              <div style="background: linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%); padding: 25px; margin: 25px 0; border-radius: 16px; text-align: center;">
                <p style="color: #1a5928; margin: 0 0 5px 0; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">🏆 Tu Calificación</p>
                <p style="color: #166534; margin: 0; font-size: 42px; font-weight: 800;">${data.grade}<span style="font-size: 20px; font-weight: 400;">%</span></p>
              </div>
              ` : ''}
              
              ${data.feedback ? `
              <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 20px; margin: 20px 0; border-radius: 0 12px 12px 0;">
                <p style="color: #92400e; margin: 0 0 10px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">💡 Retroalimentación del profesor</p>
                <p style="color: #78350f; margin: 0; font-size: 15px; line-height: 1.6; font-style: italic;">
                  "${data.feedback}"
                </p>
              </div>
              ` : ''}
              
              <div style="margin-top: 35px; text-align: center;">
                <a href="https://smartstudent.cl/dashboard" 
                   style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 50px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">
                  🚀 Ver en Smart Student
                </a>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px 40px; text-align: center;">
              <p style="color: #a0aec0; margin: 0; font-size: 13px;">
                Este correo fue enviado automáticamente desde Smart Student.
              </p>
              <p style="color: #718096; margin: 12px 0 0 0; font-size: 12px;">
                Para desactivar estas notificaciones, ve a tu <a href="https://smartstudent.cl/dashboard/perfil" style="color: #90cdf4; text-decoration: none;">perfil</a>.
              </p>
              <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #2d3748;">
                <p style="color: #4a5568; margin: 0; font-size: 11px;">
                  © ${new Date().getFullYear()} Smart Student • Plataforma de Gestión Educativa
                </p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
