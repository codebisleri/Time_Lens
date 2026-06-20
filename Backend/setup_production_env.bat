@echo off
REM ============================================================================
REM DhishaAI Time Lens v2 — Production Environment Setup (Windows)
REM ============================================================================
REM Setup script to create an isolated Python virtual environment for 
REM production deployment on Windows systems.
REM
REM Usage:
REM   setup_production_env.bat
REM
REM This script will:
REM   1. Check Python version (3.10+)
REM   2. Create a virtual environment: venv_timelens\
REM   3. Install all dependencies from requirements.txt
REM   4. Create .env template file
REM   5. Create activation helper scripts
REM ============================================================================

setlocal enabledelayedexpansion

cls
echo ============================================================================
echo    DhishaAI Time Lens v2 - Production Environment Setup (Windows)
echo ============================================================================
echo.

REM Check Python
echo Checking system requirements...
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.10 or later.
    pause
    exit /b 1
)

for /f \"tokens=2\" %%i in ('python --version 2^>^&1') do set PYTHON_VERSION=%%i
echo Python version: %PYTHON_VERSION%

REM Create virtual environment
set VENV_DIR=venv_timelens

if exist %VENV_DIR% (
    echo.
    echo Virtual environment already exists at: %VENV_DIR%
    set /p RECREATE=\"Do you want to recreate it? (y/n) \"
    if /i \"%RECREATE%\"==\"y\" (
        echo Removing existing environment...
        rmdir /s /q %VENV_DIR%
    ) else (
        echo Skipping environment creation.
        goto skip_venv
    )
)

echo.
echo Creating virtual environment...
python -m venv %VENV_DIR%
echo Virtual environment created: %VENV_DIR%

:skip_venv
echo.
echo Activating virtual environment...
call %VENV_DIR%\Scripts\activate.bat

echo.
echo Upgrading pip, setuptools, and wheel...
python -m pip install --upgrade pip setuptools wheel

echo.
echo Installing dependencies from requirements.txt...
echo This may take 5-10 minutes...
echo.
pip install -r requirements.txt

if errorlevel 1 (
    echo.
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo Creating helper scripts...

REM Create activate helper
(
    echo @echo off
    echo call venv_timelens\Scripts\activate.bat
    echo echo Virtual environment activated for Time Lens
    echo echo To run the app: streamlit run app_v2_6.py
) > activate_env.bat
echo Created: activate_env.bat

REM Create run script
(
    echo @echo off
    echo call venv_timelens\Scripts\activate.bat
    echo streamlit run app_v2_6.py
) > run_production.bat
echo Created: run_production.bat

REM Create .env template
(
    echo # DhishaAI Time Lens v2 - Environment Configuration
    echo # Copy to .env and update as needed
    echo.
    echo # Data paths
    echo DATA_PATH=./data
    echo MODEL_PATH=./models
    echo LOGS_PATH=./logs
    echo.
    echo # Performance settings
    echo NUM_WORKERS=4
    echo BATCH_SIZE=1000
    echo.
    echo # Streamlit settings
    echo STREAMLIT_SERVER_PORT=8501
    echo STREAMLIT_LOGGER_LEVEL=info
) > .env.example
echo Created: .env.example

echo.
echo ============================================================================
echo SETUP COMPLETE!
echo ============================================================================
echo.
echo Your production environment is ready!
echo.
echo Next steps:
echo   1. Activate environment: activate_env.bat
echo   2. Run the app: streamlit run app_v2_6.py
echo   3. Open browser: http://localhost:8501
echo.
echo Environment: %PYTHON_VERSION%
echo Location: %VENV_DIR%
echo Status: READY FOR PRODUCTION
echo.
pause
