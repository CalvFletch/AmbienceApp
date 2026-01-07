; Custom installer script - music folder selection
!include LogicLib.nsh
!include nsDialogs.nsh

Var MusicFolderDialog
Var MusicFolderLabel
Var MusicFolderText
Var MusicFolderBrowse
Var MusicFolderPath

; Music folder selection page
Page custom MusicFolderPage MusicFolderPageLeave

Function MusicFolderPage
  nsDialogs::Create 1018
  Pop $MusicFolderDialog
  ${If} $MusicFolderDialog == error
    Abort
  ${EndIf}

  ; Set default path
  StrCpy $MusicFolderPath "$MUSIC\Ambience"

  ${NSD_CreateLabel} 0 0 100% 24u "Select where to store your music library:"
  Pop $MusicFolderLabel

  ${NSD_CreateText} 0 30u 75% 12u $MusicFolderPath
  Pop $MusicFolderText

  ${NSD_CreateButton} 77% 29u 23% 14u "Browse..."
  Pop $MusicFolderBrowse
  ${NSD_OnClick} $MusicFolderBrowse MusicFolderBrowseClick

  nsDialogs::Show
FunctionEnd

Function MusicFolderBrowseClick
  nsDialogs::SelectFolderDialog "Select Music Folder" $MusicFolderPath
  Pop $0
  ${If} $0 != error
    StrCpy $MusicFolderPath $0
    ${NSD_SetText} $MusicFolderText $MusicFolderPath
  ${EndIf}
FunctionEnd

Function MusicFolderPageLeave
  ${NSD_GetText} $MusicFolderText $MusicFolderPath
FunctionEnd

; Write config after install
!macro customInstall
  ; Create music folder if it doesn't exist
  CreateDirectory $MusicFolderPath

  ; Write config.json to app data
  SetShellVarContext current
  CreateDirectory "$APPDATA\${APP_FILENAME}"
  FileOpen $0 "$APPDATA\${APP_FILENAME}\config.json" w
  FileWrite $0 '{"musicFolder":"$MusicFolderPath"}'
  FileClose $0

  DetailPrint "Music folder set to: $MusicFolderPath"
!macroend

