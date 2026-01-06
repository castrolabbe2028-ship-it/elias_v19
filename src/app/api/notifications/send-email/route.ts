import { NextRequest, NextResponse } from 'next/server';

/**
 * API para enviar notificaciones por email
 * POST /api/notifications/send-email
 * 
 * Correo de envío: notificaciones@smartstudent.online
 * 
 * NOTA: En producción, instalar nodemailer: npm install nodemailer @types/nodemailer
 * y descomentar la configuración SMTP
 */

// Configuración del transportador de email
// En producción, usar variables de entorno para las credenciales
const createTransporter = async (): Promise<any> => {
  // Verificar si hay configuración SMTP disponible
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpHost && smtpUser && smtpPass) {
    try {
      // Importar nodemailer dinámicamente solo si está configurado SMTP
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer');
      return nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
    } catch (err) {
      console.warn('⚠️ [EMAIL API] nodemailer not installed, running in development mode');
      return null;
    }
  }

  // Fallback: modo desarrollo (no envía emails reales, solo los logea)
  console.log('⚠️ [EMAIL API] SMTP not configured, running in development mode');
  return null;
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

    console.log('📧 [EMAIL API] Processing email request:', {
      from: from || 'notificaciones@smartstudent.online',
      to,
      subject,
      type
    });

    const transporter = await createTransporter();

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

    if (transporter) {
      // Enviar email real
      const info = await transporter.sendMail({
        from: `"Smart Student" <${from || 'notificaciones@smartstudent.online'}>`,
        to: `"${toName}" <${to}>`,
        subject: subject,
        html: htmlContent,
      });

      console.log('✅ [EMAIL API] Email sent successfully:', info.messageId);

      return NextResponse.json({
        success: true,
        message: 'Email sent successfully',
        messageId: info.messageId
      });
    } else {
      // Modo desarrollo: simular envío
      console.log('📧 [EMAIL API] Development mode - Email would be sent:');
      console.log('  To:', to);
      console.log('  Subject:', subject);
      console.log('  Type:', type);
      console.log('  Content preview:', content.substring(0, 100) + '...');

      // Guardar en localStorage para debugging (solo en desarrollo)
      // Esto permite ver los emails "enviados" en la consola del navegador

      return NextResponse.json({
        success: true,
        message: 'Email logged (development mode)',
        developmentMode: true,
        emailData: {
          to,
          toName,
          subject,
          type,
          title,
          contentPreview: content.substring(0, 200)
        }
      });
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
                  <span style="color: #718096;">📚 Curso:</span> <strong style="color: #2d3748;">${data.courseName}${data.sectionName ? ` - ${data.sectionName}` : ''}</strong>
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
                <a href="https://smartstudent.online/dashboard" 
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
                Para desactivar estas notificaciones, ve a tu <a href="https://smartstudent.online/dashboard/perfil" style="color: #90cdf4; text-decoration: none;">perfil</a>.
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
