import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	formatRecordDateDisplay,
	getTodayRecordDate,
	normalizeRecordDateValue,
	parseRecordDate,
	toRecordDateString,
} from "../../lib/note-frontmatter.js";

const WEEKDAY_LABELS = {
	zh: ["日", "一", "二", "三", "四", "五", "六"],
	en: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
} as const;

const DATE_POPOVER_WIDTH = 280;
const DATE_POPOVER_ESTIMATED_HEIGHT = 340;

function formatCalendarMonth(year: number, month: number, uiLanguage: "zh" | "en"): string {
	if (uiLanguage === "en") {
		return new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
	}
	return `${year}年${month + 1}月`;
}

export interface RecordDatePropertyEditorProps {
	value: string;
	readOnly?: boolean;
	uiLanguage: "zh" | "en";
	onChange: (nextValue: string) => void;
}

export function RecordDatePropertyEditor({
	value,
	readOnly = false,
	uiLanguage,
	onChange,
}: RecordDatePropertyEditorProps) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
	const normalizedValue = normalizeRecordDateValue(value);
	const selectedDate = parseRecordDate(normalizedValue);
	const todayValue = getTodayRecordDate();
	const todayDate = parseRecordDate(todayValue)!;
	const [viewYear, setViewYear] = useState(selectedDate?.getFullYear() ?? todayDate.getFullYear());
	const [viewMonth, setViewMonth] = useState(selectedDate?.getMonth() ?? todayDate.getMonth());

	const updatePopoverPosition = useCallback(() => {
		const trigger = triggerRef.current;
		if (!trigger) return;
		const rect = trigger.getBoundingClientRect();
		const width = Math.min(DATE_POPOVER_WIDTH, Math.max(rect.width, 240));
		let left = rect.left;
		let top = rect.bottom + 6;
		if (left + width > window.innerWidth - 12) {
			left = Math.max(12, window.innerWidth - width - 12);
		}
		if (top + DATE_POPOVER_ESTIMATED_HEIGHT > window.innerHeight - 12) {
			top = Math.max(12, rect.top - DATE_POPOVER_ESTIMATED_HEIGHT - 6);
		}
		setPopoverStyle({ position: "fixed", top, left, width });
	}, []);

	useEffect(() => {
		if (!selectedDate) return;
		setViewYear(selectedDate.getFullYear());
		setViewMonth(selectedDate.getMonth());
	}, [normalizedValue]);

	useEffect(() => {
		if (!open) return;
		updatePopoverPosition();

		function handlePointerDown(event: PointerEvent) {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
			setOpen(false);
		}

		function handleKeyDown(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}

		window.addEventListener("resize", updatePopoverPosition);
		window.addEventListener("scroll", updatePopoverPosition, true);
		document.addEventListener("pointerdown", handlePointerDown, true);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("resize", updatePopoverPosition);
			window.removeEventListener("scroll", updatePopoverPosition, true);
			document.removeEventListener("pointerdown", handlePointerDown, true);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open, updatePopoverPosition]);

	const calendarCells = useMemo(() => {
		const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
		const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
		const cells: Array<{ date: Date; muted: boolean }> = [];
		for (let index = 0; index < firstWeekday; index += 1) {
			const day = new Date(viewYear, viewMonth, index - firstWeekday + 1);
			cells.push({ date: day, muted: true });
		}
		for (let day = 1; day <= daysInMonth; day += 1) {
			cells.push({ date: new Date(viewYear, viewMonth, day), muted: false });
		}
		while (cells.length % 7 !== 0) {
			const nextDay = cells.length - firstWeekday - daysInMonth + 1;
			cells.push({ date: new Date(viewYear, viewMonth + 1, nextDay), muted: true });
		}
		return cells;
	}, [viewMonth, viewYear]);

	function selectDate(date: Date) {
		onChange(toRecordDateString(date));
		setOpen(false);
	}

	function goToPreviousMonth() {
		if (viewMonth === 0) {
			setViewYear((current) => current - 1);
			setViewMonth(11);
			return;
		}
		setViewMonth((current) => current - 1);
	}

	function goToNextMonth() {
		if (viewMonth === 11) {
			setViewYear((current) => current + 1);
			setViewMonth(0);
			return;
		}
		setViewMonth((current) => current + 1);
	}

	const displayText = formatRecordDateDisplay(normalizedValue, uiLanguage);
	const selectedValue = selectedDate ? toRecordDateString(selectedDate) : "";

	const popover =
		open && !readOnly ? (
			<div
				ref={popoverRef}
				className="inno-note-property-date-popover inno-note-property-date-popover-portal"
				style={popoverStyle}
				role="dialog"
				aria-label={t("notes.properties.chooseDate")}
				onPointerDown={(event) => event.stopPropagation()}
			>
				<div className="inno-note-property-date-popover-header">
					<button
						type="button"
						className="inno-note-property-date-nav-button"
						aria-label={t("notes.properties.previousMonth")}
						onClick={goToPreviousMonth}
					>
						<ChevronLeft size={16} />
					</button>
					<span className="inno-note-property-date-month-label">
						{formatCalendarMonth(viewYear, viewMonth, uiLanguage)}
					</span>
					<button
						type="button"
						className="inno-note-property-date-nav-button"
						aria-label={t("notes.properties.nextMonth")}
						onClick={goToNextMonth}
					>
						<ChevronRight size={16} />
					</button>
				</div>
				<div className="inno-note-property-date-weekdays" aria-hidden="true">
					{WEEKDAY_LABELS[uiLanguage].map((label) => (
						<span key={label} className="inno-note-property-date-weekday">
							{label}
						</span>
					))}
				</div>
				<div className="inno-note-property-date-grid">
					{calendarCells.map(({ date, muted }, cellIndex) => {
						const cellValue = toRecordDateString(date);
						const isSelected = cellValue === selectedValue;
						const isToday = cellValue === todayValue;
						return (
							<button
								key={`${cellValue}-${cellIndex}`}
								type="button"
								className={[
									"inno-note-property-date-day",
									muted ? "muted" : "",
									isSelected ? "selected" : "",
									isToday ? "today" : "",
								]
									.filter(Boolean)
									.join(" ")}
								aria-label={formatRecordDateDisplay(cellValue, uiLanguage)}
								aria-pressed={isSelected}
								onClick={() => selectDate(date)}
							>
								{date.getDate()}
							</button>
						);
					})}
				</div>
				<div className="inno-note-property-date-footer">
					<button
						type="button"
						className="inno-note-property-date-today-button"
						onClick={() => {
							onChange(todayValue);
							setViewYear(todayDate.getFullYear());
							setViewMonth(todayDate.getMonth());
							setOpen(false);
						}}
					>
						{t("notes.properties.today")}
					</button>
				</div>
			</div>
		) : null;

	return (
		<div className={`inno-note-property-date-field ${open ? "open" : ""}`} ref={containerRef}>
			<button
				ref={triggerRef}
				type="button"
				className="inno-note-property-date-trigger"
				disabled={readOnly}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t("notes.properties.recordDate")}
				onClick={() => {
					if (!readOnly) {
						setOpen((current) => {
							const nextOpen = !current;
							if (nextOpen) {
								requestAnimationFrame(() => updatePopoverPosition());
							}
							return nextOpen;
						});
					}
				}}
			>
				<span className="inno-note-property-date-trigger-icon" aria-hidden="true">
					<CalendarDays size={14} />
				</span>
				<span className="inno-note-property-date-trigger-text">{displayText}</span>
				{!readOnly ? (
					<ChevronRight size={14} aria-hidden="true" className="inno-note-property-date-trigger-chevron" />
				) : null}
			</button>
			{popover ? createPortal(popover, document.body) : null}
		</div>
	);
}
