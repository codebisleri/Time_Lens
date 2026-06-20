# ============================================================================
# DhishaAI Time Lens v2 — Dockerfile for Production Deployment
# ============================================================================
# Build & run as:
#   docker build -t timelens:latest .
#   docker run -p 8501:8501 -v $(pwd)/data:/app/data timelens:latest
#
# For production with Nginx proxy:
#   docker run -d -p 8501:8501 --name timelens \
#     -v $(pwd)/data:/app/data \
#     -v $(pwd)/models:/app/models \
#     -e NUM_WORKERS=8 \
#     timelens:latest
#
# Push to registry:
#   docker tag timelens:latest dhishai/timelens:latest
#   docker push dhishai/timelens:latest
# ============================================================================

FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies (minimal footprint)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app_v2_6.py .
COPY temporal_features.py .
COPY *.csv ./
COPY *.html ./

# Create necessary directories
RUN mkdir -p data models logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import sys; sys.exit(0)" || exit 1

# Expose Streamlit port
EXPOSE 8501

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV STREAMLIT_SERVER_HEADLESS=true
ENV STREAMLIT_SERVER_ENABLEXSRFPROTECTION=false
ENV STREAMLIT_LOGGER_LEVEL=info

# Run Streamlit
CMD ["streamlit", "run", "app_v2_6.py", "--server.port=8501", "--server.address=0.0.0.0"]
