import React from "react";
import { createRoot } from "react-dom/client";

import { Library } from "./Library";
import { Recorder } from "./Recorder";
import { RecordingControls } from "./RecordingControls";
import { ProjectStudio } from "./projects/ProjectStudio";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const route = window.location.hash.replace("#", "");
const isLibrary = route === "library";
const isRecordingControls = route === "recording-controls";
const isProjects = route === "projects";
document.body.dataset.route = isLibrary
  ? "library"
  : isRecordingControls
    ? "recording-controls"
    : isProjects
      ? "projects"
      : "recorder";

createRoot(root).render(
  <React.StrictMode>
    {isLibrary ? (
      <Library />
    ) : isRecordingControls ? (
      <RecordingControls />
    ) : isProjects ? (
      <ProjectStudio />
    ) : (
      <Recorder />
    )}
  </React.StrictMode>,
);
