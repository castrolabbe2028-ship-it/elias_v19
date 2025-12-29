'use client';

/**
 * AttendanceTrendCard - Componente modular para gráfico de tendencia de asistencia
 * Extraído de estadisticas/page.tsx para mejorar el rendimiento de carga
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useLanguage } from '@/contexts/language-context';
import TrendChart from '@/components/charts/TrendChart';
import { LocalStorageManager } from '@/lib/education-utils';
import type { Period, Level, Semester, AttendanceTrendCardProps } from '@/types/statistics';
import {
  getSemesterRange,
  getCalendarConfig,
  isInVacationRange,
  buildCourseLevelMap,
  buildStudentLevelMap,
  buildAllStudents,
  buildAttendanceYearIndex,
  keyOfDayLocal,
  parseTimestampOptimized,
  getTimeWindow,
  days,
  getDayAlignedRange,
  getMonthNames,
  inferLevelFromCourseName,
  normalizeCourseNameForMatch,
  extractGradeLevel,
  computeMonthlyAttendanceFromLocalStorage,
} from '@/lib/stats-utils';

/**
 * Normaliza un nombre a estilo de ID compatible con carga masiva
 * Ejemplo: "1ro Básico" -> "1ro_bsico", "2do Medio" -> "2do_medio"
 */
function toIdStyle(name: string | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Eliminar acentos
    .replace(/[^a-z0-9]+/g, '_')     // Reemplazar espacios y caracteres especiales por _
    .replace(/^_+|_+$/g, '');        // Eliminar _ al inicio y final
}

/**
 * Extrae la clave de grado de un nombre de curso (ej: "1ro Básico" -> "1basica")
 */
function extractCourseGradeKey(courseName: string): string {
  if (!courseName) return '';
  const normalized = courseName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  
  // Extraer número del grado
  const numMatch = normalized.match(/(\d+)/);
  const num = numMatch ? numMatch[1] : '';
  
  // Determinar nivel
  const level = /media|medio/i.test(normalized) ? 'media' : 'basica';
  
  return num ? `${num}${level}` : '';
}

// Re-export del tipo para compatibilidad
export type { AttendanceTrendCardProps };

// Componente responsivo de TrendChart (simplificado)
function ResponsiveTrendChart({
  data,
  labels,
  color,
  valueFormat,
  percentGrid,
  yAxis,
  highlightLastValue,
  yDomain,
  yTicks,
  forceAlignment,
  height = 200,
}: {
  data: number[];
  labels: string[];
  color: string;
  valueFormat?: (v: number) => string;
  percentGrid?: boolean;
  yAxis?: boolean;
  highlightLastValue?: boolean;
  yDomain?: { min: number; max: number };
  yTicks?: number[];
  forceAlignment?: boolean;
  height?: number;
}) {
  return (
    <TrendChart
      data={data}
      labels={labels}
      color={color}
      height={height}
      valueFormat={valueFormat}
      percentGrid={percentGrid}
      yAxis={yAxis}
      highlightLastValue={highlightLastValue}
      yDomain={yDomain}
      yTicks={yTicks}
      forceAlignment={forceAlignment}
    />
  );
}

/**
 * Componente principal: Gráfico temporal de asistencia alineado al Calendario
 */
export default function AttendanceTrendCard({
  period,
  teacherUsername,
  filters,
  titleSummary,
  blocked,
  year,
  sqlAttendanceByYear,
  isAttendanceSQLConnected,
  preloadStats,
  onChangePeriod,
  externalZoomY,
  onZoomChange,
  hideHeader,
}: AttendanceTrendCardProps) {
  const { translate, language } = useLanguage();
  const t = (key: string, fallback?: string) => {
    const v = translate(key);
    return v === key ? (fallback ?? key) : v;
  };

  // Filtro visual: serie de Presentes o Ausentes
  const [viewMode, setViewMode] = useState<'present' | 'absent'>('present');

  // Estado de zoom - iniciar con zoom activado por defecto
  const [internalZoomY, setInternalZoomY] = useState(true);
  const zoomY = externalZoomY !== undefined ? externalZoomY : internalZoomY;
  const setZoomY = (value: boolean | ((prev: boolean) => boolean)) => {
    const newValue = typeof value === 'function' ? value(zoomY) : value;
    if (onZoomChange) {
      onZoomChange(newValue);
    } else {
      setInternalZoomY(newValue);
    }
  };

  // Tick para reaccionar a cambios
  const [semTick, setSemTick] = useState(0);
  const [attTick, setAttTick] = useState(1);

  // Calcular longitud de datos SQL para detectar cambios
  const sqlDataLengthRef = useRef(0);
  const currentSqlDataLength = sqlAttendanceByYear?.[year]?.length ?? 0;

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === `smart-student-semesters-${year}` || e.key === 'smart-student-semesters') {
        setSemTick((t) => t + 1);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [year]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const k = e.key || '';
      if (/attendance|asistencia/i.test(k)) setAttTick((t) => t + 1);
    };
    const onSQL = () => setAttTick((t) => t + 1);
    window.addEventListener('storage', onStorage);
    window.addEventListener('sqlAttendanceUpdated' as any, onSQL as any);
    setAttTick((t) => t + 1);
    const t0 = setTimeout(() => setAttTick((t) => t + 1), 100);
    const t1 = setTimeout(() => setAttTick((t) => t + 1), 500);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('sqlAttendanceUpdated' as any, onSQL as any);
      clearTimeout(t0);
      clearTimeout(t1);
    };
  }, [year]);

  useEffect(() => {
    if (currentSqlDataLength > 0 && currentSqlDataLength !== sqlDataLengthRef.current) {
      sqlDataLengthRef.current = currentSqlDataLength;
      setAttTick((t) => t + 1);
    }
  }, [currentSqlDataLength]);

  const preloadStatsMonthlyLength = preloadStats?.attendanceMonthly
    ? Object.keys(preloadStats.attendanceMonthly).length
    : 0;
  useEffect(() => {
    if (preloadStatsMonthlyLength > 0) {
      setAttTick((t) => t + 1);
    }
  }, [preloadStatsMonthlyLength]);

  // Rango de fechas
  const timeWindow = getTimeWindow(period);
  const [fromTs, toTs] = useMemo(() => {
    const noDimFilters = !filters?.semester && !filters?.level && !filters?.courseId && !filters?.sectionId;

    try {
      const isCurrentYear = year === new Date().getFullYear();

      // Para año actual con período específico
      if (isCurrentYear && period !== 'all') {
        const look = period === '7d' ? 7 : period === '30d' ? 30 : 90;
        const { from: baseStart, to: nowTs } = getDayAlignedRange(look);
        if (filters?.semester) {
          const rng = getSemesterRange(year, filters.semester);
          const semStart = rng.start || baseStart;
          let semEnd = rng.end || nowTs;
          if (filters.semester === 'S2') semEnd = Math.min(semEnd, nowTs);
          const start = Math.max(semStart, baseStart);
          const end = Math.min(semEnd, nowTs);
          if (end >= start) return [start, end] as [number, number];
        }
        return [baseStart, nowTs] as [number, number];
      }

      // Con filtro de semestre
      if (filters?.semester) {
        const rng = getSemesterRange(year, filters.semester);
        if (rng.start && rng.end) {
          let endAdj = rng.end;
          if (year === new Date().getFullYear() && filters.semester === 'S2') {
            endAdj = Math.min(endAdj, Date.now());
          }
          return [rng.start, endAdj] as [number, number];
        }
        // Fallback
        if (filters.semester === 'S1') {
          return [
            new Date(year, 2, 1).getTime(),
            new Date(year, 5, 30, 23, 59, 59, 999).getTime(),
          ] as [number, number];
        } else {
          const dec15 = new Date(year, 11, 15, 23, 59, 59, 999).getTime();
          const end = year === new Date().getFullYear() ? Math.min(dec15, Date.now()) : dec15;
          return [new Date(year, 6, 1).getTime(), end] as [number, number];
        }
      }

      // Año actual sin filtros
      if (year === new Date().getFullYear() && noDimFilters && period === 'all') {
        const march1 = new Date(year, 2, 1, 0, 0, 0, 0).getTime();
        return [march1, Date.now()] as [number, number];
      }

      // Años pasados
      if (year < new Date().getFullYear()) {
        const yearStart = new Date(year, 0, 1, 0, 0, 0, 0).getTime();
        const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999).getTime();
        return [yearStart, yearEnd] as [number, number];
      }

      // Fallback
      const nowTs = Date.now();
      const f = timeWindow.from ?? nowTs - days(45);
      return [f, nowTs] as [number, number];
    } catch {
      const nowTs = Date.now();
      return [nowTs - days(45), nowTs] as [number, number];
    }
  }, [period, JSON.stringify(filters), year, semTick, attTick]);

  // Días válidos según Calendario
  const validDays: Date[] = useMemo(() => {
    const out: Date[] = [];
    if (!fromTs || !toTs || fromTs > toTs) return out;

    const start = new Date(fromTs);
    start.setHours(0, 0, 0, 0);
    const end = new Date(toTs);
    end.setHours(0, 0, 0, 0);
    const cursor = new Date(start);

    let iterations = 0;
    const MAX_ITERATIONS = 400;

    while (cursor <= end && iterations < MAX_ITERATIONS) {
      iterations++;
      const cfg = getCalendarConfig(cursor.getFullYear());
      const dow = cursor.getDay();
      const weekday = dow >= 1 && dow <= 5;
      const dayKey = keyOfDayLocal(cursor);
      const holiday = cfg.holidays.includes(dayKey);
      const summer = isInVacationRange(cursor, cfg.summer);
      const winter = isInVacationRange(cursor, cfg.winter);
      if (weekday && !holiday && !summer && !winter) out.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [fromTs, toTs]);

  const isPastYear = year < new Date().getFullYear();
  const appliedFilters = useMemo(() => filters, [JSON.stringify(filters)]);

  // Serie temporal principal
  const { presentSeries, absentSeries, labels, mode } = useMemo(() => {
    const effectiveFilters = appliedFilters;

    try {
      const noDimForAll =
        !effectiveFilters?.semester &&
        !effectiveFilters?.courseId &&
        !effectiveFilters?.sectionId &&
        !effectiveFilters?.level;
      const sqlDataNotReady =
        !sqlAttendanceByYear || !sqlAttendanceByYear[year] || sqlAttendanceByYear[year].length === 0;

      // Intentar usar datos preload o calcular desde localStorage
      let effectiveAttendanceMonthly =
        preloadStats?.year === year && preloadStats.attendanceMonthly
          ? preloadStats.attendanceMonthly
          : null;

      if (!effectiveAttendanceMonthly && sqlDataNotReady) {
        effectiveAttendanceMonthly = computeMonthlyAttendanceFromLocalStorage(year);
      }

      // Si hay datos mensuales disponibles
      if (effectiveAttendanceMonthly && sqlDataNotReady) {
        const months = Object.keys(effectiveAttendanceMonthly).sort();
        let filteredMonths = months;

        if (effectiveFilters?.semester === 'S1') {
          filteredMonths = months.filter((m) => {
            const monthNum = parseInt(m.split('-')[1] || '0');
            return monthNum >= 3 && monthNum <= 7;
          });
        } else if (effectiveFilters?.semester === 'S2') {
          filteredMonths = months.filter((m) => {
            const monthNum = parseInt(m.split('-')[1] || '0');
            return monthNum >= 8 && monthNum <= 12;
          });
        }

        filteredMonths = filteredMonths.filter((m) => {
          const v = effectiveAttendanceMonthly![m];
          return v && v.total > 0;
        });

        if (filteredMonths.length > 0) {
          const names = getMonthNames(language);
          const lab = filteredMonths.map((m) => {
            const [yy, mm] = m.split('-').map(Number);
            const monthIdx = Math.max(0, Math.min(11, (isNaN(mm) ? 1 : mm) - 1));
            return `${names[monthIdx]} ${String(yy || year).slice(-2)}`;
          });
          const series = filteredMonths.map((m) => {
            const v = effectiveAttendanceMonthly![m];
            return v && v.total > 0 ? (v.present / v.total) * 100 : 0;
          });
          return {
            presentSeries: series,
            absentSeries: series.map((v) => 100 - v),
            labels: lab,
            mode: 'monthly' as const,
          };
        }
      }

      // 🔧 PRIORIDAD: IndexedDB/SQL primero, localStorage como fallback
      let raw: any[] = [];
      
      // 1. Intentar primero desde IndexedDB/SQL (fuente principal)
      const sqlArr = sqlAttendanceByYear?.[year] || [];
      if (Array.isArray(sqlArr) && sqlArr.length > 0) {
        raw = sqlArr;
        console.log(`[AttendanceTrendCard] Usando ${sqlArr.length} registros de IndexedDB/SQL para año ${year}`);
      }
      
      // 2. Fallback a localStorage solo si IndexedDB está vacío
      if (raw.length === 0) {
        try {
          const a = LocalStorageManager.getAttendanceForYear?.(year) || [];
          if (Array.isArray(a) && a.length) {
            raw = a;
            console.log(`[AttendanceTrendCard] Fallback: Usando ${a.length} registros de LocalStorage para año ${year}`);
          }
        } catch {
          /* ignore */
        }
      }

      // 3. Fallback adicional a localStorage directo
      if (raw.length === 0) {
        try {
          raw = JSON.parse(localStorage.getItem(`smart-student-attendance-${year}`) || '[]');
          if (raw.length > 0) {
            console.log(`[AttendanceTrendCard] Fallback: Usando ${raw.length} registros de localStorage directo para año ${year}`);
          }
        } catch {
          raw = [];
        }
      }

      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          presentSeries: [],
          absentSeries: [],
          labels: [],
          mode: 'daily' as const,
        };
      }

      // Construir índice y filtrar
      const courseLevelMap = buildCourseLevelMap(year);
      const { dayIndex } = buildAttendanceYearIndex(year, raw);

      const startDay = new Date(fromTs);
      startDay.setHours(0, 0, 0, 0);
      const endDay = new Date(toTs);
      endDay.setHours(23, 59, 59, 999);

      const dayKeysInRange: string[] = [];
      const cursor = new Date(startDay);
      while (cursor.getTime() <= endDay.getTime()) {
        dayKeysInRange.push(keyOfDayLocal(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }

      const filtered: any[] = [];
      
      // Pre-calcular valores normalizados del filtro para comparaciones flexibles
      const filterCourseToIdStyle = effectiveFilters?.courseName 
        ? toIdStyle(effectiveFilters.courseName) 
        : (effectiveFilters?.courseId ? toIdStyle(effectiveFilters.courseId) : undefined);
      const filterCourseGradeKey = effectiveFilters?.courseName 
        ? extractCourseGradeKey(effectiveFilters.courseName) 
        : undefined;
      const filterSectionLetter = effectiveFilters?.sectionLetter?.toLowerCase() 
        || effectiveFilters?.sectionId?.toLowerCase();
      
      dayKeysInRange.forEach((k) => {
        const arr = dayIndex.get(k);
        if (!arr || !arr.length) return;
        arr.forEach((n) => {
          // Aplicar filtro de curso con múltiples métodos de coincidencia
          if (effectiveFilters?.courseId || effectiveFilters?.courseName) {
            const recCourseId = String(n.courseId || '');
            const recCourseName = String(n.raw?.course || n.raw?.courseName || '');
            const recCourseIdNorm = toIdStyle(recCourseId);
            const recCourseNameNorm = toIdStyle(recCourseName);
            const recGradeKey = extractCourseGradeKey(recCourseName) || extractCourseGradeKey(recCourseId);
            
            // Coincidencia directa por ID
            const matchesDirect = recCourseId === String(effectiveFilters.courseId);
            // Coincidencia por nombre normalizado
            const matchesByToIdStyle = filterCourseToIdStyle && (
              recCourseIdNorm === filterCourseToIdStyle ||
              recCourseNameNorm === filterCourseToIdStyle
            );
            // Coincidencia por grade key (1basica, 2basica, etc.)
            const matchesByGradeKey = filterCourseGradeKey && recGradeKey === filterCourseGradeKey;
            
            if (!matchesDirect && !matchesByToIdStyle && !matchesByGradeKey) {
              return; // No coincide con ningún método
            }
          }
          
          // Aplicar filtro de sección con coincidencia flexible
          if (effectiveFilters?.sectionId || effectiveFilters?.sectionLetter) {
            const recSectionId = String(n.sectionId || '').toLowerCase();
            const recSectionName = String(n.raw?.section || n.raw?.sectionName || '').toLowerCase();
            
            // Coincidencia directa
            const matchesDirect = recSectionId === String(effectiveFilters.sectionId)?.toLowerCase();
            // Coincidencia por letra de sección
            const matchesByLetter = filterSectionLetter && (
              recSectionId === filterSectionLetter ||
              recSectionName === filterSectionLetter ||
              recSectionId.includes(filterSectionLetter) ||
              recSectionName.includes(filterSectionLetter)
            );
            
            if (!matchesDirect && !matchesByLetter) {
              return; // No coincide con ningún método
            }
          }
          
          // Aplicar filtro de nivel
          if (effectiveFilters?.level) {
            const recordLevel = courseLevelMap[n.courseId] || inferLevelFromCourseName(n.raw?.course || n.courseId || '');
            if (recordLevel !== effectiveFilters.level) return;
          }
          filtered.push(n.raw);
        });
      });

      // Log de diagnóstico para filtrado
      console.log('[AttendanceTrendCard] Filtrado completado:', {
        totalDaysInRange: dayKeysInRange.length,
        filteredRecords: filtered.length,
        filters: {
          courseId: effectiveFilters?.courseId,
          courseName: effectiveFilters?.courseName,
          sectionId: effectiveFilters?.sectionId,
          sectionLetter: effectiveFilters?.sectionLetter,
          level: effectiveFilters?.level,
          filterCourseToIdStyle,
          filterCourseGradeKey,
          filterSectionLetter,
        },
      });

      // Procesar para gráfico
      const hasDimFilters = !!(
        effectiveFilters?.semester ||
        effectiveFilters?.level ||
        effectiveFilters?.courseId ||
        effectiveFilters?.sectionId
      );
      const useMonthly = isPastYear && !hasDimFilters && (period === 'all' || period === '90d');

      if (useMonthly) {
        // Agregación mensual
        const monthAgg: Record<string, { present: number; total: number }> = {};
        filtered.forEach((r) => {
          const ts = parseTimestampOptimized(r.timestamp || r.date || r.when);
          if (!ts || ts < fromTs || ts > toTs) return;
          const d = new Date(ts);
          const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (!monthAgg[mKey]) monthAgg[mKey] = { present: 0, total: 0 };

          if (r.status === 'present' || r.present === true) {
            monthAgg[mKey].present += 1;
            monthAgg[mKey].total += 1;
          } else if (r.status === 'absent' || r.present === false) {
            monthAgg[mKey].total += 1;
          } else if (Array.isArray(r.presentStudents)) {
            monthAgg[mKey].present += r.presentStudents.length;
            monthAgg[mKey].total += r.presentStudents.length + (r.absentStudents?.length || 0);
          }
        });

        const keys = Object.keys(monthAgg).sort();
        const names = getMonthNames(language);
        const p: number[] = [];
        const a: number[] = [];
        const labs: string[] = [];

        keys.forEach((k) => {
          const [yy, mm] = k.split('-').map(Number);
          const agg = monthAgg[k];
          const denom = Math.max(1, agg.total);
          const pct = +((agg.present / denom) * 100).toFixed(1);
          p.push(pct);
          a.push(Math.max(0, +(100 - pct).toFixed(1)));
          const monthIdx = Math.max(0, Math.min(11, (isNaN(mm) ? 1 : mm) - 1));
          labs.push(`${names[monthIdx]} ${String(yy || year).slice(-2)}`);
        });

        return {
          presentSeries: p,
          absentSeries: a,
          labels: labs,
          mode: 'monthly' as const,
        };
      }

      // Modo diario
      const dayMap = new Map<string, any[]>();
      filtered.forEach((r) => {
        const ts = parseTimestampOptimized(r.timestamp || r.date || r.when);
        if (!ts) return;
        const d = new Date(ts);
        const k = keyOfDayLocal(d);
        if (!dayMap.has(k)) dayMap.set(k, []);
        dayMap.get(k)!.push(r);
      });

      const activeKeys = Array.from(dayMap.keys()).sort();

      const presentVals: number[] = [];
      const absentVals: number[] = [];
      const labelsStr: string[] = [];

      activeKeys.forEach((k) => {
        const recs = dayMap.get(k) || [];
        let present = 0;
        let total = 0;
        recs.forEach((r) => {
          if (r.status === 'present' || r.present === true) {
            present += 1;
            total += 1;
          } else if (r.status === 'absent' || r.present === false) {
            total += 1;
          } else if (Array.isArray(r.presentStudents)) {
            present += r.presentStudents.length;
            total += r.presentStudents.length + (r.absentStudents?.length || 0);
          }
        });
        const pct = total > 0 ? (present / total) * 100 : 0;
        presentVals.push(+pct.toFixed(1));
        absentVals.push(+(100 - pct).toFixed(1));
        const [yy, mm, dd] = k.split('-').map(Number);
        labelsStr.push(`${dd}/${mm}`);
      });

      return {
        presentSeries: presentVals,
        absentSeries: absentVals,
        labels: labelsStr,
        mode: 'daily' as const,
      };
    } catch {
      return {
        presentSeries: [],
        absentSeries: [],
        labels: [],
        mode: 'daily' as const,
      };
    }
  }, [
    teacherUsername,
    fromTs,
    toTs,
    JSON.stringify(appliedFilters),
    validDays.length,
    language,
    isPastYear,
    blocked,
    period,
    attTick,
    year,
    sqlAttendanceByYear ? sqlAttendanceByYear[year]?.length ?? 0 : 0,
    preloadStats?.attendanceMonthly ? Object.keys(preloadStats.attendanceMonthly).length : 0,
  ]);

  // Dominio Y para zoom
  const yDomain = useMemo(() => {
    if (!zoomY) return { min: 0, max: 100 };
    const series = viewMode === 'present' ? presentSeries : absentSeries;
    if (!series || series.length === 0) return { min: 0, max: 100 };
    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = max - min;
    const minRange = 5;
    let adjustedMin = min;
    let adjustedMax = max;
    if (range < minRange) {
      const mid = (min + max) / 2;
      adjustedMin = Math.max(0, mid - minRange / 2);
      adjustedMax = Math.min(100, mid + minRange / 2);
    } else {
      adjustedMin = Math.max(0, min - range * 0.1);
      adjustedMax = Math.min(100, max + range * 0.1);
    }
    return { min: Math.floor(adjustedMin), max: Math.ceil(adjustedMax) };
  }, [zoomY, presentSeries, absentSeries, viewMode]);

  const yTicks = useMemo(() => {
    if (!zoomY) return undefined;
    const { min, max } = yDomain;
    const step = Math.ceil((max - min) / 5);
    const ticks: number[] = [];
    for (let i = min; i <= max; i += step) ticks.push(i);
    if (ticks[ticks.length - 1] < max) ticks.push(max);
    return ticks;
  }, [zoomY, yDomain]);

  // Segmentos de meses para mostrar
  const monthsShown = useMemo(() => {
    const segments: Array<{ key: string; label: string; widthPct: number }> = [];
    if (!labels || labels.length === 0) return { segments, todayPct: undefined };

    const shortNames = getMonthNames(language);
    const monthSet = new Set<string>();

    labels.forEach((lbl) => {
      const match = lbl.match(/(\d+)\/(\d+)/);
      if (match) {
        const monthIdx = parseInt(match[2]) - 1;
        if (monthIdx >= 0 && monthIdx < 12) {
          monthSet.add(`${year}-${String(monthIdx + 1).padStart(2, '0')}`);
        }
      }
    });

    const months = Array.from(monthSet).sort();
    const widthPct = months.length > 0 ? 100 / months.length : 100;

    months.forEach((m) => {
      const [yy, mm] = m.split('-').map(Number);
      const monthIdx = mm - 1;
      segments.push({
        key: m,
        label: shortNames[monthIdx] || '',
        widthPct,
      });
    });

    return { segments, todayPct: undefined };
  }, [labels, year, language, filters?.semester]);

  return (
    <Card className={`h-full flex flex-col ${hideHeader ? 'border-0 shadow-none bg-transparent' : ''}`}>
      {!hideHeader && (
        <CardHeader className="flex-shrink-0">
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex-1 truncate">
              {`${t('cardAttendanceTitle', 'Asistencia')} - ${year}`}
              {filters?.semester && !titleSummary
                ? filters.semester === 'S1'
                  ? ' • 1er Sem'
                  : ' • 2do Sem'
                : ''}
              {year === new Date().getFullYear() &&
              !filters?.semester &&
              !filters?.level &&
              !filters?.courseId &&
              !filters?.sectionId &&
              period === 'all'
                ? ' • ' + t('academicPeriod', 'Período académico')
                : ''}
              {titleSummary ? ' • ' + titleSummary : ''}
            </span>
            <button
              type="button"
              onClick={() => setZoomY((z) => !z)}
              className={`inline-flex items-center justify-center rounded-lg border w-8 h-8 text-xs font-medium transition-all duration-200 ${
                zoomY
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/50 bg-background/60 text-foreground hover:border-primary/50 hover:bg-accent/50'
              }`}
              title={zoomY ? t('restoreScale', 'Restaurar escala') : t('zoomToData', 'Zoom a los datos')}
            >
              {zoomY ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
            </button>
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className={`flex-1 flex flex-col ${hideHeader ? 'min-h-[320px]' : 'min-h-0'}`}>
        {fromTs === 0 && toTs === 0 && filters?.semester ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground text-center px-4">
              {t('semesterNotConfigured', 'Semestre sin fechas configuradas en Calendario')}
            </p>
          </div>
        ) : presentSeries.length > 0 ? (
          <div className="flex-1 flex flex-col min-h-0 space-y-4">
            <div
              className={`relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4 ${hideHeader ? 'h-[340px]' : 'h-80'}`}
            >
              <div className="h-full relative">
                <ResponsiveTrendChart
                  key={`trend-${zoomY}-${viewMode}-${yDomain?.min}-${yDomain?.max}`}
                  data={viewMode === 'present' ? presentSeries : absentSeries}
                  labels={labels}
                  color={viewMode === 'present' ? '#34D399' : '#F87171'}
                  height={288}
                  valueFormat={(v) => `${v.toFixed(1)}%`}
                  percentGrid={!zoomY}
                  yAxis
                  highlightLastValue
                  yDomain={zoomY ? yDomain : undefined}
                  yTicks={zoomY ? yTicks : undefined}
                  forceAlignment={true}
                />
              </div>
              {monthsShown.segments.length > 0 && (
                <div className="absolute bottom-2 left-4 right-4 select-none">
                  <div className="flex text-[11px] text-muted-foreground pl-[26px] pr-[8px]">
                    {monthsShown.segments.map((seg, idx) => (
                      <div
                        key={seg.key}
                        style={{ width: `${seg.widthPct}%` }}
                        className={`text-center ${idx < monthsShown.segments.length - 1 ? 'border-r border-zinc-300 dark:border-zinc-700' : ''}`}
                      >
                        <span>{seg.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
              {(['present', 'absent'] as const).map((modeOpt) => (
                <button
                  key={modeOpt}
                  type="button"
                  onClick={() => setViewMode(modeOpt)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition border ${
                    viewMode === modeOpt
                      ? modeOpt === 'present'
                        ? 'bg-emerald-600 text-white border-emerald-500'
                        : 'bg-red-600 text-white border-red-500'
                      : 'bg-muted/30 border-border hover:bg-muted/50'
                  }`}
                >
                  {modeOpt === 'present' ? t('presentes', 'Presentes') : t('ausentes', 'Ausentes')}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="relative bg-gradient-to-br from-background to-muted/20 rounded-xl border border-border/30 p-4 h-[300px]">
            <div className={`h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600`}>
              <div className="text-center">
                {isAttendanceSQLConnected &&
                (!sqlAttendanceByYear || !sqlAttendanceByYear[year] || sqlAttendanceByYear[year].length === 0) ? (
                  <>
                    <svg
                      className="animate-spin h-8 w-8 mx-auto text-blue-500 mb-3"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">
                      {t('loadingAttendanceData', 'Cargando datos de asistencia...')}
                    </p>
                    <p className="text-gray-400 dark:text-gray-500 text-xs">
                      {t('loadingAttendanceDescription', 'Los datos se mostrarán en unos segundos')}
                    </p>
                  </>
                ) : (
                  <>
                    <svg
                      className="animate-spin h-8 w-8 mx-auto text-blue-500 mb-3"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">
                      {t('noAttendanceData', 'Sin datos de asistencia')}
                    </p>
                    <p className="text-gray-400 dark:text-gray-500 text-xs">
                      {t('trySelectingAnotherPeriod', 'Prueba seleccionando otro periodo o ajusta los filtros')}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
