# Local Project Storage Specification

## Purpose

Keeps project history and generated videos available on the user's browser while ensuring that source audio is not retained, uploaded, or silently copied to a remote service.

## Requirements

### Requirement: Persist project history locally

The system SHALL save each project configuration and its render history in browser-local storage, including template, text and image settings, aspect ratio, resolution, frame rate, timestamps, and render status.

#### Scenario: Completed project is reopened

- **WHEN** the user returns to the application in the same browser and opens a saved project
- **THEN** the system displays its configuration and completed output status without requiring the project to be recreated

#### Scenario: Project is still rendering when the page closes

- **WHEN** the page is closed or reloaded while a render is running
- **THEN** the project records that the render was interrupted or unknown and does not claim that an incomplete output is downloadable

### Requirement: Retain generated MP4 locally

The system SHALL retain a successfully generated MP4 in browser-local storage so the user can preview or download it again without re-rendering, subject to available browser storage.

#### Scenario: User downloads a saved output later

- **WHEN** a saved project has a locally retained completed MP4
- **THEN** the system allows the user to preview or download that MP4

#### Scenario: Local output is unavailable

- **WHEN** the generated MP4 has been removed by the user, browser eviction, or unavailable storage
- **THEN** the system shows the project metadata and indicates that the output must be rendered again

### Requirement: Never persist source audio

The system SHALL keep a selected source-audio `File` only in the active browser
workspace, decode it for rendering without persistence, and SHALL NOT store it
in project records or upload it to the FastAPI service in the MVP.

#### Scenario: Render session ends

- **WHEN** a render completes, fails, or is cancelled
- **THEN** the system releases the audio used by that render and does not include it in the saved project record; a newer audio selection made during the render remains available

#### Scenario: Project is reopened without its source audio

- **WHEN** the user opens a saved project and requests a new render
- **THEN** the system asks for a new source audio selection before allowing the render to start

### Requirement: Provide local data controls

The system SHALL allow the user to delete a project, delete its generated MP4 while retaining its configuration, and inspect an approximate local storage usage or quota error when a save cannot be completed.

#### Scenario: User deletes a project

- **WHEN** the user confirms deletion of a project
- **THEN** the system removes its metadata and locally retained MP4 and excludes it from the project list

#### Scenario: User deletes only the generated output

- **WHEN** the user deletes a project's generated MP4
- **THEN** the system retains the project configuration and marks the output unavailable for download

#### Scenario: Completed MP4 Blob exceeds browser storage quota

- **WHEN** completed render metadata is recorded but saving its MP4 Blob exceeds the browser's available local storage
- **THEN** the system keeps the completed MP4 available in memory for immediate preview and download and marks it as not saved after reload

#### Scenario: User leaves a project with an unsaved in-memory output

- **WHEN** the user opens another project, starts a new project, deletes the project, or replaces its quota-rejected output
- **THEN** the system releases the volatile MP4 and its object URL so large outputs do not accumulate in memory
