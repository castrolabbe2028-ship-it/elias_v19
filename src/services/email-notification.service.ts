/**
 * Servicio de Notificaciones por Email
 * 
 * Este servicio maneja el envío de notificaciones por correo electrónico
 * cuando un estudiante o apoderado tiene activada esta opción en su perfil.
 * 
 * Correo de envío: notificaciones@smartstudent.cl
 */

// Tipos de notificaciones que pueden enviarse por email
export type NotificationType = 
  | 'communication'      // Comunicación del profesor
  | 'task_assigned'      // Nueva tarea asignada
  | 'task_graded'        // Tarea calificada
  | 'task_comment'       // Comentario en tarea
  | 'grade_published'    // Calificación publicada
  | 'evaluation_result'  // Resultado de evaluación
  | 'general';           // Notificación general

export interface EmailNotificationPayload {
  type: NotificationType;
  recipientUserId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
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

export interface EmailNotificationResult {
  success: boolean;
  message: string;
  emailSent?: boolean;
  recipientEmail?: string;
}

const SENDER_EMAIL = 'notificaciones@smartstudent.cl';

// Usar siempre URL relativa para la API local
const API_BASE_URL = '/api';

// Rate limiter para evitar errores 429 de Resend (max 2 req/seg)
let lastEmailSentTime = 0;
const MIN_EMAIL_INTERVAL_MS = 600; // 600ms entre cada email

const waitForRateLimit = async (): Promise<void> => {
  const now = Date.now();
  const timeSinceLastEmail = now - lastEmailSentTime;
  if (timeSinceLastEmail < MIN_EMAIL_INTERVAL_MS) {
    const waitTime = MIN_EMAIL_INTERVAL_MS - timeSinceLastEmail;
    console.log(`📧 [EMAIL SERVICE] Rate limiting: waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastEmailSentTime = Date.now();
};

class EmailNotificationService {
  private static instance: EmailNotificationService;

  static getInstance(): EmailNotificationService {
    if (!EmailNotificationService.instance) {
      EmailNotificationService.instance = new EmailNotificationService();
    }
    return EmailNotificationService.instance;
  }

  /**
   * Verifica si un usuario tiene activadas las notificaciones por email
   * Por defecto, si no hay preferencia guardada, se envía el email
   * Solo se bloquea si explícitamente está en 'false'
   */
  hasEmailNotificationsEnabled(userId: string): boolean {
    try {
      // Verificar si estamos en el navegador
      if (typeof window === 'undefined') {
        console.log(`📧 [EMAIL SERVICE] Running on server, assuming enabled for ${userId}`);
        return true; // En el servidor, asumimos que sí para que el email llegue a la API
      }
      const savedPref = localStorage.getItem(`emailNotifications_${userId}`);
      console.log(`📧 [EMAIL SERVICE] Checking email pref for ${userId}: "${savedPref}"`);
      
      // Si está explícitamente en 'false', no enviar
      // Si no hay preferencia o está en 'true', enviar
      if (savedPref === 'false') {
        return false;
      }
      return true; // Por defecto, enviar emails
    } catch (error) {
      console.warn('⚠️ [EMAIL SERVICE] Error checking notification preference:', error);
      return true; // En caso de error, enviar por defecto
    }
  }

  /**
   * Obtiene la información del usuario para enviar el email
   * Busca en múltiples fuentes: usuarios generales, estudiantes y apoderados
   */
  getUserEmailInfo(userId: string): { email: string; name: string } | null {
    try {
      console.log(`📧 [EMAIL SERVICE] Looking for email info for userId: ${userId}`);
      
      const savedYear = Number(localStorage.getItem('admin-selected-year') || '');
      const currentYear = Number.isFinite(savedYear) && savedYear > 0 ? savedYear : new Date().getFullYear();
      
      // 1) Buscar en usuarios generales
      const storedUsers = localStorage.getItem('smart-student-users');
      if (storedUsers) {
        const users = JSON.parse(storedUsers);
        const user = users.find((u: any) => 
          String(u.id) === String(userId) || 
          u.username === userId ||
          u.id === userId
        );
        if (user && user.email) {
          console.log(`📧 [EMAIL SERVICE] Found in users: ${user.email}`);
          return {
            email: user.email,
            name: user.displayName || user.username || 'Usuario'
          };
        }
      }
      
      // 2) Buscar en estudiantes del año actual
      const storedStudents = localStorage.getItem(`smart-student-students-${currentYear}`);
      if (storedStudents) {
        const students = JSON.parse(storedStudents);
        const student = students.find((s: any) => 
          String(s.id) === String(userId) || 
          String(s.username) === String(userId) ||
          s.id === userId ||
          // También buscar por RUT si el userId es un RUT
          (s.rut && (s.rut === userId || s.rut.replace(/\./g, '').replace('-', '') === userId.replace(/\./g, '').replace('-', '')))
        );
        if (student && student.email) {
          console.log(`📧 [EMAIL SERVICE] Found in students-${currentYear}: ${student.email}`);
          return {
            email: student.email,
            name: student.displayName || student.name || student.username || 'Estudiante'
          };
        }
      }
      
      // 3) Buscar en apoderados del año actual
      const storedGuardians = localStorage.getItem(`smart-student-guardians-${currentYear}`);
      if (storedGuardians) {
        const guardians = JSON.parse(storedGuardians);
        const guardian = guardians.find((g: any) => 
          String(g.id) === String(userId) || 
          String(g.username) === String(userId) ||
          g.id === userId ||
          // También buscar por RUT
          (g.rut && (g.rut === userId || g.rut.replace(/\./g, '').replace('-', '') === userId.replace(/\./g, '').replace('-', '')))
        );
        if (guardian && guardian.email) {
          console.log(`📧 [EMAIL SERVICE] Found in guardians-${currentYear}: ${guardian.email}`);
          return {
            email: guardian.email,
            name: guardian.displayName || guardian.name || guardian.username || 'Apoderado'
          };
        }
      }
      
      // 4) Buscar en relaciones guardian-student (para obtener guardianId y luego buscar su email)
      let guardianRelations = JSON.parse(localStorage.getItem(`smart-student-guardian-student-relations-${currentYear}`) || '[]');
      if (guardianRelations.length === 0) {
        guardianRelations = JSON.parse(localStorage.getItem('smart-student-guardian-student-relations') || '[]');
      }
      
      const relationForGuardian = guardianRelations.find((rel: any) => 
        String(rel.guardianId) === String(userId) || rel.guardianId === userId
      );
      if (relationForGuardian) {
        // Buscar el email del apoderado en la lista de guardians o users
        const guardiansData = localStorage.getItem(`smart-student-guardians-${currentYear}`);
        if (guardiansData) {
          const guardians = JSON.parse(guardiansData);
          const g = guardians.find((gu: any) => 
            String(gu.id) === String(relationForGuardian.guardianId) ||
            gu.username === relationForGuardian.guardianUsername
          );
          if (g && g.email) {
            console.log(`📧 [EMAIL SERVICE] Found guardian via relations: ${g.email}`);
            return {
              email: g.email,
              name: g.displayName || g.name || g.username || 'Apoderado'
            };
          }
        }
      }
      
      console.log(`📧 [EMAIL SERVICE] No email found for userId: ${userId}`);
    } catch (error) {
      console.warn('⚠️ [EMAIL SERVICE] Error getting user email info:', error);
    }
    return null;
  }

  /**
   * Envía una notificación por email si el usuario tiene la opción activada
   */
  async sendEmailNotification(payload: EmailNotificationPayload): Promise<EmailNotificationResult> {
    const { recipientUserId, recipientEmail, recipientName, subject, title, content, type, metadata } = payload;

    // Verificar si el usuario tiene activadas las notificaciones por email
    if (!this.hasEmailNotificationsEnabled(recipientUserId)) {
      console.log(`📧 [EMAIL SERVICE] User ${recipientUserId} has email notifications disabled`);
      return {
        success: true,
        message: 'Email notifications disabled for this user',
        emailSent: false
      };
    }

    // Verificar que tenga email
    if (!recipientEmail) {
      console.warn(`⚠️ [EMAIL SERVICE] No email found for user ${recipientUserId}`);
      return {
        success: false,
        message: 'No email address found for user',
        emailSent: false
      };
    }

    try {
      console.log(`📧 [EMAIL SERVICE] Sending email notification to ${recipientEmail}`);
      
      // Esperar rate limit antes de enviar
      await waitForRateLimit();
      
      // Llamar a la API para enviar el email
      const response = await fetch(`${API_BASE_URL}/notifications/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: SENDER_EMAIL,
          to: recipientEmail,
          toName: recipientName,
          subject: subject,
          type: type,
          title: title,
          content: content,
          metadata: metadata
        }),
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`✅ [EMAIL SERVICE] Email sent successfully to ${recipientEmail}`);
        return {
          success: true,
          message: 'Email notification sent successfully',
          emailSent: true,
          recipientEmail: recipientEmail
        };
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.warn(`⚠️ [EMAIL SERVICE] Failed to send email:`, errorData);
        return {
          success: false,
          message: errorData.error || 'Failed to send email',
          emailSent: false
        };
      }
    } catch (error) {
      console.error('❌ [EMAIL SERVICE] Error sending email notification:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        emailSent: false
      };
    }
  }

  /**
   * Envía notificaciones por email a múltiples usuarios
   * El rate limiting se aplica automáticamente en sendEmailNotification
   */
  async sendBulkEmailNotifications(
    userIds: string[],
    notificationData: Omit<EmailNotificationPayload, 'recipientUserId' | 'recipientEmail' | 'recipientName'>
  ): Promise<{ sent: number; failed: number; disabled: number }> {
    let sent = 0;
    let failed = 0;
    let disabled = 0;

    console.log(`📧 [EMAIL SERVICE] sendBulkEmailNotifications called with ${userIds.length} users:`, userIds);

    for (const userId of userIds) {
      const userInfo = this.getUserEmailInfo(userId);
      
      if (!userInfo) {
        console.log(`📧 [EMAIL SERVICE] No email info found for user ${userId}`);
        failed++;
        continue;
      }

      console.log(`📧 [EMAIL SERVICE] Found email for ${userId}: ${userInfo.email}`);

      const result = await this.sendEmailNotification({
        ...notificationData,
        recipientUserId: userId,
        recipientEmail: userInfo.email,
        recipientName: userInfo.name
      });

      if (result.emailSent) {
        sent++;
      } else if (result.success && !result.emailSent) {
        disabled++;
      } else {
        failed++;
      }
    }

    console.log(`📧 [EMAIL SERVICE] Bulk send results: ${sent} sent, ${failed} failed, ${disabled} disabled`);
    return { sent, failed, disabled };
  }

  /**
   * Crea el contenido del email basado en el tipo de notificación
   */
  createEmailContent(type: NotificationType, data: {
    title: string;
    content: string;
    senderName?: string;
    courseName?: string;
    sectionName?: string;
    taskTitle?: string;
    grade?: number;
    feedback?: string;
  }): { subject: string; htmlContent: string } {
    const baseSubject = {
      'communication': `📢 Nueva comunicación: ${data.title}`,
      'task_assigned': `📝 Nueva tarea asignada: ${data.taskTitle || data.title}`,
      'task_graded': `✅ Tu tarea ha sido calificada: ${data.taskTitle || data.title}`,
      'task_comment': `💬 Nuevo comentario en tu tarea: ${data.taskTitle || data.title}`,
      'grade_published': `📊 Nueva calificación publicada`,
      'evaluation_result': `📋 Resultado de evaluación disponible`,
      'general': `🔔 ${data.title}`
    };

    const subject = baseSubject[type] || `🔔 Notificación de Smart Student`;

    const htmlContent = this.generateHtmlEmail({
      type,
      ...data
    });

    return { subject, htmlContent };
  }

  /**
   * Genera el HTML del email
   */
  private generateHtmlEmail(data: {
    type: NotificationType;
    title: string;
    content: string;
    senderName?: string;
    courseName?: string;
    sectionName?: string;
    taskTitle?: string;
    grade?: number;
    feedback?: string;
  }): string {
    const typeLabels: Record<NotificationType, string> = {
      'communication': 'Comunicación',
      'task_assigned': 'Nueva Tarea',
      'task_graded': 'Tarea Calificada',
      'task_comment': 'Comentario en Tarea',
      'grade_published': 'Calificación Publicada',
      'evaluation_result': 'Resultado de Evaluación',
      'general': 'Notificación'
    };

    // Logo SVG de Smart Student en azul
    const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5"/></svg>`;

    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header with Logo -->
          <tr>
            <td style="padding: 40px 40px 30px 40px; text-align: center; background-color: #ffffff;">
              ${logoSvg}
              <p style="color: #3B82F6; margin: 15px 0 0 0; font-size: 16px; font-weight: 500; letter-spacing: 0.5px;">
                ${typeLabels[data.type]}
              </p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">
                ${data.title}
              </h2>
              
              ${data.senderName ? `
              <p style="color: #6b7280; margin: 0 0 15px 0; font-size: 14px;">
                <strong>De:</strong> ${data.senderName}
              </p>
              ` : ''}
              
              ${data.courseName ? `
              <p style="color: #6b7280; margin: 0 0 15px 0; font-size: 14px;">
                <strong>Curso:</strong> ${data.courseName}
              </p>
              ` : ''}
              
              <div style="background-color: #f9fafb; border-left: 4px solid #3B82F6; padding: 20px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                <p style="color: #374151; margin: 0; font-size: 15px; line-height: 1.6;">
                  ${data.content}
                </p>
              </div>
              
              ${data.grade !== undefined ? `
              <div style="background-color: #ecfdf5; border: 1px solid #10b981; padding: 15px 20px; margin: 20px 0; border-radius: 8px; text-align: center;">
                <p style="color: #059669; margin: 0; font-size: 14px; font-weight: 500;">Calificación</p>
                <p style="color: #047857; margin: 5px 0 0 0; font-size: 28px; font-weight: 700;">${data.grade}%</p>
              </div>
              ` : ''}
              
              ${data.feedback ? `
              <div style="margin: 20px 0;">
                <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px; font-weight: 500;">Retroalimentación:</p>
                <p style="color: #374151; margin: 0; font-size: 14px; line-height: 1.6; font-style: italic;">
                  "${data.feedback}"
                </p>
              </div>
              ` : ''}
              
              <div style="margin-top: 30px; text-align: center;">
                <a href="https://smartstudent.cl/dashboard" 
                   style="display: inline-block; background-color: #3B82F6; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 8px; font-weight: 500; font-size: 14px;">
                  Ver en Smart Student
                </a>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; margin: 0; font-size: 12px;">
                Este correo fue enviado automáticamente desde Smart Student.
              </p>
              <p style="color: #9ca3af; margin: 10px 0 0 0; font-size: 12px;">
                Si no deseas recibir estas notificaciones, puedes desactivarlas en tu perfil.
              </p>
              <p style="color: #9ca3af; margin: 10px 0 0 0; font-size: 11px;">
                © ${new Date().getFullYear()} Smart Student. Todos los derechos reservados.
              </p>
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
}

// Exportar instancia singleton
export const emailNotificationService = EmailNotificationService.getInstance();

/**
 * Función helper para enviar notificación por email cuando se crea una notificación en la campana
 * Esta función debe ser llamada cada vez que se cree una notificación
 */
export async function sendEmailOnNotification(
  type: NotificationType,
  recipientUserIds: string[],
  data: {
    title: string;
    content: string;
    senderName?: string;
    courseName?: string;
    sectionName?: string;
    taskTitle?: string;
    grade?: number;
    feedback?: string;
  }
): Promise<void> {
  const { subject, htmlContent } = emailNotificationService.createEmailContent(type, data);

  await emailNotificationService.sendBulkEmailNotifications(
    recipientUserIds,
    {
      type,
      subject,
      title: data.title,
      content: data.content,
      metadata: {
        taskTitle: data.taskTitle,
        courseName: data.courseName,
        sectionName: data.sectionName,
        senderName: data.senderName,
        grade: data.grade,
        feedback: data.feedback
      }
    }
  );
}
