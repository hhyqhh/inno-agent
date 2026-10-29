import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, File, Folder, LoaderCircle, MessageSquareText, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SearchCategory, SearchResponse, SearchResult, SearchResultCategory } from "../../../src/shared/search.js";
import { searchInnoAgent } from "../api/search.js";
import { Button, Dialog, getTabTriggerId, IconButton, Input, MenuOption, TabPanel, Tabs } from "./ui/index.js";

const SEARCH_CATEGORIES: SearchCategory[] = ["all", "conversation", "workspace", "file", "knowledge"];
const EMPTY_RESULTS: SearchResponse = { results: [], total: 0, counts: {} };

function resultIcon(category: SearchResultCategory) {
	switch (category) {
		case "conversation": return <MessageSquareText size={15} />;
		case "workspace": return <Folder size={15} />;
		case "file": return <File size={15} />;
		case "knowledge": return <BookOpen size={15} />;
	}
}

function useSearchResults(query: string, category: SearchCategory) {
	const { t } = useTranslation();
	const [response, setResponse] = useState<SearchResponse>(EMPTY_RESULTS);
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState("");
	const request = useRef<AbortController | null>(null);
	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			setResponse(EMPTY_RESULTS);
			setLoading(false);
			setLoadingMore(false);
			setError("");
			return;
		}
		setResponse(EMPTY_RESULTS);
		setLoading(true);
		setLoadingMore(false);
		setError("");
		const controller = new AbortController();
		request.current = controller;
		const timer = window.setTimeout(() => {
			void searchInnoAgent(trimmed, category, controller.signal)
				.then((next) => {
					// Cancellation can race with a resolved response; never restore stale results.
					if (!controller.signal.aborted) setResponse(next);
				})
				.catch((reason: unknown) => {
					if (!controller.signal.aborted) {
						setResponse(EMPTY_RESULTS);
						setError(reason instanceof Error ? reason.message : t("globalSearch.failed"));
					}
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}, 180);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
			if (request.current === controller) request.current = null;
		};
	}, [query, category, t]);
	const loadMore = async () => {
		const controller = request.current;
		if (!controller || response.nextOffset === undefined || loading || loadingMore) return;
		setLoadingMore(true);
		setError("");
		try {
			const next = await searchInnoAgent(query.trim(), category, controller.signal, response.nextOffset);
			if (!controller.signal.aborted) setResponse((current) => ({
				...next,
				results: [...new Map([...current.results, ...next.results].map((result) => [result.id, result])).values()],
			}));
		} catch (reason) {
			if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("globalSearch.failed"));
		} finally {
			if (!controller.signal.aborted) setLoadingMore(false);
		}
	};
	return { ...response, loading, loadingMore, error, loadMore };
}

interface SearchPanelProps {
	standalone?: boolean;
	macTitlebarInset?: boolean;
	onClose: () => void;
	onNavigate: (result: SearchResult) => void | Promise<void>;
}

export function SearchPanel({ standalone = false, macTitlebarInset = false, onClose, onNavigate }: SearchPanelProps) {
	const { t, i18n } = useTranslation();
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<SearchCategory>("all");
	const [activeIndex, setActiveIndex] = useState(0);
	const [keyboardActive, setKeyboardActive] = useState(true);
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const { results, counts, nextOffset, loading, loadingMore, error, loadMore } = useSearchResults(query, category);
	const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n?.language, {
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
	}), [i18n?.language]);
	const categoryNames = useMemo<Record<SearchCategory, string>>(() => ({
		all: t("globalSearch.tabs.all"),
		conversation: t("globalSearch.tabs.conversation"),
		workspace: t("globalSearch.tabs.workspace"),
		file: t("globalSearch.tabs.file"),
		knowledge: t("globalSearch.tabs.knowledge"),
	}), [t]);
	const resultGroups = useMemo(() => {
		if (category !== "all") return [{ category, results }];
		return (["conversation", "workspace", "file", "knowledge"] as const)
			.map((item) => ({ category: item, results: results.filter((result) => result.category === item) }))
			.filter((group) => group.results.length > 0);
	}, [category, results]);
	const orderedResults = useMemo(() => resultGroups.flatMap((group) => group.results), [resultGroups]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	useEffect(() => {
		setActiveIndex(0);
		listRef.current?.scrollTo?.({ top: 0 });
	}, [query, category]);
	useEffect(() => {
		const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
		if (keyboardActive) active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, keyboardActive]);

	const selectCategory = (delta: number) => {
		const currentIndex = SEARCH_CATEGORIES.indexOf(category);
		const nextIndex = (currentIndex + delta + SEARCH_CATEGORIES.length) % SEARCH_CATEGORIES.length;
		setCategory(SEARCH_CATEGORIES[nextIndex]);
		inputRef.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key === "ArrowLeft") {
			event.preventDefault();
			selectCategory(-1);
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key === "ArrowRight") {
			event.preventDefault();
			selectCategory(1);
			return;
		}
		// Tabs and buttons own their activation keys. Only the search input drives results.
		if (event.target !== inputRef.current) return;
		setKeyboardActive(true);
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			const input = event.target instanceof HTMLInputElement ? event.target : null;
			const atEdge = !input || !query || (event.key === "ArrowLeft"
				? input.selectionStart === 0 && input.selectionEnd === 0
				: input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
			if (atEdge) {
				event.preventDefault();
				selectCategory(event.key === "ArrowLeft" ? -1 : 1);
				return;
			}
		}
		if (event.key === "ArrowDown" && orderedResults.length > 0) {
			event.preventDefault();
			setActiveIndex((index) => (index + 1) % orderedResults.length);
			return;
		}
		if (event.key === "ArrowUp" && orderedResults.length > 0) {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + orderedResults.length) % orderedResults.length);
			return;
		}
		if (event.key === "Enter" && orderedResults[activeIndex]) {
			event.preventDefault();
			void onNavigate(orderedResults[activeIndex]);
		}
	};

	let resultIndex = -1;
	const surface = (
		<div
			className={`inno-search-surface${standalone ? " inno-search-surface--window" : " inno-search-surface--overlay"}`}
			role={standalone ? "region" : undefined}
			aria-label={standalone ? t("globalSearch.open") : undefined}
			onKeyDown={onKeyDown}
		>
			<div className="inno-search-header">
				<div className="inno-search-input-wrap">
					<Search size={16} aria-hidden="true" />
					<Input
						ref={inputRef}
						variant="bare"
						className="flex-1 text-sm"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={orderedResults.length > 0}
						aria-controls={`${id}-results`}
						aria-activedescendant={orderedResults[activeIndex] ? `${id}-result-${activeIndex}` : undefined}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("globalSearch.placeholder")}
						aria-label={t("globalSearch.placeholder")}
						autoComplete="off"
						spellCheck={false}
					/>
					{query ? <Button variant="ghost" size="compact" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
						{t("globalSearch.clear")}
					</Button> : null}
				</div>
				{!standalone ? (
					<IconButton variant="ghost" size="sm" aria-label={t("common.close")} onClick={onClose}>
						<X size={16} />
					</IconButton>
				) : null}
			</div>

			<Tabs id={id} value={category} onValueChange={setCategory}
				items={SEARCH_CATEGORIES.map((item) => ({ value: item, label: categoryNames[item] }))}
				ariaLabel={t("globalSearch.open")} className="inno-search-tabs" />

			<TabPanel ref={listRef} id={id} labelledBy={getTabTriggerId(id, category)} className="inno-search-results">
			<div id={`${id}-results`} role="listbox" aria-label={categoryNames[category]} aria-busy={loading}>
				{!query.trim() ? (
					<div className="inno-search-empty">
						<Search size={32} strokeWidth={1.7} aria-hidden="true" />
						<p>{t("globalSearch.emptyPrompt")}</p>
					</div>
				) : loading && results.length === 0 ? (
					<div className="inno-search-status"><LoaderCircle className="animate-spin" size={18} />{t("globalSearch.loading")}</div>
				) : error && results.length === 0 ? (
					<div className="inno-search-status" role="alert">{error}</div>
				) : results.length === 0 ? (
					<div className="inno-search-status">{t("globalSearch.noResults")}</div>
				) : resultGroups.map((group) => (
					<section key={group.category} role="group" className="inno-search-group" aria-label={categoryNames[group.category]}>
						<div className="inno-search-group-heading">
							<h2 className="inno-search-group-title">{categoryNames[group.category]} <span>({counts?.[group.category] ?? group.results.length})</span></h2>
							{category === "all" && (counts?.[group.category] ?? 0) > group.results.length ? (
								<Button variant="ghost" size="compact" onClick={() => { setCategory(group.category); inputRef.current?.focus(); }}>
									{t("globalSearch.viewAll")}
								</Button>
							) : null}
						</div>
						{group.results.map((result) => {
							resultIndex += 1;
							const index = resultIndex;
							const active = index === activeIndex;
							return (
								<MenuOption
									key={result.id}
									id={`${id}-result-${index}`}
									className="inno-search-result"
									type="button"
									role="option"
									aria-selected={active}
									tabIndex={-1}
									data-active={active && keyboardActive}
									data-highlighted={active && keyboardActive ? "" : undefined}
									onPointerMove={() => setKeyboardActive(false)}
									onClick={() => void onNavigate(result)}
								>
									<span className="inno-search-result-icon" aria-hidden="true">{resultIcon(result.category)}</span>
									<span className="inno-search-result-copy">
										<span className="inno-search-result-heading">
										<span className="inno-search-result-title">{result.title}</span>
											{result.archived ? <span className="inno-search-result-badge">{t("globalSearch.archived")}</span> : null}
											{result.category === "conversation" && !Number.isNaN(Date.parse(result.subtitle)) ? (
												<time className="inno-search-result-time" dateTime={result.subtitle}>{dateFormatter.format(new Date(result.subtitle))}</time>
											) : null}
										</span>
										{result.category === "file" || result.category === "workspace" ? (
											<span className="inno-search-result-subtitle">{result.subtitle}</span>
										) : result.snippet ? <span className="inno-search-result-snippet">{result.snippet}</span> : null}
									</span>
								</MenuOption>
							);
						})}
					</section>
				))}
			</div>
			{results.length > 0 && error ? <div className="inno-search-page-error" role="alert">{error}</div> : null}
			{nextOffset !== undefined ? <div className="inno-search-more">
				<Button variant="ghost" size="xs" disabled={loadingMore} onClick={() => void loadMore()}>
					{loadingMore ? t("globalSearch.loading") : t("globalSearch.loadMore")}
				</Button>
			</div> : null}
			</TabPanel>

			<footer className="inno-search-footer">
				<span>{t("globalSearch.shortcuts.move")}</span>
				<span>{t("globalSearch.shortcuts.open")}</span>
				<span>{t("globalSearch.shortcuts.switch")}</span>
				<span>{t("globalSearch.shortcuts.close")}</span>
			</footer>
		</div>
	);

	if (standalone) return (
		<div className={`inno-search-window-root${macTitlebarInset ? " inno-search-window-root--mac-titlebar" : ""}`}>
			{macTitlebarInset ? <div className="inno-search-window-drag-region" aria-hidden="true" /> : null}
			{surface}
		</div>
	);
	return (
		<Dialog className="inno-search-overlay" label={t("globalSearch.open")} onClose={onClose}>
			{surface}
		</Dialog>
	);
}
