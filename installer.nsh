!include LogicLib.nsh
!include nsDialogs.nsh

Var Dialog
Var DownloadMusicCheckbox
Var DownloadMusic
Var MusicFolderPath

; Custom page for music download option
Page custom MusicDownloadPage MusicDownloadPageLeave

Function MusicDownloadPage
  nsDialogs::Create 1018
  Pop $Dialog

  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Ambience includes an optional 4.7GB Skyrim-themed music library.$\n$\nWould you like to download and install the music library?"
  Pop $0

  ${NSD_CreateCheckbox} 0 32u 100% 12u "Download and install music library (4.7GB) - Recommended"
  Pop $DownloadMusicCheckbox

  ; Check by default
  ${NSD_Check} $DownloadMusicCheckbox

  ${NSD_CreateLabel} 0 48u 100% 48u "The music library will be downloaded from GitHub and installed to:$\n$MUSIC\Ambience$\n$\nNote: This may take several minutes depending on your internet connection.$\nYou can always add your own music later by clicking the settings icon in the app."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function MusicDownloadPageLeave
  ${NSD_GetState} $DownloadMusicCheckbox $DownloadMusic
FunctionEnd

; Custom finish page macro that downloads music if selected
!macro customInstall
  ; Check if user wants to download music
  ${If} $DownloadMusic == ${BST_CHECKED}
    DetailPrint "Preparing to download music library..."

    ; Set music folder path
    StrCpy $MusicFolderPath "$MUSIC\Ambience"

    ; Create music directory
    CreateDirectory "$MusicFolderPath"

    DetailPrint "Downloading music library parts (4.7GB total)..."
    DetailPrint "This may take several minutes. Please wait..."

    ; Download all 3 parts
    inetc::get /CAPTION "Downloading Music Library (Part 1/3 - 2.0GB)" \
               /BANNER "Downloading Skyrim Music Library" \
               "https://github.com/CalvFletch/AmbienceApp/releases/download/v1.0.0/Ambience.part00" \
               "$TEMP\Ambience.part00" \
               /END
    Pop $0

    ${If} $0 != "OK"
      DetailPrint "Warning: Failed to download part 1. Music library will not be installed."
      DetailPrint "You can download it manually from the GitHub releases page."
      Goto SkipMusicInstall
    ${EndIf}

    inetc::get /CAPTION "Downloading Music Library (Part 2/3 - 2.0GB)" \
               /BANNER "Downloading Skyrim Music Library" \
               "https://github.com/CalvFletch/AmbienceApp/releases/download/v1.0.0/Ambience.part01" \
               "$TEMP\Ambience.part01" \
               /END
    Pop $0

    ${If} $0 != "OK"
      DetailPrint "Warning: Failed to download part 2. Music library will not be installed."
      Delete "$TEMP\Ambience.part00"
      Goto SkipMusicInstall
    ${EndIf}

    inetc::get /CAPTION "Downloading Music Library (Part 3/3 - 747MB)" \
               /BANNER "Downloading Skyrim Music Library" \
               "https://github.com/CalvFletch/AmbienceApp/releases/download/v1.0.0/Ambience.part02" \
               "$TEMP\Ambience.part02" \
               /END
    Pop $0

    ${If} $0 != "OK"
      DetailPrint "Warning: Failed to download part 3. Music library will not be installed."
      Delete "$TEMP\Ambience.part00"
      Delete "$TEMP\Ambience.part01"
      Goto SkipMusicInstall
    ${EndIf}

    DetailPrint "All parts downloaded successfully!"
    DetailPrint "Combining files... This may take a moment."

    ; Create a batch file to combine the parts quickly using binary copy
    FileOpen $0 "$TEMP\combine.bat" w
    FileWrite $0 '@echo off$\r$\n'
    FileWrite $0 'copy /b "$TEMP\Ambience.part00" + "$TEMP\Ambience.part01" + "$TEMP\Ambience.part02" "$TEMP\Ambience.zip"$\r$\n'
    FileWrite $0 'exit /b %ERRORLEVEL%$\r$\n'
    FileClose $0

    ; Execute the batch file
    nsExec::ExecToLog '"$TEMP\combine.bat"'
    Pop $0

    ; Clean up parts
    Delete "$TEMP\Ambience.part00"
    Delete "$TEMP\Ambience.part01"
    Delete "$TEMP\Ambience.part02"
    Delete "$TEMP\combine.bat"

    ${If} $0 != "0"
      DetailPrint "Warning: Failed to combine files."
      Goto SkipMusicInstall
    ${EndIf}

    DetailPrint "Files combined successfully!"
    DetailPrint "Extracting music library to $MusicFolderPath..."
    DetailPrint "This may take a few minutes..."

    ; Use PowerShell to extract the zip file (built into Windows 10+)
    nsExec::ExecToLog 'powershell -Command "Expand-Archive -Path \"$TEMP\Ambience.zip\" -DestinationPath \"$MusicFolderPath\" -Force"'
    Pop $0

    ${If} $0 == "0"
      DetailPrint "Music library installed successfully!"
    ${Else}
      DetailPrint "Warning: Failed to extract music library."
      DetailPrint "The zip file has been saved to: $TEMP\Ambience.zip"
      DetailPrint "You can extract it manually to: $MusicFolderPath"
      Goto SkipZipCleanup
    ${EndIf}

    ; Cleanup
    Delete "$TEMP\Ambience.zip"

    SkipZipCleanup:
    SkipMusicInstall:
  ${EndIf}
!macroend
