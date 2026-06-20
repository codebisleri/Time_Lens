#!/bin/bash

################################################################################
# DhishaAI Time Lens v2 — Production Environment Setup
# ============================================================================
# Setup script to create an isolated Python virtual environment for 
# production deployment or easy installation on other systems/servers.
#
# Usage:
#   chmod +x setup_production_env.sh
#   ./setup_production_env.sh
#
# This script will:
#   1. Check Python version (3.10+)
#   2. Create a virtual environment: ./venv_timelens/
#   3. Upgrade pip, setuptools, wheel
#   4. Install all dependencies from requirements.txt
#   5. Create a .env template file
#   6. Create activation helper scripts
#
# For deployment to another server:
#   - Copy entire project folder + venv_timelens/
#   - Run: ./run_production.sh
################################################################################

set -e  # Exit on first error

echo \"════════════════════════════════════════════════════════════════════════════════\"
echo \"   DhishaAI Time Lens v2 — Production Environment Setup\"
echo \"════════════════════════════════════════════════════════════════════════════════\"

# Configuration
VENV_DIR=\"./venv_timelens\"
PYTHON_MIN_VERSION=\"3.10\"
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
PROJECT_NAME=\"timelens\"

echo \"\"
echo \"📋 Step 1/6: Checking system requirements...\"
echo \"─────────────────────────────────────────────────────────────────────────────\"

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo \"❌ Python 3 not found. Please install Python 3.10 or later.\"
    exit 1
fi

PYTHON_VERSION=\$(python3 --version | awk '{print \$2}')
echo \"✓ Python version: \$PYTHON_VERSION\"

# Check if version is 3.10 or later
MAJOR_VERSION=\$(echo \$PYTHON_VERSION | cut -d. -f1)
MINOR_VERSION=\$(echo \$PYTHON_VERSION | cut -d. -f2)
if [ \"\$MAJOR_VERSION\" -lt 3 ] || ([ \"\$MAJOR_VERSION\" -eq 3 ] && [ \"\$MINOR_VERSION\" -lt 10 ]); then
    echo \"❌ Python 3.10+ required. Found: \$PYTHON_VERSION\"
    exit 1
fi

# Check for pip
if ! command -v pip3 &> /dev/null; then
    echo \"❌ pip3 not found. Please install pip.\"
    exit 1
fi
echo \"✓ pip3 found\"

echo \"\"
echo \"📦 Step 2/6: Creating virtual environment...\"
echo \"─────────────────────────────────────────────────────────────────────────────\"

if [ -d \"\$VENV_DIR\" ]; then
    echo \"⚠️  Virtual environment already exists at: \$VENV_DIR\"
    read -p \"Do you want to recreate it? (y/n) \" -n 1 -r
    echo
    if [[ \$REPLY =~ ^[Yy]\$ ]]; then
        echo \"Removing existing environment...\"
        rm -rf \"\$VENV_DIR\"
    else
        echo \"Skipping environment creation.\"
    fi
fi

if [ ! -d \"\$VENV_DIR\" ]; then
    python3 -m venv \"\$VENV_DIR\"
    echo \"✓ Virtual environment created at: \$VENV_DIR\"
else
    echo \"✓ Using existing virtual environment: \$VENV_DIR\"
fi

echo \"\"
echo \"🔧 Step 3/6: Activating virtual environment...\"
echo \"─────────────────────────────────────────────────────────────────────────────\"

source \"\$VENV_DIR/bin/activate\"
echo \"✓ Virtual environment activated\"

echo \"\"
echo \"⬆️  Step 4/6: Upgrading pip, setuptools, and wheel...\"
echo \"─────────────────────────────────────────────────────────────────────────────\"

pip3 install --upgrade pip setuptools wheel
echo \"✓ pip, setuptools, and wheel upgraded\"

echo \"\"
echo \"📥 Step 5/6: Installing dependencies from requirements.txt...\"
echo \"─────────────────────────────────────────────────────────────────────────────\"
echo \"This may take 5-10 minutes (packages: statsmodels, sklearn, lightgbm, prophet, etc.)\"
echo \"\"

if [ -f \"requirements.txt\" ]; then
    pip3 install -r requirements.txt
    echo \"✓ All dependencies installed successfully\"
else
    echo \"❌ requirements.txt not found in: \$PWD\"
    echo \"Please ensure requirements.txt is in the project directory.\"
    exit 1
fi

echo \"\"
echo \"📝 Step 6/6: Creating helper scripts...\"
echo \"─────────────────────────────────────────────────────────────────────────────\"

# Create activation helper
cat > \"activate_env.sh\" << 'EOF'
#!/bin/bash
# Quick activation script
source \"./venv_timelens/bin/activate\"
echo \"✓ Time Lens environment activated\"
echo \"To run the app: streamlit run app_v2_6.py\"
EOF
chmod +x \"activate_env.sh\"
echo \"✓ Created: activate_env.sh\"

# Create run script for production
cat > \"run_production.sh\" << 'EOF'
#!/bin/bash
# Run Time Lens in production
source \"./venv_timelens/bin/activate\"
streamlit run app_v2_6.py
EOF
chmod +x \"run_production.sh\"
echo \"✓ Created: run_production.sh\"

# Create .env template
cat > \".env.example\" << 'EOF'
# DhishaAI Time Lens v2 — Environment Configuration
# Copy to .env and update as needed

# Data paths
DATA_PATH=./data
MODEL_PATH=./models
LOGS_PATH=./logs

# Database (optional)
# DATABASE_URL=sqlite:///timelens.db

# Performance settings
NUM_WORKERS=4
BATCH_SIZE=1000

# Streamlit settings
STREAMLIT_SERVER_HEADLESS=true
STREAMLIT_SERVER_PORT=8501
STREAMLIT_LOGGER_LEVEL=info
EOF
echo \"✓ Created: .env.example\"

# Create deployment guide
cat > \"DEPLOYMENT.md\" << 'EOF'
# 🚀 Production Deployment Guide — Time Lens v2

## Local Deployment (Development Machine)

### Option 1: Quick Start (Recommended)
\`\`\`bash
./setup_production_env.sh
source activate_env.sh
streamlit run app_v2_6.py
\`\`\`

### Option 2: Manual Setup
\`\`\`bash
python3 -m venv venv_timelens
source venv_timelens/bin/activate
pip install -r requirements.txt
streamlit run app_v2_6.py
\`\`\`

## Server Deployment (Linux/macOS)

### Step 1: SSH into Server
\`\`\`bash
ssh user@server_ip
cd /path/to/timelens
\`\`\`

### Step 2: Clone/Copy Project
\`\`\`bash
# Option A: Copy entire folder with venv
rsync -avz --exclude '__pycache__' --exclude '.git' ~/timelens/ user@server:/srv/timelens/

# Option B: Fresh setup
cd /srv/timelens
./setup_production_env.sh
\`\`\`

### Step 3: Run with Systemd (Production)
Create: \`/etc/systemd/system/timelens.service\`
\`\`\`ini
[Unit]
Description=DhishaAI Time Lens v2 Forecasting Engine
After=network.target

[Service]
Type=simple
User=timelens
WorkingDirectory=/srv/timelens
ExecStart=/srv/timelens/venv_timelens/bin/streamlit run app_v2_6.py --server.port=8501
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
\`\`\`

Then:
\`\`\`bash
sudo systemctl daemon-reload
sudo systemctl start timelens
sudo systemctl enable timelens  # Auto-start on boot
\`\`\`

### Step 4: Configure Nginx (Optional, for Production)
\`\`\`nginx
server {
    listen 80;
    server_name forecast.dhishai.com;

    location / {
        proxy_pass http://localhost:8501;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
\`\`\`

## Docker Deployment (Recommended for Teams/Servers)

### Create Dockerfile
See: Dockerfile (included in project)

### Build & Run
\`\`\`bash
docker build -t timelens:latest .
docker run -p 8501:8501 -v $(pwd)/data:/app/data timelens:latest
\`\`\`

## Environment Variables

Copy .env.example to .env:
\`\`\`bash
cp .env.example .env
nano .env  # Edit as needed
\`\`\`

Key variables:
- **DATA_PATH**: Where CSV/data files are stored
- **MODEL_PATH**: Where models are saved
- **STREAMLIT_SERVER_PORT**: Port (default 8501)
- **NUM_WORKERS**: Parallel processing threads

## Troubleshooting

### \"ModuleNotFoundError: No module named 'temporal_features'\"
→ Ensure temporal_features.py is in the same directory as app_v2_6.py

### \"Streamlit runs but page is blank\"
→ Check logs: streamlit run app_v2_6.py --logger.level=debug

### \"Memory error on large dataset\"
→ Reduce NUM_WORKERS or increase server RAM

## Performance Tuning

For 10K+ SKUs, consider:
1. Increase NUM_WORKERS (match CPU cores)
2. Use Parquet format for faster I/O
3. Cache predictions in database
4. Consider distributed setup (Ray, Dask)

## Monitoring

Check service status:
\`\`\`bash
systemctl status timelens
journalctl -u timelens -f  # Live logs
\`\`\`

Visit: http://localhost:8501 (or http://server_ip:8501)

## Backup & Recovery

Daily backup of models:
\`\`\`bash
tar -czf models_backup_\$(date +%Y%m%d).tar.gz models/
\`\`\`

## Support

- Logs: \`./logs/timelens.log\`
- Docs: README_TEMPORAL_FEATURES.md, INTEGRATION_GUIDE.md
- Issues: Create an issue or contact DevOps team

---
**Last Updated**: 2026-05-23  
**Version**: Time Lens v2  
**Team**: DhishaAI Forecast Team
EOF
echo \"✓ Created: DEPLOYMENT.md\"

# Create requirements-dev.txt for development
cat > \"requirements-dev.txt\" << 'EOF'
# Development dependencies (extends requirements.txt)
# Usage: pip install -r requirements.txt -r requirements-dev.txt

# Testing
pytest==7.4.3
pytest-cov==4.1.0

# Code quality
black==23.11.0
flake8==6.1.0
pylint==3.0.3
mypy==1.7.0

# Debugging
ipython==8.18.1
jupyter==1.0.0
jupyterlab==4.0.9

# Documentation
sphinx==7.2.6
mkdocs==1.5.3

# Performance analysis
py-spy==0.3.14
scalene==1.5.42
EOF
echo \"✓ Created: requirements-dev.txt\"

echo \"\"
echo \"════════════════════════════════════════════════════════════════════════════════\"
echo \"✅ SETUP COMPLETE!\"
echo \"════════════════════════════════════════════════════════════════════════════════\"
echo \"\"
echo \"Your production environment is ready!\"
echo \"\"
echo \"📍 Environment location: \$VENV_DIR\"
echo \"📍 Python version: \$PYTHON_VERSION\"
echo \"📍 Packages installed: \$(pip list | wc -l)\"
echo \"\"
echo \"🚀 Next steps:\"
echo \"   1. Activate environment:  source activate_env.sh\"
echo \"   2. Run the app:           streamlit run app_v2_6.py\"
echo \"   3. Open browser:          http://localhost:8501\"
echo \"\"
echo \"📦 For deployment to another server:\"
echo \"   1. Copy this entire folder (including venv_timelens/)\"
echo \"   2. On new server:         ./run_production.sh\"
echo \"\"
echo \"📚 Documentation:\"
echo \"   - DEPLOYMENT.md  →  Server setup & production configs\"
echo \"   - .env.example   →  Environment variables template\"
echo \"   - requirements-dev.txt  →  Development tools\"
echo \"\"
echo \"════════════════════════════════════════════════════════════════════════════════\"
echo \"\"

# Final status
echo \"Environment: \$(python3 --version)\"
echo \"Location: \$VENV_DIR\"
echo \"Status: ✅ Ready for production\"
echo \"\"
