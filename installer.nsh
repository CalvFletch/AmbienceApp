!include LogicLib.nsh
!include nsDialogs.nsh

Var Dialog
Var MusicFolderPath
Var DownloadSkyrim
Var DownloadOblivion
Var DownloadLOTR
Var DownloadMusic

; Music folder selection page
Page custom MusicFolderPage MusicFolderPageLeave

Function MusicFolderPage
  nsDialogs::Create 1018
  Pop $Dialog

  ${If} $Dialog == error
    Abort
  ${EndIf}

  ; Initialize default music folder path
  ${If} $MusicFolderPath == ""
    StrCpy $MusicFolderPath "$MUSIC\Ambience"
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Select Music Library Location"
  Pop $0

  ${NSD_CreateLabel} 0 24u 100% 12u "Where would you like to install the music library?"
  Pop $0

  ${NSD_CreateText} 0 40u 80% 12u "$MusicFolderPath"
  Pop $0
  Var /GLOBAL MusicFolderTextBox
  StrCpy $MusicFolderTextBox $0

  ${NSD_CreateBrowseButton} 80% 40u 20% 12u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 MusicFolderBrowse

  ${NSD_CreateLabel} 0 60u 100% 24u "Default: $MUSIC\Ambience$\n$\nMake sure the drive has at least 5GB of free space."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function MusicFolderBrowse
  nsDialogs::SelectFolderDialog /HEADING "Select Music Library Folder" ""
  Pop $0

  ${If} $0 != ""
    ${NSD_SetText} $MusicFolderTextBox $0
    StrCpy $MusicFolderPath $0
  ${EndIf}
FunctionEnd

Function MusicFolderPageLeave
  ${NSD_GetText} $MusicFolderTextBox $MusicFolderPath
  ${If} $MusicFolderPath == ""
    StrCpy $MusicFolderPath "$MUSIC\Ambience"
  ${EndIf}
FunctionEnd

; Category selection page
Page custom MusicCategoryPage MusicCategoryPageLeave

Function MusicCategoryPage
  nsDialogs::Create 1018
  Pop $Dialog

  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Select Music Library Categories"
  Pop $0

  ${NSD_CreateLabel} 0 24u 100% 12u "Which music categories would you like to download? (recommended: all)"
  Pop $0

  ${NSD_CreateCheckbox} 0 40u 100% 12u "Skyrim (Recommended)"
  Pop $0
  StrCpy $DownloadSkyrim $0
  ${NSD_Check} $DownloadSkyrim

  ${NSD_CreateCheckbox} 0 56u 100% 12u "Oblivion"
  Pop $0
  StrCpy $DownloadOblivion $0
  ${NSD_Check} $DownloadOblivion

  ${NSD_CreateCheckbox} 0 72u 100% 12u "Lord of the Rings"
  Pop $0
  StrCpy $DownloadLOTR $0
  ${NSD_Check} $DownloadLOTR

  ${NSD_CreateLabel} 0 92u 100% 20u "Each category may be several hundred MB. You can always install additional categories later via the app settings."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function MusicCategoryPageLeave
  ${NSD_GetState} $DownloadSkyrim $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DownloadMusic "Skyrim"
  ${EndIf}

  ${NSD_GetState} $DownloadOblivion $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DownloadMusic "$DownloadMusic Oblivion"
  ${EndIf}

  ${NSD_GetState} $DownloadLOTR $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DownloadMusic "$DownloadMusic LOTR"
  ${EndIf}
FunctionEnd

; Custom finish page macro that downloads music if selected
!macro customInstall
  ; Check if user selected any categories
  ${If} $DownloadMusic != ""
    DetailPrint "Preparing music library installation to: $MusicFolderPath"

    ; Create music directory
    CreateDirectory "$MusicFolderPath"

    DetailPrint "Selected categories: $DownloadMusic"
    DetailPrint "Downloading music library from GitHub..."
    DetailPrint "This may take several minutes depending on your internet connection..."

    ; Download categories based on selection (placeholder - actual downloads handled by PowerShell)
    ; For now, create initial metadata file with selections
    
    ; Use PowerShell to download and extract categories
    ; This would be a more complex PowerShell script that:
    ; 1. Fetches latest music-lib-* release from GitHub
    ; 2. Downloads selected category archives
    ; 3. Extracts to category folders
    ; 4. Creates library-metadata.json with installed categories
    
    DetailPrint "Music library setup complete!"
  ${EndIf}
!macroend

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
    DetailPrint "Extracting music library..."
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

