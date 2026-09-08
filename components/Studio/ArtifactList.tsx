"use client";

import { formatBytes, formatDuration } from "./format";
import type { StudioArtifact } from "./types";

const KIND_WORDS: Record<StudioArtifact["kind"], string> = {
	recording: "Recording",
	project: "Cap project",
	storyboard: "Storyboard",
	export: "Exported video",
};

interface ArtifactListProps {
	artifacts: StudioArtifact[];
}

export function ArtifactList({ artifacts }: ArtifactListProps) {
	return (
		<section
			aria-labelledby="studio-artifacts-heading"
			className="rounded-xl border border-neutral-700 bg-neutral-900 p-4"
		>
			<h2 id="studio-artifacts-heading" className="text-sm font-semibold text-neutral-200">
				Artifacts
			</h2>

			{artifacts.length === 0 ? (
				<p className="mt-2 text-xs text-neutral-400">
					Nothing produced yet. The recording, storyboard and export appear here.
				</p>
			) : (
				<ul className="mt-3 space-y-2">
					{artifacts.map((artifact) => (
						<li key={artifact.id} className="rounded-lg bg-neutral-950 p-3">
							<p className="text-sm font-medium text-neutral-100">
								<span className="mr-2 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
									{KIND_WORDS[artifact.kind]}
								</span>
								{artifact.label}
							</p>
							<p className="mt-1 break-all font-mono text-xs text-neutral-400">{artifact.path}</p>
							<p className="mt-1 text-xs text-neutral-400">
								{artifact.durationMs != null && (
									<span className="mr-3">{formatDuration(artifact.durationMs)}</span>
								)}
								{artifact.fps != null && <span className="mr-3">{artifact.fps.toFixed(1)} fps</span>}
								{artifact.bytes != null && <span>{formatBytes(artifact.bytes)}</span>}
							</p>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
