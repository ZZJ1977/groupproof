FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Celery 拒绝以 root 运行，worker 使用普通用户启动
RUN useradd --system --uid 1001 --no-create-home celery
USER celery

CMD ["python", "-m", "app"]
