<p align="center">
  <img src="public/graduation-cap.svg" alt="Smart Student Web" width="120" />
</p>

<h1 align="center">🎓 SMART STUDENT WEB</h1>

<p align="center">
  <strong>Plataforma Integral de Gestión Educativa con IA</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-Diciembre%202025-blue?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/Next.js-16.1-black?style=for-the-badge&logo=next.js" alt="Next.js" />
  <img src="https://img.shields.io/badge/React-18.3-61DAFB?style=for-the-badge&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Firebase-11.9-FFCA28?style=for-the-badge&logo=firebase" alt="Firebase" />
  <img src="https://img.shields.io/badge/Genkit%20AI-1.12-4285F4?style=for-the-badge&logo=google" alt="Genkit" />
</p>

<p align="center">
  <a href="#-características">Características</a> •
  <a href="#-instalación">Instalación</a> •
  <a href="#-módulos">Módulos</a> •
  <a href="#-tecnologías">Tecnologías</a> •
  <a href="#-api">API</a>
</p>

---

## 📋 Descripción

**Smart Student Web** es una plataforma educativa completa que integra inteligencia artificial para automatizar y optimizar la gestión escolar. Diseñada para administradores, profesores, estudiantes y apoderados.

### 🎯 Objetivo Principal
Transformar la gestión educativa mediante IA generativa (Genkit + Gemini) para crear evaluaciones personalizadas, automatizar tareas administrativas y proporcionar insights en tiempo real.

---

## ✨ Características

### 🤖 Inteligencia Artificial
- **Generación de Evaluaciones** — Crea pruebas específicas por tema con IA
- **Análisis de Contenido PDF** — Extracción inteligente de texto y temas
- **Evaluaciones Adaptativas** — Preguntas ajustadas al nivel del estudiante

### 📊 Gestión Académica
- **Calificaciones** — Sistema completo con carga masiva CSV
- **Asistencia** — Control diario con reportes automáticos
- **Tareas** — Asignación, seguimiento y calificación
- **Libros Digitales** — Biblioteca integrada con OCR

### 👥 Gestión de Usuarios
- **Multi-rol** — Admin, Profesor, Estudiante, Apoderado
- **Firebase Auth** — Autenticación segura
- **Perfiles Personalizados** — Dashboard adaptado por rol

### 📈 Reportes y Estadísticas
- **KPIs en Tiempo Real** — Métricas de rendimiento
- **Gráficos Interactivos** — Visualizaciones con Recharts
- **Exportación** — PDF, Excel, Word, PowerPoint

### 💬 Comunicación
- **Notificaciones** — Sistema de alertas en tiempo real
- **Mensajería** — Comunicación entre roles
- **Calendario** — Eventos y recordatorios

---

## 🚀 Instalación

### Requisitos Previos
- Node.js 18+
- npm o yarn
- Cuenta de Google Cloud (para Genkit AI)
- Firebase Project

### Pasos

```bash
# 1. Clonar repositorio
git clone https://github.com/tu-usuario/smart-student-web.git
cd smart-student-web

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env.local

# 4. Iniciar desarrollo
npm run dev
```

### Variables de Entorno

```env
# Google AI (Genkit)
GOOGLE_API_KEY=tu_api_key_aqui

# Firebase
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Cloudinary (Imágenes)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# App
NEXT_PUBLIC_API_URL=http://localhost:9002
```

---

## 📦 Módulos

| Módulo | Descripción | Ruta |
|--------|-------------|------|
| 🏠 **Dashboard** | Panel principal con KPIs | `/dashboard` |
| 📝 **Evaluaciones** | Generación IA de pruebas | `/dashboard/evaluacion` |
| 📊 **Calificaciones** | Gestión de notas | `/dashboard/calificaciones` |
| ✅ **Asistencia** | Control de asistencia | `/dashboard/asistencia` |
| 📚 **Tareas** | Gestión de actividades | `/dashboard/tareas` |
| 📖 **Libros** | Biblioteca digital | `/dashboard/libros` |
| 📅 **Calendario** | Eventos y agenda | `/dashboard/calendario` |
| 💬 **Comunicaciones** | Mensajería interna | `/dashboard/comunicaciones` |
| 📈 **Estadísticas** | Reportes y gráficos | `/dashboard/estadisticas` |
| 👤 **Perfil** | Configuración usuario | `/dashboard/perfil` |
| ⚙️ **Admin** | Panel administrativo | `/dashboard/admin` |
| 👥 **Usuarios** | Gestión de usuarios | `/dashboard/gestion-usuarios` |

---

## 🛠 Tecnologías

### Frontend
| Tecnología | Versión | Uso |
|------------|---------|-----|
| Next.js | 16.1 | Framework React |
| React | 18.3 | UI Library |
| TypeScript | 5.x | Tipado estático |
| Tailwind CSS | 3.4 | Estilos |
| Radix UI | Latest | Componentes accesibles |
| Framer Motion | 12.x | Animaciones |
| Recharts | 2.15 | Gráficos |

### Backend & AI
| Tecnología | Versión | Uso |
|------------|---------|-----|
| Genkit | 1.12 | Framework IA |
| Google Generative AI | 0.24 | Modelo Gemini |
| Firebase | 11.9 | Auth & Database |
| Tesseract.js | 6.0 | OCR |

### Utilidades
| Tecnología | Uso |
|------------|-----|
| jsPDF | Generación PDF |
| xlsx | Procesamiento Excel |
| PapaParse | Parsing CSV |
| Cloudinary | Gestión imágenes |

---

## 🔌 API

### Endpoints Principales

#### `POST /api/generate-evaluation`
Genera evaluaciones con IA.

```typescript
// Request
{
  "course": "4to Básico",
  "subject": "Ciencias Naturales",
  "topic": "Sistema Respiratorio",
  "numQuestions": 10
}

// Response
{
  "id": "eval_abc123",
  "questions": [
    {
      "type": "mcq",
      "question": "¿Cuál es la función principal de los pulmones?",
      "options": ["A) Bombear sangre", "B) Intercambio gaseoso", ...],
      "correctAnswer": "B"
    }
  ]
}
```

#### `POST /api/extract-pdf-content`
Extrae contenido de PDFs.

```typescript
// Request (multipart/form-data)
file: <archivo.pdf>

// Response
{
  "pages": 12,
  "topics": ["Sistema Respiratorio", "Célula"],
  "text": "Contenido extraído..."
}
```

---

## 📂 Estructura del Proyecto

```
src/
├── ai/                    # Flujos Genkit IA
│   ├── flows/            # Definición de flujos
│   └── prompts/          # Templates de prompts
├── app/                   # App Router Next.js
│   ├── api/              # API Routes
│   ├── dashboard/        # Páginas dashboard
│   └── login/            # Autenticación
├── components/            # Componentes React
│   ├── ui/               # Componentes base
│   └── dashboard/        # Componentes específicos
├── contexts/              # React Contexts
├── hooks/                 # Custom Hooks
├── lib/                   # Utilidades y datos
├── services/              # Servicios externos
├── types/                 # Definiciones TypeScript
└── utils/                 # Funciones helper
```

---

## 🖥 Comandos

```bash
# Desarrollo
npm run dev              # Servidor desarrollo (puerto 9002)
npm run genkit:dev       # Genkit AI local

# Build
npm run build            # Compilar producción
npm run start            # Iniciar producción

# Calidad
npm run lint             # ESLint
npm run typecheck        # TypeScript check

# Utilidades
npm run import:grades    # Importar calificaciones
npm run firebase:check   # Verificar Firebase
```

---

## 🔧 Solución de Problemas

### QuotaExceededError (localStorage)
```javascript
// En consola del navegador
localStorage.clear(); // Limpieza total
// o selectiva:
Object.keys(localStorage)
  .filter(k => k.startsWith('smart-student-'))
  .forEach(k => localStorage.removeItem(k));
```

### Error de API Key
1. Verificar `GOOGLE_API_KEY` en `.env.local`
2. Reiniciar servidor de desarrollo
3. Verificar cuota en Google Cloud Console

### Firebase Connection
```bash
npm run firebase:check  # Diagnóstico
```

---

## 📊 Estado del Proyecto

| Funcionalidad | Estado |
|---------------|--------|
| Evaluaciones IA | ✅ Completado |
| Calificaciones | ✅ Completado |
| Asistencia | ✅ Completado |
| Tareas | ✅ Completado |
| Comunicaciones | ✅ Completado |
| Multi-idioma | ✅ Completado |
| PWA | 🔄 En progreso |
| App Móvil | 📋 Planificado |

---

## 🤝 Contribuir

1. Fork del repositorio
2. Crear rama feature: `git checkout -b feature/nueva-funcionalidad`
3. Commit cambios: `git commit -m 'feat: nueva funcionalidad'`
4. Push: `git push origin feature/nueva-funcionalidad`
5. Crear Pull Request

### Convenciones de Commits
- `feat:` Nueva funcionalidad
- `fix:` Corrección de bug
- `docs:` Documentación
- `style:` Formato/estilos
- `refactor:` Refactorización
- `test:` Tests

---

## 📄 Licencia

MIT License - ver [LICENSE](LICENSE) para detalles.

---

<p align="center">
  <strong>Desarrollado con ❤️ para la educación</strong>
</p>

<p align="center">
  <sub>Versión Diciembre 2025 | Smart Student Web</sub>
</p>
