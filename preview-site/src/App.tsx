/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import videoContentUrl from '../../assets/video-content.svg';
import Markdown from 'react-markdown';
import {
  Youtube,
  Sparkles,
  Settings,
  Play,
  Copy,
  Check,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Eye,
  Type as TypeIcon,
  FileText,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Layout
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { EpisodeData, GeneratedPost } from '@shared/types';
import { resolvePlaylistId, buildUserMessage, parseGeneratedResponse, assemblePostBody, applyPlaceholders } from '@shared/postUtils';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant that generates Reddit discussion posts for a podcast.
The first line of your output should be a catchy, relevant title for the Reddit post.
The rest of your output should be the body of the post, including a summary of the episode and some discussion prompts.
Be engaging and use Markdown formatting.`;

const MODELS = [
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Latest)' },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Advanced)' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
];

// ---------------------------------------------------------------------------
// API access checks — lightweight probes that consume no generation quota
// ---------------------------------------------------------------------------

type ApiStatus = 'idle' | 'checking' | 'ok' | 'error';

async function checkGeminiAccess(apiKey: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function checkYouTubeAccess(apiKey: string, signal: AbortSignal): Promise<boolean> {
  try {
    // Fetch a well-known public video — minimal quota, just verifies API access
    const res = await fetch(
      `https://youtube.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(apiKey)}`,
      { signal }
    );
    return res.ok;
  } catch {
    return false;
  }
}

function ApiStatusPill({ status, label, errorHref, errorLabel }: {
  status: ApiStatus;
  label: string;
  errorHref: string;
  errorLabel: string;
}) {
  if (status === 'idle') return null;
  if (status === 'checking') return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full bg-[#141414]/5 text-[#141414]/40">
      <RefreshCw size={10} className="animate-spin" />
      {label}
    </span>
  );
  if (status === 'ok') return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">
      <Check size={10} />
      {label}
    </span>
  );
  return (
    <a
      href={errorHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
    >
      <AlertCircle size={10} />
      {label} — {errorLabel} <ExternalLink size={9} />
    </a>
  );
}

export default function App() {
  // Configuration State
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('yt_gemini_api_key') || '');
  const [playlistId, setPlaylistId] = useState(() => localStorage.getItem('yt_playlist_id') || '');
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('yt_system_prompt') || DEFAULT_SYSTEM_PROMPT);
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('yt_gemini_model') || 'gemini-3-flash-preview');

  // Advanced Settings (from Devvit App)
  const [videoLinkLabel, setVideoLinkLabel] = useState(() => localStorage.getItem('yt_video_link_label') || 'Watch on YouTube');
  const [prependText, setPrependText] = useState(() => localStorage.getItem('yt_prepend_text') || '');
  const [appendText, setAppendText] = useState(() => localStorage.getItem('yt_append_text') || '');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewMode, setPreviewMode] = useState<'raw' | 'reddit'>('reddit');

  // UI State
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableVideos, setAvailableVideos] = useState<EpisodeData[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string>('');
  const [fetchedVideo, setFetchedVideo] = useState<EpisodeData | null>(null);
  const [generatedPost, setGeneratedPost] = useState<GeneratedPost | null>(null);
  const [copied, setCopied] = useState<'title' | 'body' | 'model' | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<ApiStatus>('idle');
  const [youtubeStatus, setYoutubeStatus] = useState<ApiStatus>('idle');

  // Persist settings
  useEffect(() => {
    localStorage.setItem('yt_gemini_api_key', apiKey);
    localStorage.setItem('yt_playlist_id', playlistId);
    localStorage.setItem('yt_system_prompt', systemPrompt);
    localStorage.setItem('yt_gemini_model', selectedModel);
    localStorage.setItem('yt_video_link_label', videoLinkLabel);
    localStorage.setItem('yt_prepend_text', prependText);
    localStorage.setItem('yt_append_text', appendText);
  }, [apiKey, playlistId, systemPrompt, selectedModel, videoLinkLabel, prependText, appendText]);

  // Check API access whenever the key changes (debounced 800 ms)
  useEffect(() => {
    if (!apiKey || apiKey.length < 20) {
      setGeminiStatus('idle');
      setYoutubeStatus('idle');
      return;
    }
    setGeminiStatus('checking');
    setYoutubeStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const [gemini, youtube] = await Promise.all([
        checkGeminiAccess(apiKey, controller.signal),
        checkYouTubeAccess(apiKey, controller.signal),
      ]);
      if (!controller.signal.aborted) {
        setGeminiStatus(gemini ? 'ok' : 'error');
        setYoutubeStatus(youtube ? 'ok' : 'error');
      }
    }, 800);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiKey]);

  const loadPlaylistVideos = async () => {
    if (!apiKey || !playlistId) {
      setError('Please provide both an API Key and a Playlist ID.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setAvailableVideos([]);

    try {
      let allItems: any[] = [];
      let nextPageToken = '';
      const MAX_PAGES = 2; // Fetch up to 100 videos (50 per page)
      const resolvedPlaylistId = resolvePlaylistId(playlistId);

      for (let i = 0; i < MAX_PAGES; i++) {
        const ytUrl = `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(resolvedPlaylistId)}&key=${encodeURIComponent(apiKey)}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
        const ytResponse = await fetch(ytUrl);

        if (!ytResponse.ok) {
          const errData = await ytResponse.json();
          throw new Error(`YouTube API Error: ${errData.error?.message || ytResponse.statusText}`);
        }

        const ytData = await ytResponse.json();
        if (ytData.items) {
          allItems = [...allItems, ...ytData.items];
        }

        nextPageToken = ytData.nextPageToken;
        if (!nextPageToken) break;
      }

      if (allItems.length === 0) {
        throw new Error('No videos found in this playlist.');
      }

      const videos: EpisodeData[] = allItems.map((item: any) => ({
        guid: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        description: item.snippet.description || '',
        pubDate: item.snippet.publishedAt,
        link: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
      })).sort((a: EpisodeData, b: EpisodeData) =>
        new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
      );

      setAvailableVideos(videos);
      if (videos.length > 0) {
        setSelectedVideoId(videos[0].guid);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  const generatePreview = async () => {
    const video = availableVideos.find(v => v.guid === selectedVideoId);
    if (!video) {
      setError('Please select a video first.');
      return;
    }

    if (!apiKey) {
      setError('API Key is required.');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setGeneratedPost(null);
    setFetchedVideo(video);

    try {
      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: buildUserMessage(video),
        config: {
          systemInstruction: applyPlaceholders(systemPrompt, video),
        }
      });

      const fullText = response.text;

      if (!fullText) {
        throw new Error('Gemini returned an empty response.');
      }

      const { title, body: rawBody } = parseGeneratedResponse(fullText, video.title);
      const finalBody = assemblePostBody(
        applyPlaceholders(prependText, video),
        rawBody,
        applyPlaceholders(videoLinkLabel, video),
        video.link,
        applyPlaceholders(appendText, video),
      );

      setGeneratedPost({ title, body: finalBody });

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = (text: string, type: 'title' | 'body' | 'model') => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="min-h-screen bg-[#F5F5F0] text-[#141414] font-sans selection:bg-emerald-100">
      {/* Header */}
      <header className="border-b border-[#141414]/10 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={videoContentUrl} alt="" className="w-10 h-10 object-contain" />
            <div>
              <h1 className="font-bold text-lg tracking-tight">YouTube + Gemini Post: Post Preview</h1>
              <p className="text-[10px] uppercase tracking-widest opacity-50 font-semibold">YouTube + Gemini Post Devvit App Companion</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://developers.reddit.com/apps/youtube-gemini"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium opacity-50 hover:opacity-100 transition-opacity flex items-center gap-1"
            >
              Reddit App <ExternalLink size={12} />
            </a>
            <a
              href="https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium opacity-50 hover:opacity-100 transition-opacity flex items-center gap-1"
            >
              GitHub <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">

          {/* Left Column: Configuration */}
          <div className="lg:col-span-5 space-y-8">
            <section className="space-y-6">
              <div className="flex items-center gap-2 opacity-50">
                <Settings size={16} />
                <h2 className="text-xs font-bold uppercase tracking-widest">Configuration</h2>
              </div>

              <div className="space-y-4">
                {/* API Key */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold opacity-70 flex items-center gap-2">
                      Google API Key
                      <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">REQUIRED</span>
                    </label>
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-bold text-blue-600 hover:underline flex items-center gap-1"
                    >
                      Get Key from AI Studio <ExternalLink size={10} />
                    </a>
                  </div>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Paste your Google API Key here..."
                    className="w-full bg-white border border-[#141414]/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all"
                  />
                  <div className="flex gap-2 flex-wrap min-h-[22px]">
                    <ApiStatusPill
                      status={geminiStatus}
                      label="Gemini API"
                      errorHref="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com"
                      errorLabel="Enable API"
                    />
                    <ApiStatusPill
                      status={youtubeStatus}
                      label="YouTube Data API"
                      errorHref="https://console.cloud.google.com/apis/library/youtube.googleapis.com"
                      errorLabel="Enable API"
                    />
                  </div>
                </div>

                {/* Playlist ID */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold opacity-70">YouTube Playlist ID</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 opacity-30">
                        <Youtube size={16} />
                      </div>
                      <input
                        type="text"
                        value={playlistId}
                        onChange={(e) => setPlaylistId(e.target.value)}
                        placeholder="e.g. PL0WMaa8s_mXGb3089AMtiyvordHKAZKi9"
                        className="w-full bg-white border border-[#141414]/10 rounded-xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all"
                      />
                    </div>
                    <button
                      onClick={loadPlaylistVideos}
                      disabled={isLoading || !apiKey || !playlistId}
                      className="bg-[#141414] text-white rounded-xl px-4 py-3 hover:bg-[#141414]/90 transition-colors disabled:opacity-50"
                      title="Load Videos"
                    >
                      {isLoading ? <RefreshCw size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                    </button>
                  </div>
                </div>

                {/* Video Selection Dropdown */}
                {availableVideos.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold opacity-70">Select Video to Preview</label>
                    <select
                      value={selectedVideoId}
                      onChange={(e) => setSelectedVideoId(e.target.value)}
                      className="w-full bg-white border border-[#141414]/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all appearance-none cursor-pointer"
                    >
                      {availableVideos.map(v => (
                        <option key={v.guid} value={v.guid}>{v.title}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Model Selection */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold opacity-70">Gemini Model</label>
                  <div className="flex gap-2">
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="flex-1 bg-white border border-[#141414]/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all appearance-none cursor-pointer"
                    >
                      {MODELS.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => copyToClipboard(selectedModel, 'model')}
                      className="bg-[#141414] text-white rounded-xl px-4 py-3 hover:bg-[#141414]/90 transition-colors flex items-center justify-center min-w-[48px]"
                      title="Copy Model ID"
                    >
                      {copied === 'model' ? <Check size={18} className="text-emerald-400" /> : <Copy size={18} />}
                    </button>
                  </div>
                </div>

                {/* System Prompt */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold opacity-70">System Prompt</label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={6}
                    placeholder="Instructions for Gemini..."
                    className="w-full bg-white border border-[#141414]/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all resize-none"
                  />
                  <p className="text-[10px] opacity-40 italic">Placeholders: {'{Title}'}, {'{Description}'}, {'{Published}'}, {'{Link}'}, {'{EpisodeNumber}'}</p>
                </div>

                {/* Advanced Settings Toggle */}
                <div className="pt-4 border-t border-[#141414]/5">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center justify-between w-full text-[10px] font-bold uppercase tracking-widest opacity-50 hover:opacity-100 transition-opacity"
                  >
                    Advanced Settings (Devvit Sync)
                    {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>

                  <AnimatePresence>
                    {showAdvanced && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden space-y-4 pt-4"
                      >
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest opacity-50">Video Link Label</label>
                          <input
                            type="text"
                            value={videoLinkLabel}
                            onChange={(e) => setVideoLinkLabel(e.target.value)}
                            className="w-full bg-white border border-[#141414]/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all"
                          />
                          <p className="text-[10px] opacity-40 italic">Placeholders: {'{Title}'}, {'{EpisodeNumber}'}</p>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest opacity-50">Prepend Text</label>
                          <textarea
                            value={prependText}
                            onChange={(e) => setPrependText(e.target.value)}
                            rows={2}
                            className="w-full bg-white border border-[#141414]/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all resize-none"
                          />
                          <p className="text-[10px] opacity-40 italic">Placeholders: {'{Title}'}, {'{Published}'}, {'{Link}'}, {'{EpisodeNumber}'}</p>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest opacity-50">Append Text</label>
                          <textarea
                            value={appendText}
                            onChange={(e) => setAppendText(e.target.value)}
                            rows={2}
                            className="w-full bg-white border border-[#141414]/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/5 transition-all resize-none"
                          />
                          <p className="text-[10px] opacity-40 italic">Placeholders: {'{Title}'}, {'{Published}'}, {'{Link}'}, {'{EpisodeNumber}'}</p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <button
                  onClick={generatePreview}
                  disabled={isGenerating || !selectedVideoId}
                  className="w-full bg-[#141414] text-white rounded-xl py-4 font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#141414]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isGenerating ? (
                    <RefreshCw size={18} className="animate-spin" />
                  ) : (
                    <Sparkles size={18} />
                  )}
                  {isGenerating ? 'Generating...' : 'Generate Preview'}
                </button>

                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl flex items-start gap-3"
                  >
                    <AlertCircle size={18} className="shrink-0 mt-0.5" />
                    <p className="text-xs font-medium leading-relaxed">{error}</p>
                  </motion.div>
                )}
              </div>
            </section>
          </div>

          {/* Right Column: Preview */}
          <div className="lg:col-span-7 space-y-8">
            <div className="flex items-center gap-2 opacity-50">
              <Eye size={16} />
              <h2 className="text-xs font-bold uppercase tracking-widest">Preview Output</h2>
            </div>

            <AnimatePresence mode="wait">
              {!fetchedVideo && !isGenerating && (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="h-[600px] border-2 border-dashed border-[#141414]/5 rounded-3xl flex flex-col items-center justify-center text-center p-12 space-y-4"
                >
                  <div className="w-16 h-16 bg-[#141414]/5 rounded-full flex items-center justify-center text-[#141414]/20">
                    <Play size={32} />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-bold">No Preview Generated</h3>
                    <p className="text-sm opacity-40 max-w-xs">Load videos from your playlist, select one, and click "Generate Preview".</p>
                  </div>
                </motion.div>
              )}

              {isGenerating && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="h-[600px] bg-white border border-[#141414]/5 rounded-3xl flex flex-col items-center justify-center text-center p-12 space-y-6"
                >
                  <div className="relative">
                    <div className="w-20 h-20 border-4 border-[#141414]/5 border-t-[#141414] rounded-full animate-spin" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Sparkles size={24} className="text-[#141414]" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold text-xl">Generating Post...</h3>
                    <p className="text-sm opacity-40">Consulting Gemini for the selected video.</p>
                  </div>
                </motion.div>
              )}

              {fetchedVideo && !isGenerating && (
                <motion.div
                  key="results"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-8"
                >
                  {/* Fetched Video Card */}
                  <div className="bg-white border border-[#141414]/5 rounded-3xl p-8 space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-emerald-600">
                        <Check size={16} />
                        <span className="text-[10px] font-bold uppercase tracking-widest">Video Selected</span>
                      </div>
                      <span className="text-[10px] opacity-40 font-mono">{new Date(fetchedVideo.pubDate).toLocaleDateString()}</span>
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-2xl font-bold leading-tight">{fetchedVideo.title}</h3>
                      <a
                        href={fetchedVideo.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                      >
                        {fetchedVideo.link} <ExternalLink size={10} />
                      </a>
                    </div>

                    <div className="bg-[#F5F5F0] rounded-xl p-4">
                      <p className="text-xs opacity-60 line-clamp-3 leading-relaxed">
                        {fetchedVideo.description}
                      </p>
                    </div>
                  </div>

                  {/* Generated Post Card */}
                  {generatedPost && (
                    <div className="bg-[#141414] text-white rounded-3xl p-8 space-y-8 shadow-2xl shadow-[#141414]/20">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-emerald-400">
                          <Sparkles size={16} />
                          <span className="text-[10px] font-bold uppercase tracking-widest">Gemini Output</span>
                        </div>
                        <div className="flex items-center gap-2 bg-white/5 rounded-lg p-1">
                          <button
                            onClick={() => setPreviewMode('reddit')}
                            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md transition-all ${previewMode === 'reddit' ? 'bg-white text-[#141414]' : 'opacity-40 hover:opacity-100'}`}
                          >
                            Reddit View
                          </button>
                          <button
                            onClick={() => setPreviewMode('raw')}
                            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md transition-all ${previewMode === 'raw' ? 'bg-white text-[#141414]' : 'opacity-40 hover:opacity-100'}`}
                          >
                            Raw Markdown
                          </button>
                        </div>
                      </div>

                      {/* Title Preview */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 opacity-50">
                            <TypeIcon size={14} />
                            <span className="text-[10px] font-bold uppercase tracking-widest">Reddit Title</span>
                          </div>
                          <button
                            onClick={() => copyToClipboard(generatedPost.title, 'title')}
                            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                          >
                            {copied === 'title' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                          </button>
                        </div>
                        <div className="text-xl font-bold leading-tight bg-white/5 p-4 rounded-xl border border-white/10">
                          {generatedPost.title}
                        </div>
                      </div>

                      {/* Body Preview */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 opacity-50">
                            {previewMode === 'reddit' ? <Layout size={14} /> : <FileText size={14} />}
                            <span className="text-[10px] font-bold uppercase tracking-widest">
                              {previewMode === 'reddit' ? 'Reddit Post Body' : 'Reddit Body (Markdown)'}
                            </span>
                          </div>
                          <button
                            onClick={() => copyToClipboard(generatedPost.body, 'body')}
                            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                          >
                            {copied === 'body' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                          </button>
                        </div>

                        {previewMode === 'reddit' ? (
                          <div className="bg-white text-[#1c1c1c] p-6 rounded-xl border border-white/10 min-h-[200px]">
                            <div className="prose prose-sm max-w-none prose-slate">
                              <Markdown>{generatedPost.body}</Markdown>
                            </div>
                          </div>
                        ) : (
                          <div className="text-sm opacity-90 leading-relaxed bg-white/5 p-6 rounded-xl border border-white/10 font-mono whitespace-pre-wrap max-h-[400px] overflow-y-auto custom-scrollbar">
                            {generatedPost.body}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-[#141414]/5">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 opacity-40">
          <p className="text-[10px] font-medium uppercase tracking-widest">Built by HeyItsGilbert • 2026</p>
          <div className="flex items-center gap-8">
            <a href="https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit#readme" target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold uppercase tracking-widest hover:opacity-100 transition-opacity">Documentation</a>
            <a href="https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/blob/main/PRIVACY_POLICY.md" target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold uppercase tracking-widest hover:opacity-100 transition-opacity">Privacy</a>
            <a href="https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues" target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold uppercase tracking-widest hover:opacity-100 transition-opacity">Support</a>
          </div>
        </div>
      </footer>

      <style dangerouslySetInnerHTML={{
        __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}} />
    </div>
  );
}
