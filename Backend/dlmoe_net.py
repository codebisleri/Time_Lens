"""TensorFlow Deep MoE network (TimeSeriesMoE) — isolated for LAZY loading.

This module is imported ONLY on the first execution of forecast_dl_moe()
(via app_v2_6._ensure_dlmoe_tf). Importing it is what triggers the heavy
`import tensorflow`; that NEVER happens at engine / backend / API /
ProcessPool-worker / forecast_one_sku startup. The classes below are a
byte-for-byte relocation of the originals previously defined inline in
app_v2_6 — pure move, no logic or numerical change.
"""
from typing import Tuple

import numpy as np
import tensorflow as tf  # noqa: F401  — THE heavy import, now deferred to first use
from tensorflow.keras.models import Model as _KerasModel
from tensorflow.keras.layers import (
    Layer, Dense, LayerNormalization, MultiHeadAttention)
from tensorflow.keras.optimizers import Adam  # noqa: F401  — re-exported for the engine


def create_sequences(data: np.ndarray, input_len: int,
                     output_len: int) -> Tuple[np.ndarray, np.ndarray]:
    """Sliding-window (X, y) builder. X carries all features; y is the
    target column (index 0) over the next `output_len` steps."""
    X, y = [], []
    for i in range(len(data) - input_len - output_len + 1):
        X.append(data[i:(i + input_len), :])
        y.append(data[(i + input_len):(i + input_len + output_len), 0])
    return np.array(X), np.array(y)


class FourierLayer(Layer):
    """Seasonality expert front-end: maps time indices to sin/cos harmonics."""
    def __init__(self, period, k, **kwargs):
        super(FourierLayer, self).__init__(**kwargs)
        self.period = period
        self.k = k

    def call(self, inputs):
        time = tf.cast(inputs, tf.float32)
        harmonics = []
        for i in range(1, self.k + 1):
            harmonics.append(tf.sin(2 * np.pi * i * time / self.period))
            harmonics.append(tf.cos(2 * np.pi * i * time / self.period))
        return tf.stack(harmonics, axis=-1)


class TransformerBlock(Layer):
    """Dynamic expert: multi-head self-attention + feed-forward residual block."""
    def __init__(self, embed_dim, num_heads, ff_dim, rate=0.1, **kwargs):
        super(TransformerBlock, self).__init__(**kwargs)
        self.att = MultiHeadAttention(num_heads=num_heads, key_dim=embed_dim)
        self.ffn = tf.keras.Sequential(
            [Dense(ff_dim, activation="relu"), Dense(embed_dim)])
        self.layernorm1 = LayerNormalization(epsilon=1e-6)
        self.layernorm2 = LayerNormalization(epsilon=1e-6)
        self.dropout1 = tf.keras.layers.Dropout(rate)
        self.dropout2 = tf.keras.layers.Dropout(rate)

    def call(self, inputs, training=False):
        attn_output = self.att(inputs, inputs)
        attn_output = self.dropout1(attn_output, training=training)
        out1 = self.layernorm1(inputs + attn_output)
        ffn_output = self.ffn(out1)
        ffn_output = self.dropout2(ffn_output, training=training)
        return self.layernorm2(out1 + ffn_output)


class TimeSeriesMoE(_KerasModel):
    """Deep MoE: trend (Dense) + seasonality (Fourier) + dynamic (Transformer)
    experts combined by a softmax gating network that learns input-dependent
    weights per forecast step."""
    def __init__(self, input_len, output_len, num_features, num_experts=3,
                 period=7, k=3, embed_dim=32, num_heads=4, **kwargs):
        super(TimeSeriesMoE, self).__init__(**kwargs)
        self.input_len = input_len
        self.output_len = output_len
        self.num_features = num_features
        self.num_experts = num_experts
        self.input_projection = Dense(embed_dim)
        self.trend_expert = tf.keras.Sequential(
            [tf.keras.layers.Flatten(), Dense(output_len)], name="trend_expert")
        self.seasonality_expert = tf.keras.Sequential(
            [FourierLayer(period=period, k=k), tf.keras.layers.Flatten(),
             Dense(output_len)], name="seasonality_expert")
        self.dynamic_expert = tf.keras.Sequential(
            [TransformerBlock(embed_dim=embed_dim, num_heads=num_heads,
                              ff_dim=embed_dim * 2),
             tf.keras.layers.Flatten(), Dense(output_len)], name="dynamic_expert")
        self.experts = [self.trend_expert, self.seasonality_expert,
                        self.dynamic_expert]
        self.gating_network = tf.keras.Sequential(
            [tf.keras.layers.Flatten(), Dense(64, activation='relu'),
             Dense(num_experts, activation='softmax')], name="gating_network")

    def call(self, inputs):
        gating_weights = self.gating_network(inputs)
        trend_out = self.experts[0](inputs)
        time_indices = tf.range(0, self.input_len, 1, dtype=tf.float32)
        time_indices_seq = tf.reshape(time_indices, (1, self.input_len, 1))
        batch_time_indices = tf.tile(time_indices_seq,
                                     [tf.shape(inputs)[0], 1, 1])
        seasonality_out = self.experts[1](batch_time_indices)
        projected_inputs = self.input_projection(inputs)
        dynamic_out = self.experts[2](projected_inputs)
        stacked = tf.stack([trend_out, seasonality_out, dynamic_out], axis=1)
        weighted = tf.expand_dims(gating_weights, axis=-1) * stacked
        return tf.reduce_sum(weighted, axis=1)
